"""Direct Bria v2 image expansion as a Genblaze provider.

Bria's expand route is an asynchronous, paid operation.  This adapter keeps
the API token and inline source bytes outside the Genblaze ``Step`` so neither
can enter a manifest, and it separates the one unsafe-to-repeat POST from the
safe-to-retry status and download requests.
"""

from __future__ import annotations

import base64
import hashlib
import io
import os
import re
import threading
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

import httpx
from PIL import Image, UnidentifiedImageError

from genblaze_core.exceptions import ProviderError
from genblaze_core.models import Asset, Modality, StepType
from genblaze_core.models.enums import ProviderErrorCode
from genblaze_core.models.step import Step
from genblaze_core.providers.base import (
    BaseProvider,
    ProviderCapabilities,
    validate_chain_input_url,
)
from genblaze_core.providers.retry import RetryPolicy
from genblaze_core.runnable.config import RunnableConfig


BRIA_EXPAND_URL = "https://engine.prod.bria-api.com/v2/image/edit/expand"
BRIA_STATUS_ORIGIN = "https://engine.prod.bria-api.com"
MAX_CANVAS_PIXELS = 25_000_000
MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024
_REQUEST_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$")
_BRIA_S3_HOST = re.compile(
    r"^bria-[a-z0-9.-]+\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$"
)
_REQUIRED_PARAMS = frozenset(
    {
        "canvas_width",
        "canvas_height",
        "original_width",
        "original_height",
        "original_x",
        "original_y",
    }
)
_ALLOWED_PARAMS = _REQUIRED_PARAMS | {"seed"}
_FORMAT_DETAILS = {
    "JPEG": ("image/jpeg", ".jpg"),
    "PNG": ("image/png", ".png"),
    "WEBP": ("image/webp", ".webp"),
}


@dataclass(frozen=True)
class _Geometry:
    canvas_width: int
    canvas_height: int
    original_width: int
    original_height: int
    original_x: int
    original_y: int


@dataclass
class _Job:
    result: dict[str, Any] | None = None


def _integer(params: dict[str, Any], key: str, *, positive: bool) -> int:
    value = params.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ProviderError(
            f"Bria expand parameter {key!r} must be an integer",
            error_code=ProviderErrorCode.INVALID_INPUT,
        )
    if positive and value <= 0:
        raise ProviderError(
            f"Bria expand parameter {key!r} must be positive",
            error_code=ProviderErrorCode.INVALID_INPUT,
        )
    return value


def _geometry(params: dict[str, Any]) -> _Geometry:
    unexpected = set(params) - _ALLOWED_PARAMS
    missing = _REQUIRED_PARAMS - set(params)
    if unexpected or missing:
        details = []
        if missing:
            details.append(f"missing {', '.join(sorted(missing))}")
        if unexpected:
            details.append(f"unsupported {', '.join(sorted(unexpected))}")
        raise ProviderError(
            f"Invalid Bria expand parameters: {'; '.join(details)}",
            error_code=ProviderErrorCode.INVALID_INPUT,
        )

    geometry = _Geometry(
        canvas_width=_integer(params, "canvas_width", positive=True),
        canvas_height=_integer(params, "canvas_height", positive=True),
        original_width=_integer(params, "original_width", positive=True),
        original_height=_integer(params, "original_height", positive=True),
        original_x=_integer(params, "original_x", positive=False),
        original_y=_integer(params, "original_y", positive=False),
    )
    if geometry.canvas_width * geometry.canvas_height > MAX_CANVAS_PIXELS:
        raise ProviderError(
            "Bria expand canvas exceeds the 25 megapixel service limit",
            error_code=ProviderErrorCode.INVALID_INPUT,
        )
    if (
        geometry.original_x >= geometry.canvas_width
        or geometry.original_y >= geometry.canvas_height
        or geometry.original_x + geometry.original_width <= 0
        or geometry.original_y + geometry.original_height <= 0
    ):
        raise ProviderError(
            "Bria expand source must intersect the output canvas",
            error_code=ProviderErrorCode.INVALID_INPUT,
        )
    return geometry


def _safe_request_id(value: object) -> str:
    request_id = str(value or "")
    if not _REQUEST_ID.fullmatch(request_id):
        raise ProviderError(
            "Bria returned an invalid request identifier",
            error_code=ProviderErrorCode.UNKNOWN,
        )
    return request_id


def _status_url(request_id: str) -> str:
    return f"{BRIA_STATUS_ORIGIN}/v2/status/{request_id}"


def _valid_status_url(value: object, request_id: str) -> bool:
    if not isinstance(value, str):
        return False
    parsed = urlparse(value)
    try:
        port = parsed.port
    except ValueError:
        return False
    return (
        parsed.scheme == "https"
        and parsed.hostname == "engine.prod.bria-api.com"
        and port in (None, 443)
        and parsed.username is None
        and parsed.password is None
        and not parsed.query
        and not parsed.fragment
        and parsed.path == f"/v2/status/{request_id}"
    )


def _validate_output_url(value: object) -> str:
    if not isinstance(value, str) or not value:
        raise ProviderError(
            "Bria completed without an image URL",
            error_code=ProviderErrorCode.UNKNOWN,
        )
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower()
    try:
        port = parsed.port
    except ValueError as exc:
        raise ProviderError(
            "Bria returned a malformed image URL",
            error_code=ProviderErrorCode.INVALID_INPUT,
        ) from exc
    allowed_host = (
        host == "bria.ai"
        or host.endswith(".bria.ai")
        or host == "bria.media"
        or host.endswith(".bria.media")
        or host == "bria-api.com"
        or host.endswith(".bria-api.com")
        or bool(_BRIA_S3_HOST.fullmatch(host))
    )
    if (
        parsed.scheme != "https"
        or not allowed_host
        or port not in (None, 443)
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        raise ProviderError(
            "Bria returned an image URL outside its trusted delivery domains",
            error_code=ProviderErrorCode.INVALID_INPUT,
        )
    return value


def _retry_after(response: httpx.Response) -> float | None:
    value = response.headers.get("Retry-After")
    if value is None:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        return None


def _http_error(response: httpx.Response, *, submitted: bool = False) -> ProviderError:
    status = response.status_code
    if status in {401, 403}:
        code = ProviderErrorCode.AUTH_FAILURE
    elif status == 429:
        code = ProviderErrorCode.RATE_LIMIT
    elif status in {400, 404, 405, 413, 415, 422, 460}:
        code = ProviderErrorCode.INVALID_INPUT
    elif status >= 500:
        # A failed paid POST is ambiguous: retrying it could create a second
        # job. UNKNOWN is intentionally non-retryable; GET failures remain
        # SERVER_ERROR and are safe for Genblaze to retry.
        code = ProviderErrorCode.UNKNOWN if submitted else ProviderErrorCode.SERVER_ERROR
    else:
        code = ProviderErrorCode.UNKNOWN
    return ProviderError(
        f"Bria request failed with HTTP {status}",
        error_code=code,
        retry_after=_retry_after(response),
    )


class BriaExpandProvider(BaseProvider):
    """A direct, asynchronous adapter for Bria's purpose-built outpaint API."""

    name = "bria-direct"
    poll_interval = 1.0

    def __init__(
        self,
        api_token: str,
        output_dir: str | Path,
        *,
        http_client: httpx.Client | None = None,
        finalize_output: Callable[[Image.Image], Image.Image] | None = None,
        input_roots: tuple[str | Path, ...] = (),
        request_timeout: float = 30.0,
        retry_policy: RetryPolicy | None = None,
    ) -> None:
        if not api_token or not api_token.strip():
            raise ValueError("Bria api_token is required")
        if request_timeout <= 0:
            raise ValueError("request_timeout must be positive")
        super().__init__(retry_policy=retry_policy)
        self._api_token = api_token.strip()
        self.output_dir = Path(output_dir)
        self._client = http_client or httpx.Client(follow_redirects=False)
        self._owns_client = http_client is None
        self._finalize_output = finalize_output
        self._input_roots = tuple(Path(root).resolve() for root in input_roots) or (
            self.output_dir.resolve(),
        )
        self._request_timeout = request_timeout
        self._jobs: dict[str, _Job] = {}
        self._jobs_lock = threading.Lock()

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> BriaExpandProvider:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def get_capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            supported_modalities=[Modality.IMAGE],
            supported_inputs=["image", "text"],
            accepts_chain_input=True,
            output_formats=["image/jpeg", "image/png", "image/webp"],
            models=["bria-expand-v2"],
        )

    def _api_headers(self) -> dict[str, str]:
        return {"api_token": self._api_token, "Content-Type": "application/json"}

    def _request(
        self,
        method: str,
        url: str,
        *,
        submitted: bool = False,
        include_token: bool = True,
        json: dict[str, Any] | None = None,
    ) -> httpx.Response:
        headers = self._api_headers() if include_token else {}
        try:
            response = self._client.request(
                method,
                url,
                headers=headers,
                json=json,
                timeout=self._request_timeout,
                follow_redirects=False,
            )
        except httpx.TimeoutException as exc:
            code = ProviderErrorCode.UNKNOWN if submitted else ProviderErrorCode.TIMEOUT
            raise ProviderError(
                "Bria request timed out",
                error_code=code,
            ) from exc
        except httpx.RequestError as exc:
            code = ProviderErrorCode.UNKNOWN if submitted else ProviderErrorCode.SERVER_ERROR
            raise ProviderError(
                "Bria network request failed",
                error_code=code,
            ) from exc
        if response.is_error:
            raise _http_error(response, submitted=submitted)
        return response

    @staticmethod
    def _json_object(response: httpx.Response) -> dict[str, Any]:
        try:
            payload = response.json()
        except (ValueError, UnicodeError) as exc:
            raise ProviderError(
                "Bria returned malformed JSON",
                error_code=ProviderErrorCode.UNKNOWN,
            ) from exc
        if not isinstance(payload, dict):
            raise ProviderError(
                "Bria returned an invalid response object",
                error_code=ProviderErrorCode.UNKNOWN,
            )
        return payload

    def _source_bytes(self, step: Step, geometry: _Geometry) -> bytes:
        if len(step.inputs) != 1:
            raise ProviderError(
                "Bria expand requires exactly one staged source image",
                error_code=ProviderErrorCode.INVALID_INPUT,
            )
        asset = step.inputs[0]
        validate_chain_input_url(asset.url, file_root_allowlist=self._input_roots)
        parsed = urlparse(asset.url)
        if parsed.scheme != "file" or parsed.netloc not in ("", "localhost"):
            raise ProviderError(
                "Bria expand source must be a staged local file",
                error_code=ProviderErrorCode.INVALID_INPUT,
            )
        path = Path(unquote(parsed.path)).resolve()
        try:
            raw = path.read_bytes()
        except OSError as exc:
            raise ProviderError(
                "Bria expand source image could not be read",
                error_code=ProviderErrorCode.INVALID_INPUT,
            ) from exc
        digest = hashlib.sha256(raw).hexdigest()
        if asset.sha256 is not None and asset.sha256 != digest:
            raise ProviderError(
                "Bria expand source hash does not match its staged asset",
                error_code=ProviderErrorCode.INVALID_INPUT,
            )
        if asset.sha256 is None:
            asset.set_hash(raw)
        try:
            with Image.open(io.BytesIO(raw)) as image:
                image.load()
                image_format = image.format
                size = image.size
        except (UnidentifiedImageError, OSError, ValueError) as exc:
            raise ProviderError(
                "Bria expand source is not a valid image",
                error_code=ProviderErrorCode.INVALID_INPUT,
            ) from exc
        if image_format not in _FORMAT_DETAILS:
            raise ProviderError(
                "Bria expand source must be JPEG, PNG, or WEBP",
                error_code=ProviderErrorCode.INVALID_INPUT,
            )
        if size[0] * size[1] > MAX_CANVAS_PIXELS:
            raise ProviderError(
                "Bria expand source exceeds the 25 megapixel service limit",
                error_code=ProviderErrorCode.INVALID_INPUT,
            )
        return raw

    def submit(self, step: Step, config: RunnableConfig | None = None) -> str:
        geometry = _geometry(step.params)
        source = self._source_bytes(step, geometry)
        prompt = (step.prompt or "").strip()
        if len(prompt) > 2_000:
            raise ProviderError(
                "Bria expand prompt is too long",
                error_code=ProviderErrorCode.INVALID_INPUT,
            )
        payload: dict[str, Any] = {
            "image": base64.b64encode(source).decode("ascii"),
            "canvas_size": [geometry.canvas_width, geometry.canvas_height],
            "original_image_size": [geometry.original_width, geometry.original_height],
            "original_image_location": [geometry.original_x, geometry.original_y],
            "sync": False,
        }
        if prompt:
            payload["prompt"] = prompt
        negative_prompt = (step.negative_prompt or "").strip()
        if negative_prompt:
            if len(negative_prompt) > 2_000:
                raise ProviderError(
                    "Bria expand negative prompt is too long",
                    error_code=ProviderErrorCode.INVALID_INPUT,
                )
            payload["negative_prompt"] = negative_prompt
        param_seed = step.params.get("seed")
        if step.seed is not None and param_seed is not None and step.seed != param_seed:
            raise ProviderError(
                "Bria expand seed is defined inconsistently",
                error_code=ProviderErrorCode.INVALID_INPUT,
            )
        seed = step.seed if step.seed is not None else param_seed
        if seed is not None:
            if isinstance(seed, bool) or not isinstance(seed, int) or seed < 0:
                raise ProviderError(
                    "Bria expand seed must be a non-negative integer",
                    error_code=ProviderErrorCode.INVALID_INPUT,
                )
            payload["seed"] = seed

        # Do not let Genblaze repeat this POST after an ambiguous transport or
        # 5xx failure.  Once a request id exists, all later retries are GETs.
        response = self._request(
            "POST",
            BRIA_EXPAND_URL,
            submitted=True,
            json=payload,
        )
        body = self._json_object(response)
        request_id = _safe_request_id(body.get("request_id"))
        supplied_status_url = body.get("status_url")
        if supplied_status_url is not None and not _valid_status_url(
            supplied_status_url, request_id
        ):
            # Never follow a provider-returned polling URL. Validate it for
            # protocol drift, then always construct the canonical endpoint.
            raise ProviderError(
                "Bria returned an untrusted status URL",
                error_code=ProviderErrorCode.UNKNOWN,
            )

        result = body.get("result")
        job = _Job(result=result if isinstance(result, dict) else None)
        with self._jobs_lock:
            self._jobs[request_id] = job
        return request_id

    def poll(self, prediction_id: Any, config: RunnableConfig | None = None) -> bool:
        request_id = _safe_request_id(prediction_id)
        with self._jobs_lock:
            cached = self._jobs.get(request_id)
            if cached is not None and cached.result is not None:
                return True

        # `request_id` in a status body is NOT the job id -- Bria mints a fresh
        # one per status call (verified live: three GETs on one finished job
        # returned three different ids). Correlation comes from the URL, which
        # we build ourselves from the submitted id, so there is nothing here to
        # cross-check. Comparing the two rejects every real poll.
        response = self._request("GET", _status_url(request_id))
        body = self._json_object(response)
        status = str(body.get("status", "")).upper()
        if status == "IN_PROGRESS":
            return False
        if status == "COMPLETED":
            result = body.get("result")
            if not isinstance(result, dict):
                raise ProviderError(
                    "Bria completed without an image result",
                    error_code=ProviderErrorCode.UNKNOWN,
                )
            _validate_output_url(result.get("image_url"))
            with self._jobs_lock:
                self._jobs[request_id] = _Job(result=result)
            return True
        if status == "ERROR":
            error = body.get("error")
            error_code = ""
            if isinstance(error, dict):
                error_code = str(error.get("code", ""))[:100].lower()
            code = (
                ProviderErrorCode.CONTENT_POLICY
                if "moderation" in error_code or "safety" in error_code
                else ProviderErrorCode.MODEL_ERROR
            )
            raise ProviderError("Bria expansion job failed", error_code=code)
        if status == "UNKNOWN":
            raise ProviderError(
                "Bria expansion job entered an unknown state",
                error_code=ProviderErrorCode.SERVER_ERROR,
            )
        raise ProviderError(
            "Bria returned an unrecognized job status",
            error_code=ProviderErrorCode.SERVER_ERROR,
        )

    @staticmethod
    def _decode_image(raw: bytes) -> tuple[Image.Image, str, str]:
        if not raw or len(raw) > MAX_DOWNLOAD_BYTES:
            raise ProviderError(
                "Bria image download has an invalid size",
                error_code=ProviderErrorCode.INVALID_INPUT,
            )
        try:
            with Image.open(io.BytesIO(raw)) as source:
                source.load()
                image_format = source.format or ""
                image = source.copy()
        except (UnidentifiedImageError, OSError, ValueError) as exc:
            raise ProviderError(
                "Bria returned an invalid image",
                error_code=ProviderErrorCode.INVALID_INPUT,
            ) from exc
        details = _FORMAT_DETAILS.get(image_format)
        if details is None:
            raise ProviderError(
                "Bria returned an unsupported image format",
                error_code=ProviderErrorCode.INVALID_INPUT,
            )
        media_type, extension = details
        return image, media_type, extension

    def _completed_result(self, request_id: str) -> dict[str, Any]:
        with self._jobs_lock:
            job = self._jobs.get(request_id)
            result = job.result if job is not None else None
        if result is None:
            # Supports Genblaze resume() on a fresh provider instance and also
            # refreshes an expired signed delivery URL during a fetch retry.
            response = self._request("GET", _status_url(request_id))
            body = self._json_object(response)
            if str(body.get("status", "")).upper() != "COMPLETED":
                raise ProviderError(
                    "Bria result was not available for download",
                    error_code=ProviderErrorCode.SERVER_ERROR,
                )
            result = body.get("result")
            if not isinstance(result, dict):
                raise ProviderError(
                    "Bria completed without an image result",
                    error_code=ProviderErrorCode.UNKNOWN,
                )
            with self._jobs_lock:
                self._jobs[request_id] = _Job(result=result)
        return result

    def fetch_output(self, prediction_id: Any, step: Step) -> Step:
        request_id = _safe_request_id(prediction_id)
        geometry = _geometry(step.params)
        result = self._completed_result(request_id)
        image_url = _validate_output_url(result.get("image_url"))
        response = self._request("GET", image_url, include_token=False)
        raw = response.content
        image, media_type, extension = self._decode_image(raw)
        if image.size != (geometry.canvas_width, geometry.canvas_height):
            raise ProviderError(
                "Bria expand output dimensions do not match the requested canvas",
                error_code=ProviderErrorCode.INVALID_INPUT,
            )

        if self._finalize_output is not None:
            try:
                finalized = self._finalize_output(image.copy())
            except ProviderError:
                raise
            except Exception as exc:  # noqa: BLE001 - normalize callback failures
                raise ProviderError(
                    "Bria expand finalization failed",
                    error_code=ProviderErrorCode.INVALID_INPUT,
                ) from exc
            if not isinstance(finalized, Image.Image):
                raise ProviderError(
                    "Bria expand finalizer must return a PIL image",
                    error_code=ProviderErrorCode.INVALID_INPUT,
                )
            if finalized.width <= 0 or finalized.height <= 0:
                raise ProviderError(
                    "Bria expand finalizer returned an empty image",
                    error_code=ProviderErrorCode.INVALID_INPUT,
                )
            if finalized.width * finalized.height > MAX_CANVAS_PIXELS:
                raise ProviderError(
                    "Bria expand finalized image exceeds 25 megapixels",
                    error_code=ProviderErrorCode.INVALID_INPUT,
                )
            buffer = io.BytesIO()
            finalized.save(buffer, format="PNG", optimize=True)
            raw = buffer.getvalue()
            image = finalized
            media_type, extension = "image/png", ".png"

        self.output_dir.mkdir(parents=True, exist_ok=True)
        output_stem = hashlib.sha256(step.step_id.encode("utf-8")).hexdigest()
        output = self.output_dir / f"{output_stem}{extension}"
        temporary = self.output_dir / f".{output_stem}{extension}.tmp"
        try:
            temporary.write_bytes(raw)
            os.replace(temporary, output)
        finally:
            temporary.unlink(missing_ok=True)

        asset = Asset(
            url=output.resolve().as_uri(),
            media_type=media_type,
            width=image.width,
            height=image.height,
            metadata={"kind": "bria-expand", "provider_request_id": request_id},
        )
        asset.set_hash(raw)
        step.assets.append(asset)
        step.step_type = StepType.EDIT
        step.provider_payload = {
            "request_id": request_id,
            "status": "COMPLETED",
            **({"seed": result["seed"]} if isinstance(result.get("seed"), int) else {}),
        }
        with self._jobs_lock:
            self._jobs.pop(request_id, None)
        return step
