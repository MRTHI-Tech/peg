"""Genblaze execution for PEG.

Everything here encodes something learned the hard way against the live API:

- GMI's image queue drops roughly 2 in 3 submits on the edit models, so every
  call retries with backoff.
- `Pipeline.run()` reports `status: completed` even when the asset transfer
  failed and nothing was stored, so success is verified against the bucket
  rather than trusted from the result object.
- No GMI image model honours `resolution` / `aspect_ratio` / `width` / `height`.
  Hitting an exact breakpoint means outpainting onto a target-sized canvas.
- Bria's inpaint models want `image` and `mask` as base64 under those exact
  names. The `_url` variants are rejected and presigned URLs get reset.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import tempfile
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path

import boto3
import cairosvg
from dotenv import load_dotenv
from PIL import Image, ImageFilter

from genblaze_core.models import Asset, Modality, StepType, parse_manifest
from genblaze_core.pipeline import Pipeline
from genblaze_core.storage import KeyStrategy, ObjectStorageSink
from genblaze_gmicloud import GMICloudImageProvider
from genblaze_s3 import S3StorageBackend

from schemas import AssetOut, FormatSpec, ProvenanceOut, RunRequest
from compositor import PegCompositorProvider

load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")

PREFIX = "peg"


def workspace_prefix(workspace: str) -> str:
    """Where one workspace's objects live.

    Everything a workspace owns hangs off this, which is what makes a fresh
    sign-in an empty state with no first-run handling anywhere: the prefix simply
    has nothing under it yet.
    """
    if not workspace or "/" in workspace:
        raise ValueError(f"invalid workspace id: {workspace!r}")
    return f"{PREFIX}/workspaces/{workspace}"


MAX_ATTEMPTS = 3
PRESIGN_TTL = 60 * 60 * 12
OUTPAINT_MODEL = "bria-genfill"
MAX_STYLE_REFERENCES = 3
MAX_LOGO_REFERENCES = 2
REFERENCE_EDGE = 1024

# Mask feathering, in pixels, so the outpaint boundary is not a hard seam.
FEATHER_SIGMA = 16

# Finished artwork sometimes reaches Extend Canvas with a simple brand frame
# already flattened into the pixels. Treating that frame as scene content turns
# the entire source into an immutable poster inside the wider result. Detection
# is deliberately conservative: every edge must agree on one colour and the
# interior must be materially different.
FRAME_COLOR_TOLERANCE = 24
FRAME_EDGE_COVERAGE = 0.95
FRAME_LINE_COVERAGE = 0.85
FRAME_MAX_RATIO = 0.12
FRAME_INTERIOR_MAX_COVERAGE = 0.35
FRAME_CONTENT_BLEED_RATIO = 0.003
BADGE_MIN_RATIO = 0.08
BADGE_MAX_RATIO = 0.45
BADGE_MIN_COLOR_COVERAGE = 0.45

# Without this, genfill cheerfully paints copies of the subject into the space
# that was supposed to stay empty for the headline.
DEFAULT_NEGATIVE = (
    "podium, pedestal, cylinder, platform, pillar, object, product, duplicate, "
    "repeated shapes, cloned object, extra product, extra podium, text, logo, "
    "watermark, seam, hard edge, border, inset image, picture-in-picture, card, "
    "poster, panel, framed image"
)

OUTPAINT_PROMPT = (
    "Extend the existing scene through every generated area as one continuous, "
    "edge-to-edge photograph. Match the source palette, lighting, materials, depth, "
    "and perspective exactly. The result must never contain a smaller image, card, "
    "poster, panel, or frame inside the canvas. Keep the declared safe area calm and "
    "low-detail. Add no subjects, products, typography, logos, podiums, platforms, "
    "or repeated objects."
)


@dataclass
class RunOutcome:
    run_id: str
    attempts: int
    asset: AssetOut
    provenance: ProvenanceOut


@dataclass(frozen=True)
class EmbeddedFrame:
    """A flat, near-solid frame surrounding otherwise independent artwork."""

    left: int
    top: int
    right: int
    bottom: int
    color: tuple[int, int, int]

    def content_box(
        self, size: tuple[int, int], bleed: int = 0
    ) -> tuple[int, int, int, int]:
        width, height = size
        return (
            self.left + bleed,
            self.top + bleed,
            width - self.right - bleed,
            height - self.bottom - bleed,
        )


@dataclass(frozen=True)
class EmbeddedBadge:
    """A corner lockup flattened into the same colour field as a brand frame."""

    left: int
    top: int
    right: int
    bottom: int

    @property
    def box(self) -> tuple[int, int, int, int]:
        return self.left, self.top, self.right, self.bottom

    @property
    def size(self) -> tuple[int, int]:
        return self.right - self.left, self.bottom - self.top


@dataclass(frozen=True)
class GenerationReference:
    """One labelled image in Gemini's multimodal brand context.

    Bytes stay outside Genblaze's parameter surface. Only this content hash and
    the B2 key reach the manifest, so a run remains reproducible without copying
    several base64 images into provenance JSON.
    """

    role: str
    label: str
    data_b64: str
    media_type: str
    asset_key: str

    def manifest_marker(self) -> str:
        digest = hashlib.sha256(base64.b64decode(self.data_b64)).hexdigest()
        return f"{self.role}:{digest}:{self.asset_key}"


class RunFailed(RuntimeError):
    pass


def _s3():
    return boto3.client(
        "s3",
        endpoint_url=f"https://s3.{os.environ['B2_REGION']}.backblazeb2.com",
        aws_access_key_id=os.environ["B2_KEY_ID"],
        aws_secret_access_key=os.environ["B2_APP_KEY"],
        region_name=os.environ["B2_REGION"],
    )


def _bucket() -> str:
    return os.environ["B2_BUCKET"]


def presign(key: str, ttl: int = PRESIGN_TTL) -> str:
    """The bucket is private, so everything the browser renders is presigned."""
    return _s3().generate_presigned_url(
        "get_object", Params={"Bucket": _bucket(), "Key": key}, ExpiresIn=ttl
    )


def _sink(workspace: str) -> ObjectStorageSink:
    backend = S3StorageBackend.for_backblaze(
        _bucket(),
        region=os.environ["B2_REGION"],
        key_id=os.environ["B2_KEY_ID"],
        app_key=os.environ["B2_APP_KEY"],
    )
    return ObjectStorageSink(
        backend, prefix=workspace_prefix(workspace), key_strategy=KeyStrategy.HIERARCHICAL
    )


class PegGMICloudImageProvider(GMICloudImageProvider):
    """Keep inline image bytes out of Genblaze's persisted parameter surface.

    GMI requires edit inputs as base64 under ``image``/``mask``. Genblaze 0.3.8
    scans every string in ``step.params`` for credential-shaped substrings, and
    an opaque image can contain one by chance. More importantly, leaving the
    whole image in params would copy it into the manifest.

    Only payloads Pillow verifies as images are replaced. An actual credential
    accidentally placed in one of these fields therefore remains untouched and
    is still rejected by Genblaze's guard. The SHA marker preserves input
    identity in the canonical hash; the original bytes exist only long enough
    to build the outbound provider request.
    """

    _INLINE_KEYS = frozenset({"image", "mask"})
    _MARKER_PREFIX = "peg-inline-image-sha256:"

    def __init__(
        self,
        *args,
        references: tuple[GenerationReference, ...] = (),
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        self._inline_images: dict[str, tuple[str, str]] = {}
        self._references = references

    @staticmethod
    def _verified_image(value: object) -> tuple[bytes, str] | None:
        if not isinstance(value, str) or not value:
            return None
        try:
            raw = base64.b64decode(value, validate=True)
            with Image.open(io.BytesIO(raw)) as image:
                image.verify()
                media_type = Image.MIME.get(image.format or "", "image/png")
            return raw, media_type
        except Exception:  # noqa: BLE001 — non-image values must reach the secret guard
            return None

    def normalize_params(self, params: dict, modality=None) -> dict:
        normalized = super().normalize_params(params, modality)
        protected = dict(normalized)
        for key in self._INLINE_KEYS:
            verified = self._verified_image(protected.get(key))
            if verified is None:
                continue
            raw, media_type = verified
            marker = f"{self._MARKER_PREFIX}{hashlib.sha256(raw).hexdigest()}"
            self._inline_images[marker] = (protected[key], media_type)
            protected[key] = marker
        return protected

    def prepare_payload(self, step, *, base_params=None, validate_inputs=True):
        payload = super().prepare_payload(
            step,
            base_params=base_params,
            validate_inputs=validate_inputs,
        )
        payload.pop("peg_brand_references", None)
        campaign_image: tuple[str, str] | None = None
        for key in self._INLINE_KEYS:
            marker = payload.get(key)
            if isinstance(marker, str) and marker in self._inline_images:
                encoded, media_type = self._inline_images[marker]
                # The queue's top-level `image` contract accepts hosted URLs,
                # but rejects both bare base64 strings and data URIs for this
                # Gemini model. Its documented native `contents` contract has
                # an explicit inlineData field and reliably distinguishes bytes
                # from a URI. When contents is present, prompt/image are ignored,
                # so remove both instead of shipping two competing request forms.
                if key == "image" and step.model.lower().startswith("gemini-"):
                    payload.pop("image", None)
                    campaign_image = (encoded, media_type)
                else:
                    payload[key] = encoded

        if step.model.lower().startswith("gemini-") and (
            campaign_image is not None or self._references
        ):
            prompt = str(payload.pop("prompt", ""))
            parts: list[dict] = [{"text": prompt}]
            if campaign_image is not None:
                encoded, media_type = campaign_image
                parts.extend(
                    [
                        {
                            "text": (
                                "COMPOSITION REFERENCE. Preserve its camera distance, "
                                "framing, perspective, subject scale, and spatial layout. "
                                "Do not preserve its logos, names, signage, or colours."
                            )
                        },
                        {
                            "inlineData": {
                                "mimeType": media_type,
                                "data": encoded,
                            }
                        },
                    ]
                )
            for reference in self._references:
                parts.extend(
                    [
                        {"text": reference.label},
                        {
                            "inlineData": {
                                "mimeType": reference.media_type,
                                "data": reference.data_b64,
                            }
                        },
                    ]
                )
            parts.append(
                {
                    "text": (
                        "Generate the final image now. Follow the role of each labelled "
                        "reference; never copy source-reference branding into the result."
                    )
                }
            )
            payload["contents"] = [{"role": "user", "parts": parts}]
        return payload


def _provider(
    references: tuple[GenerationReference, ...] = (),
) -> GMICloudImageProvider:
    return PegGMICloudImageProvider(
        api_key=os.environ["GMI_API_KEY"], references=references
    )


def fetch_object(key: str) -> bytes:
    return _s3().get_object(Bucket=_bucket(), Key=key)["Body"].read()


def fetch_workspace_object(key: str, workspace: str) -> bytes:
    """Fetch a chained input only when the current workspace owns it."""
    prefix = f"{workspace_prefix(workspace)}/"
    if not key.startswith(prefix):
        raise RunFailed("source asset does not belong to this workspace")
    return fetch_object(key)


def list_runs(workspace: str, limit: int = 60) -> list[dict]:
    """Every generation this workspace has produced, newest first.

    B2 has no query capability, but listing by prefix does work — and because a
    workspace owns its whole prefix, "what has this team made" is one list call.
    A workspace that has generated nothing lists nothing, which is what makes the
    gallery honestly empty rather than empty by special case.

    Manifests are deliberately not opened: that would be one GET per run to
    render a grid of thumbnails.
    """
    prefix = f"{workspace_prefix(workspace)}/runs/"
    paginator = _s3().get_paginator("list_objects_v2")

    runs: dict[str, dict] = {}
    for page in paginator.paginate(Bucket=_bucket(), Prefix=prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            rest = key[len(prefix) :].split("/")
            # <date>/<run_id>/assets/<file>
            if len(rest) < 4 or rest[2] != "assets":
                continue
            date, run_id = rest[0], rest[1]
            entry = runs.setdefault(
                run_id,
                {"run_id": run_id, "created_at": date, "asset_key": key, "asset_count": 0},
            )
            entry["asset_count"] += 1
            # Newest asset in the run wins the thumbnail.
            if obj["LastModified"].isoformat() > entry.get("modified", ""):
                entry["modified"] = obj["LastModified"].isoformat()
                entry["asset_key"] = key

    ordered = sorted(runs.values(), key=lambda r: r.get("modified", ""), reverse=True)[:limit]
    for entry in ordered:
        entry["url"] = presign(entry["asset_key"])
    return ordered


def _collect_run_output(run_id: str, workspace: str) -> tuple[AssetOut, ProvenanceOut]:
    """Find what a run actually stored. Raises if nothing landed.

    Genblaze reports success even when the transfer failed, so this is the real
    success check.
    """
    s3, bucket = _s3(), _bucket()
    keys = [
        o["Key"]
        for o in s3.list_objects_v2(
            Bucket=bucket, Prefix=f"{workspace_prefix(workspace)}/runs/"
        ).get("Contents", [])
        if run_id in o["Key"]
    ]
    assets = [k for k in keys if "/assets/" in k]
    if not assets:
        raise RunFailed(f"run {run_id} reported success but stored no asset")

    key = assets[0]
    head = s3.head_object(Bucket=bucket, Key=key)
    width = height = None
    try:
        with Image.open(io.BytesIO(fetch_object(key))) as im:
            width, height = im.size
    except Exception:  # noqa: BLE001 — dimensions are a nicety, not a failure
        pass

    asset = AssetOut(
        asset_key=key,
        bucket=bucket,
        url=presign(key),
        width=width,
        height=height,
        bytes=head.get("ContentLength"),
        content_type=head.get("ContentType", "image/png"),
    )

    prov = ProvenanceOut(run_id=run_id)
    manifest_keys = [k for k in keys if k.endswith("manifest.json")]
    if manifest_keys:
        prov.manifest_key = manifest_keys[0]
        prov.manifest_url = presign(manifest_keys[0])
        raw = fetch_object(manifest_keys[0])
        try:
            m = json.loads(raw)
            prov.canonical_hash = m.get("canonical_hash")
            run = m.get("run") or {}
            steps = run.get("steps") or []
            if steps:
                prov.provider = steps[0].get("provider")
                prov.model = steps[0].get("model")
                prov.input_asset_keys = [
                    str((item.get("metadata") or {}).get("asset_key"))
                    for item in (steps[0].get("inputs") or [])
                    if (item.get("metadata") or {}).get("asset_key")
                ]
            prov.created_at = run.get("created_at") or run.get("started_at")
        except Exception:  # noqa: BLE001 — a malformed manifest should not fail the run
            pass

        prov.verified = _verify_manifest(manifest_keys[0], raw)

    return asset, prov


def _verify_manifest(key: str, raw: bytes) -> bool | None:
    """Verify a manifest, tolerating B2's eventual consistency.

    Verification must come from Genblaze rather than a guess at which fields are
    populated — the presence of a `signature` key says nothing about validity.

    But reading immediately after upload can return a not-yet-consistent copy,
    which hashes to a mismatch and reports a perfectly good asset as tampered
    with. That is the worst possible failure mode for a provenance feature, so a
    False is re-checked against a fresh read before it is believed.

    Returns True/False for a real verdict, or None when the check could not run.
    None is not the same as False and must never be rendered as verified.
    """
    payload = raw
    for attempt in range(3):
        try:
            if parse_manifest(json.loads(payload)).verify():
                return True
        except Exception:  # noqa: BLE001 — malformed read; try a fresh one
            if attempt == 2:
                return None
        if attempt < 2:
            time.sleep(1.5 * (attempt + 1))
            try:
                payload = fetch_object(key)
            except Exception:  # noqa: BLE001
                return None
    return False


def _submit(
    model: str,
    prompt: str,
    params: dict,
    workspace: str,
    references: tuple[GenerationReference, ...] = (),
) -> tuple[str, int]:
    """Run one step with retry. Returns (run_id, attempts_used)."""
    last: Exception | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            result = (
                Pipeline("peg", preflight=False)
                .step(
                    _provider(references),
                    model=model,
                    prompt=prompt,
                    modality=Modality.IMAGE,
                    params=params,
                )
                .run(sink=_sink(workspace), timeout=420, raise_on_failure=True)
            )
            run = getattr(result, "run", result)
            return str(getattr(run, "run_id", "")), attempt
        except Exception as exc:  # noqa: BLE001
            last = exc
            msg = str(exc).lower()
            # A rejected model or missing entitlement will not fix itself.
            if any(
                s in msg
                for s in (
                    "not found",
                    "unknown model",
                    "no access",
                    "invalid payload",
                    "invalid_input",
                    "unsupported uri scheme",
                )
            ):
                break
            if attempt < MAX_ATTEMPTS:
                time.sleep(4 * attempt)
    raise RunFailed(f"submit failed after retries: {last}")


# ------------------------------------------------------------------ operations


def run_generate(
    req: RunRequest,
    workspace: str,
    references: tuple[GenerationReference, ...] = (),
) -> RunOutcome:
    params: dict = dict(req.params)
    if req.negative_prompt:
        params["negative_prompt"] = req.negative_prompt
    if req.image_b64:
        params["image"] = req.image_b64
    elif req.source_asset_key:
        params["image"] = base64.b64encode(
            fetch_workspace_object(req.source_asset_key, workspace)
        ).decode()
    if req.model.lower().startswith("gemini-"):
        # Gemini edits conversationally and has no strength parameter. A stale
        # pre-deploy node may still carry one in browser state.
        params.pop("strength", None)
    if references:
        params["peg_brand_references"] = [
            reference.manifest_marker() for reference in references
        ]

    run_id, attempts = _submit(
        req.model, req.prompt, params, workspace, references=references
    )
    asset, prov = _collect_run_output(run_id, workspace)
    return RunOutcome(run_id=run_id, attempts=attempts, asset=asset, provenance=prov)


def _staged_asset(directory: Path, role: str, source_key: str, raw: bytes) -> Asset:
    """Write a workspace-owned input under the run's temporary root.

    Genblaze records the content hash rather than a rotating B2 presigned URL,
    keeping the compositor manifest stable across reruns of the same inputs.
    """
    # Brand logos may be stored as SVG, while Pillow deliberately consumes
    # raster inputs only. Rasterize the staged copy; the approved original in
    # B2 remains untouched.
    if role == "logo" and b"<svg" in raw[:1024].lower():
        raw = cairosvg.svg2png(bytestring=raw, output_width=1024)
    path = directory / f"{role}.asset"
    path.write_bytes(raw)
    asset = Asset(
        url=path.resolve().as_uri(),
        media_type="image/png",
        metadata={"peg_role": role, "asset_key": source_key},
    )
    asset.set_hash(raw)
    return asset


def run_compose(req: RunRequest, workspace: str) -> RunOutcome:
    if req.format is None:
        raise RunFailed("composition requires an output format")
    if not req.source_asset_key:
        raise RunFailed("composition requires a background")
    if not req.overlay_asset_key:
        raise RunFailed("composition requires an app screenshot")

    inputs = [
        (
            "background",
            req.source_asset_key,
            fetch_workspace_object(req.source_asset_key, workspace),
        ),
        (
            "screenshot",
            req.overlay_asset_key,
            fetch_workspace_object(req.overlay_asset_key, workspace),
        ),
    ]
    if req.logo_asset_key:
        inputs.append(
            ("logo", req.logo_asset_key, fetch_workspace_object(req.logo_asset_key, workspace))
        )

    with tempfile.TemporaryDirectory(prefix="peg-compose-") as temp:
        directory = Path(temp)
        assets = [
            _staged_asset(directory, role, source_key, raw)
            for role, source_key, raw in inputs
        ]
        params = dict(req.params)
        params.update(
            {
                "output_width": req.format.width,
                "output_height": req.format.height,
            }
        )
        result = (
            Pipeline("peg-compose", preflight=False)
            .step(
                PegCompositorProvider(directory),
                model="app-store-layout-v1",
                modality=Modality.IMAGE,
                step_type=StepType.CUSTOM,
                external_inputs=assets,
                params=params,
                metadata={
                    "operation": "app-store-compose",
                    "workspace_prefix": workspace_prefix(workspace),
                },
            )
            .run(sink=_sink(workspace), timeout=120, raise_on_failure=True)
        )
        run = getattr(result, "run", result)
        run_id = str(getattr(run, "run_id", ""))

    asset, prov = _collect_run_output(run_id, workspace)
    if (asset.width, asset.height) != (req.format.width, req.format.height):
        raise RunFailed(
            f"composition returned {asset.width}x{asset.height}; expected "
            f"{req.format.width}x{req.format.height}"
        )
    return RunOutcome(run_id=run_id, attempts=1, asset=asset, provenance=prov)


def _placement_for_format(
    source_size: tuple[int, int], fmt: FormatSpec
) -> tuple[tuple[int, int], tuple[int, int]]:
    """Contain the complete plate in the target and return (size, position).

    Safe areas are regenerated by the mask; they must never shrink the source
    into a four-sided island. A square therefore spans the full height of a wide
    target and the full width of a portrait target — the invariant behind
    "compose, don't crop".
    """
    source_w, source_h = source_size
    if source_w <= 0 or source_h <= 0:
        raise RunFailed("source image has invalid dimensions")

    scale = min(fmt.width / source_w, fmt.height / source_h)
    plate_w = min(fmt.width, max(1, round(source_w * scale)))
    plate_h = min(fmt.height, max(1, round(source_h * scale)))
    if plate_w < fmt.width and plate_h < fmt.height:
        raise RunFailed("source placement would create an inset image")

    if fmt.focal_point == "left":
        x = 0
    elif fmt.focal_point == "center":
        x = (fmt.width - plate_w) // 2
    else:
        x = fmt.width - plate_w

    if fmt.safe_area == "upper-third":
        y = fmt.height - plate_h
    elif fmt.safe_area == "lower-third":
        y = 0
    else:
        y = (fmt.height - plate_h) // 2

    return (plate_w, plate_h), (x, y)


def _safe_area_box(fmt: FormatSpec) -> tuple[int, int, int, int] | None:
    """Return the copy-safe band that genfill must actively recompose."""
    if fmt.safe_area == "left-third":
        return 0, 0, max(1, fmt.width // 3), fmt.height
    if fmt.safe_area == "right-third":
        return fmt.width - max(1, fmt.width // 3), 0, fmt.width, fmt.height
    if fmt.safe_area == "upper-third":
        return 0, 0, fmt.width, max(1, fmt.height // 3)
    if fmt.safe_area == "lower-third":
        return 0, fmt.height - max(1, fmt.height // 3), fmt.width, fmt.height
    # "Center" remains prompt-only: masking a guessed central box can erase the
    # very focal subject the user asked to keep centered.
    return None


def _close_to_color(pixel: tuple[int, int, int], color: tuple[int, int, int]) -> bool:
    return max(abs(channel - expected) for channel, expected in zip(pixel, color)) <= (
        FRAME_COLOR_TOLERANCE
    )


def _median_color(pixels: list[tuple[int, int, int]]) -> tuple[int, int, int]:
    middle = len(pixels) // 2
    return tuple(sorted(pixel[channel] for pixel in pixels)[middle] for channel in range(3))


def _edge_line(
    source: Image.Image, side: str, offset: int
) -> list[tuple[int, int, int]]:
    width, height = source.size
    if side == "top":
        return list(source.crop((0, offset, width, offset + 1)).getdata())
    if side == "bottom":
        y = height - offset - 1
        return list(source.crop((0, y, width, y + 1)).getdata())
    if side == "left":
        return list(source.crop((offset, 0, offset + 1, height)).getdata())
    x = width - offset - 1
    return list(source.crop((x, 0, x + 1, height)).getdata())


def _detect_embedded_frame(source: Image.Image) -> EmbeddedFrame | None:
    """Find a simple four-sided frame without mistaking a flat scene for one.

    The fallback matters as much as detection: unframed plates keep the proven
    contain-and-outpaint geometry. A one-sided sky band or dark vignette also
    stays untouched because all four outer edges must share the same colour.
    """
    source = source.convert("RGB")
    width, height = source.size
    short_edge = min(width, height)
    if short_edge < 64:
        return None

    perimeter = (
        _edge_line(source, "top", 0)
        + _edge_line(source, "bottom", 0)
        + _edge_line(source, "left", 0)
        + _edge_line(source, "right", 0)
    )
    color = _median_color(perimeter)
    edge_coverage = sum(_close_to_color(pixel, color) for pixel in perimeter) / len(
        perimeter
    )
    if edge_coverage < FRAME_EDGE_COVERAGE:
        return None

    max_scan = max(1, round(short_edge * FRAME_MAX_RATIO))

    def thickness(side: str) -> int:
        for offset in range(max_scan):
            line = _edge_line(source, side, offset)
            coverage = sum(_close_to_color(pixel, color) for pixel in line) / len(line)
            if coverage < FRAME_LINE_COVERAGE:
                return offset
        return max_scan

    sides = [thickness(side) for side in ("left", "top", "right", "bottom")]
    minimum = max(2, round(short_edge * 0.005))
    if min(sides) < minimum or max(sides) > min(sides) * 1.75:
        return None

    frame = EmbeddedFrame(*sides, color=color)
    box = frame.content_box(source.size)
    if box[2] - box[0] < 32 or box[3] - box[1] < 32:
        return None

    # Solid-colour plates make every scan line look like a frame. Require the
    # proposed interior to contain enough genuinely different image content.
    sample = source.crop(box)
    sample.thumbnail((96, 96), Image.Resampling.BOX)
    interior = list(sample.getdata())
    interior_coverage = sum(_close_to_color(pixel, color) for pixel in interior) / len(
        interior
    )
    return frame if interior_coverage <= FRAME_INTERIOR_MAX_COVERAGE else None


def _detect_corner_badge(
    content: Image.Image, frame_color: tuple[int, int, int]
) -> EmbeddedBadge | None:
    """Find a frame-coloured lockup panel connected to the bottom-right corner.

    This is a compatibility bridge for flattened artwork. It is intentionally
    narrow: only a dense, reasonably sized corner component qualifies. Arbitrary
    logos still belong in the structured brand-asset lane.
    """
    content = content.convert("RGB")
    width, height = content.size
    pixels = content.load()
    start = (width - 1, height - 1)
    if not _close_to_color(pixels[start], frame_color):
        return None

    pending = deque([start])
    visited = {start}
    min_x = max_x = start[0]
    min_y = max_y = start[1]

    while pending:
        x, y = pending.popleft()
        min_x, max_x = min(min_x, x), max(max_x, x)
        min_y, max_y = min(min_y, y), max(max_y, y)
        for candidate in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            cx, cy = candidate
            if not (0 <= cx < width and 0 <= cy < height):
                continue
            if candidate in visited or not _close_to_color(pixels[candidate], frame_color):
                continue
            visited.add(candidate)
            pending.append(candidate)

    badge = EmbeddedBadge(min_x, min_y, max_x + 1, max_y + 1)
    badge_w, badge_h = badge.size
    width_ratio, height_ratio = badge_w / width, badge_h / height
    if not (
        BADGE_MIN_RATIO <= width_ratio <= BADGE_MAX_RATIO
        and BADGE_MIN_RATIO <= height_ratio <= BADGE_MAX_RATIO
    ):
        return None
    if badge.right != width or badge.bottom != height:
        return None
    density = len(visited) / (badge_w * badge_h)
    return badge if density >= BADGE_MIN_COLOR_COVERAGE else None


def _scaled_frame_insets(
    frame: EmbeddedFrame,
    source_size: tuple[int, int],
    target_size: tuple[int, int],
) -> tuple[int, int, int, int]:
    scale = min(target_size) / min(source_size)
    return tuple(
        max(1, round(value * scale))
        for value in (frame.left, frame.top, frame.right, frame.bottom)
    )


def _paint_embedded_frame(
    canvas: Image.Image,
    source: Image.Image,
    frame: EmbeddedFrame,
    insets: tuple[int, int, int, int],
) -> None:
    """Stretch only the source's edge strips around the new outer perimeter."""
    width, height = canvas.size
    source_w, source_h = source.size
    left, top, right, bottom = insets

    canvas.paste(
        source.crop((0, 0, source_w, frame.top)).resize(
            (width, top), Image.Resampling.LANCZOS
        ),
        (0, 0),
    )
    canvas.paste(
        source.crop((0, source_h - frame.bottom, source_w, source_h)).resize(
            (width, bottom), Image.Resampling.LANCZOS
        ),
        (0, height - bottom),
    )
    inner_height = height - top - bottom
    canvas.paste(
        source.crop((0, frame.top, frame.left, source_h - frame.bottom)).resize(
            (left, inner_height), Image.Resampling.LANCZOS
        ),
        (0, top),
    )
    canvas.paste(
        source.crop(
            (source_w - frame.right, frame.top, source_w, source_h - frame.bottom)
        ).resize((right, inner_height), Image.Resampling.LANCZOS),
        (width - right, top),
    )


def _compose_for_format(source: Image.Image, fmt: FormatSpec) -> tuple[bytes, bytes]:
    """Seat scene pixels outside the safe band; mask everything else.

    Returns (canvas_jpeg, mask_png). JPEG for the canvas because a PNG of a
    smooth gradient is ~3x the bytes and the endpoint is size-sensitive.

    A detected flat frame is peeled before placement and rebuilt at the final
    perimeter. This prevents a finished square key visual from surviving as a
    visibly separate poster inside a wide result.
    """
    source = source.convert("RGB")
    w, h = fmt.width, fmt.height
    frame = _detect_embedded_frame(source)
    badge: EmbeddedBadge | None = None

    if frame is None:
        content = source
        insets = (0, 0, 0, 0)
        working_fmt = fmt
    else:
        bleed = max(1, round(min(source.size) * FRAME_CONTENT_BLEED_RATIO))
        untrimmed_content = source.crop(frame.content_box(source.size))
        untrimmed_badge = _detect_corner_badge(untrimmed_content, frame.color)
        content_box = frame.content_box(source.size, bleed=bleed)
        if content_box[2] - content_box[0] < 32 or content_box[3] - content_box[1] < 32:
            raise RunFailed("detected source frame leaves no usable scene")
        content = source.crop(content_box)
        if untrimmed_badge is not None:
            badge = EmbeddedBadge(
                max(0, untrimmed_badge.left - bleed),
                max(0, untrimmed_badge.top - bleed),
                min(content.width, untrimmed_badge.right - bleed),
                min(content.height, untrimmed_badge.bottom - bleed),
            )
        insets = _scaled_frame_insets(frame, source.size, (w, h))
        left, top, right, bottom = insets
        inner_w, inner_h = w - left - right, h - top - bottom
        if inner_w < 64 or inner_h < 64:
            raise RunFailed("target format is too small for the detected source frame")
        working_fmt = fmt.model_copy(update={"width": inner_w, "height": inner_h})

    plate_size, (x, y) = _placement_for_format(content.size, working_fmt)

    # A source-derived underlay does not push every customer's fill toward the
    # fictional demo brand's violet, while still giving genfill a compatible base.
    swatch = content.resize((1, 1), Image.Resampling.BOX).getpixel((0, 0))
    scene = content.copy()
    badge_image: Image.Image | None = None
    if badge is not None:
        badge_image = content.crop(badge.box)
        # The old corner is no longer the final canvas corner. Remove the panel
        # from the scene input so genfill reconstructs it instead of preserving
        # a stranded lockup halfway through a portrait composition.
        scene.paste(swatch, badge.box)

    plate = scene.resize(plate_size, Image.LANCZOS)
    inner_canvas = Image.new("RGB", (working_fmt.width, working_fmt.height), swatch)
    inner_canvas.paste(plate, (x, y))

    # White = generate, black = keep. The copy-safe band is deliberately white
    # even where it overlaps the source: that is what actually recomposes a
    # breakpoint instead of shrinking the source beside an empty rectangle.
    inner_mask = Image.new("L", inner_canvas.size, 255)
    inner_mask.paste(Image.new("L", plate_size, 0), (x, y))
    if badge is not None:
        scale_x, scale_y = plate_size[0] / content.width, plate_size[1] / content.height
        old_badge_box = (
            x + round(badge.left * scale_x),
            y + round(badge.top * scale_y),
            x + round(badge.right * scale_x),
            y + round(badge.bottom * scale_y),
        )
        badge_clearance = FEATHER_SIGMA * 2
        inner_mask.paste(
            255,
            (
                max(0, old_badge_box[0] - badge_clearance),
                max(0, old_badge_box[1] - badge_clearance),
                min(working_fmt.width, old_badge_box[2] + badge_clearance),
                min(working_fmt.height, old_badge_box[3] + badge_clearance),
            ),
        )
    safe_box = _safe_area_box(working_fmt)
    if safe_box is not None:
        inner_mask.paste(255, safe_box)
    if inner_mask.getextrema() == (0, 0):
        raise RunFailed("target format leaves no area to outpaint")
    inner_mask = inner_mask.filter(ImageFilter.GaussianBlur(FEATHER_SIGMA))

    if badge is not None and badge_image is not None:
        badge_w = max(1, round(badge.size[0] * plate_size[0] / content.width))
        badge_h = max(1, round(badge.size[1] * plate_size[1] / content.height))
        rendered_badge = badge_image.resize((badge_w, badge_h), Image.Resampling.LANCZOS)
        badge_position = (working_fmt.width - badge_w, working_fmt.height - badge_h)
        inner_canvas.paste(rendered_badge, badge_position)
        inner_mask.paste(
            0,
            (
                badge_position[0],
                badge_position[1],
                working_fmt.width,
                working_fmt.height,
            ),
        )

    if frame is None:
        canvas = inner_canvas
        mask = inner_mask
    else:
        left, top, _, _ = insets
        canvas = Image.new("RGB", (w, h), frame.color)
        _paint_embedded_frame(canvas, source, frame, insets)
        canvas.paste(inner_canvas, (left, top))
        mask = Image.new("L", (w, h), 0)
        mask.paste(inner_mask, (left, top))

    cbuf, mbuf = io.BytesIO(), io.BytesIO()
    canvas.save(cbuf, format="JPEG", quality=92, subsampling=0)
    mask.save(mbuf, format="PNG")
    return cbuf.getvalue(), mbuf.getvalue()


def run_outpaint(req: RunRequest, workspace: str) -> RunOutcome:
    if req.format is None:
        raise RunFailed("outpaint requires a format")

    if req.source_b64:
        raw = base64.b64decode(req.source_b64)
    elif req.source_asset_key:
        raw = fetch_workspace_object(req.source_asset_key, workspace)
    else:
        raise RunFailed("outpaint requires source_asset_key or source_b64")

    with Image.open(io.BytesIO(raw)) as im:
        canvas_bytes, mask_bytes = _compose_for_format(im.convert("RGB"), req.format)

    params = dict(req.params)
    negative_prompt = DEFAULT_NEGATIVE
    if req.negative_prompt:
        negative_prompt = f"{DEFAULT_NEGATIVE}, {req.negative_prompt}"
    params.update(
        {
            # These exact names matter: image_url/mask_url are rejected.
            "image": base64.b64encode(canvas_bytes).decode(),
            "mask": base64.b64encode(mask_bytes).decode(),
            "negative_prompt": negative_prompt,
        }
    )

    prompt = f"{OUTPAINT_PROMPT} Safe area: {req.format.safe_area}."
    if req.prompt:
        prompt = f"{prompt} Additional background-only direction: {req.prompt}"

    # Bria Genfill is the only model proven to honour the image/mask recipe.
    run_id, attempts = _submit(OUTPAINT_MODEL, prompt, params, workspace)
    asset, prov = _collect_run_output(run_id, workspace)
    if (asset.width, asset.height) != (req.format.width, req.format.height):
        raise RunFailed(
            f"outpaint returned {asset.width}x{asset.height}; expected "
            f"{req.format.width}x{req.format.height}"
        )
    return RunOutcome(run_id=run_id, attempts=attempts, asset=asset, provenance=prov)


def _variant_score(filename: str) -> int:
    name = filename.lower()
    if "white" in name or "light" in name:
        return 3
    if any(word in name for word in ("blue", "colour", "color", "accent")):
        return 2
    if "black" in name or "dark" in name:
        return 1
    return 0


def _select_logo_assets(assets: list) -> list:
    """Choose a wordmark and symbol without asking again on the canvas.

    Brand Setup currently records role but not colour variant. Filenames are the
    only honest signal available, so prefer a light variant (most generated PEG
    plates are dark), then a brand-colour variant. Generic names still fall back
    to the first uploaded logos.
    """
    logos = [asset for asset in assets if asset.kind == "logo"]
    ranked = sorted(logos, key=lambda asset: _variant_score(asset.filename), reverse=True)
    selected: list = []

    def choose(words: tuple[str, ...]) -> None:
        match = next(
            (
                asset
                for asset in ranked
                if asset not in selected
                and any(word in asset.filename.lower() for word in words)
            ),
            None,
        )
        if match is not None:
            selected.append(match)

    choose(("wordmark", "lockup", "logotype"))
    choose(("icon", "symbol", " mark"))
    for asset in ranked:
        if len(selected) >= MAX_LOGO_REFERENCES:
            break
        if asset not in selected:
            selected.append(asset)
    return selected


def _asset_reference(asset, role: str, label: str) -> GenerationReference:
    """Fetch a saved brand asset and turn it into a Gemini-safe raster input."""
    import brand as brand_module

    try:
        raw = fetch_object(asset.asset_key)
        if brand_module.is_svg(asset.filename, asset.content_type):
            # Models consume pixels, while the approved SVG remains untouched in
            # B2 for the deterministic final composite.
            raw = cairosvg.svg2png(bytestring=raw, output_width=REFERENCE_EDGE)
        with Image.open(io.BytesIO(raw)) as image:
            image.load()
            image.thumbnail((REFERENCE_EDGE, REFERENCE_EDGE), Image.Resampling.LANCZOS)
            buf = io.BytesIO()
            if role == "style":
                image.convert("RGB").save(
                    buf, format="JPEG", quality=90, optimize=True, subsampling=0
                )
                media_type = "image/jpeg"
            else:
                image.convert("RGBA").save(buf, format="PNG", optimize=True)
                media_type = "image/png"
            raw = buf.getvalue()
    except Exception as exc:  # noqa: BLE001 — do not spend on an incomplete brand lock
        raise RunFailed(f"could not prepare brand asset {asset.filename!r}: {exc}") from exc

    return GenerationReference(
        role=role,
        label=label,
        data_b64=base64.b64encode(raw).decode(),
        media_type=media_type,
        asset_key=asset.asset_key,
    )


def _generation_brand_context(
    req: RunRequest, workspace: str
) -> tuple[str, tuple[GenerationReference, ...]]:
    """Build the automatic brand bundle for a generation.

    The workspace, not the canvas, owns durable brand assets. This is therefore
    assembled at the protected service boundary: users upload once in Brand
    Setup and every Gemini generation inherits the same labelled references.
    """
    try:
        import brand as brand_module

        current = brand_module.load_brand(workspace)
    except Exception:  # noqa: BLE001 — a workspace without a brand may still generate
        return req.prompt, ()

    prompt_parts: list[str] = []
    if current.name.strip():
        prompt_parts.append(f'Create this for the brand "{current.name.strip()}".')
    prefix = current.prompt_prefix().strip()
    if prefix:
        prompt_parts.append(prefix)
    if req.prompt.strip():
        prompt_parts.append(req.prompt.strip())

    if req.operation != "generate" or not req.model.lower().startswith("gemini-"):
        return " ".join(prompt_parts), ()

    references: list[GenerationReference] = []
    for index, asset in enumerate(
        current.style_references[:MAX_STYLE_REFERENCES], start=1
    ):
        references.append(
            _asset_reference(
                asset,
                "style",
                (
                    f"BRAND STYLE REFERENCE {index}. Borrow only its palette, lighting, "
                    "materials, graphic language, and mood. Do not copy its subject, "
                    "layout, logos, or words."
                ),
            )
        )

    selected_logos = _select_logo_assets(current.composites)
    for index, asset in enumerate(selected_logos, start=1):
        filename = asset.filename.lower()
        if any(word in filename for word in ("wordmark", "lockup", "logotype")):
            role = "primary wordmark"
        elif any(word in filename for word in ("icon", "symbol", " mark")):
            role = "brand symbol"
        else:
            role = f"approved identity asset {index}"
        references.append(
            _asset_reference(
                asset,
                "logo",
                (
                    f"APPROVED {role.upper()}. This is exact brand identity artwork. "
                    "Use its spelling, geometry, and proportions faithfully wherever "
                    "the brief calls for visible branding. Never approximate it and "
                    "never substitute branding from another reference."
                ),
            )
        )

    if selected_logos:
        prompt_parts.append(
            "Remove every source-reference logo, brand name, and piece of branded "
            "signage. The approved identity references are the only permitted brand."
        )
    return " ".join(prompt_parts), tuple(references)


def execute(req: RunRequest, workspace: str) -> RunOutcome:
    if req.operation == "compose":
        return run_compose(req, workspace)
    prompt, references = _generation_brand_context(req, workspace)
    req = req.model_copy(update={"prompt": prompt})
    if req.operation == "outpaint":
        return run_outpaint(req, workspace)
    return run_generate(req, workspace, references=references)
