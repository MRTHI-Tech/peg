"""Genblaze execution for PEG.

Everything here encodes something learned the hard way against the live APIs:

- GMI's image queue drops roughly 2 in 3 submits on the edit models, so every
  call retries with backoff.
- `Pipeline.run()` reports `status: completed` even when the asset transfer
  failed and nothing was stored, so success is verified against the bucket
  rather than trusted from the result object.
- GMI image models do not honour exact dimensions. Breakpoint expansion uses
  Bria's dedicated v2 Expand endpoint with explicit canvas and placement data.
- Protected source pixels and flattened brand chrome are finalized locally;
  the model supplies only the newly revealed scene.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

import boto3
import cairosvg
from dotenv import load_dotenv
from PIL import Image

from genblaze_core.models import Asset, Modality, StepType, parse_manifest
from genblaze_core.pipeline import Pipeline
from genblaze_core.storage import KeyStrategy, ObjectStorageSink
from genblaze_gmicloud import GMICloudImageProvider
from genblaze_s3 import S3StorageBackend

from schemas import AssetOut, ProvenanceOut, RunRequest
from bria_expand import BriaExpandProvider
from compositor import PegCompositorProvider
from expand_geometry import (
    clear_safe_areas,
    finalize_expand,
    prepare_expand,
    safe_area_overlap,
)

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
EXPAND_MODEL = "bria-expand-v2"
MAX_STYLE_REFERENCES = 3
MAX_LOGO_REFERENCES = 2
REFERENCE_EDGE = 1024

# The most of a copy-safe band that may sit on protected source pixels when no
# other band can do better. A fully clear band is unreachable whenever the
# target's aspect ratio is close to the source's — 1:1 into 4:5 frees less new
# height than a third of the canvas — so refusing every overlap made whole
# presets unusable. Past half the band there is no useful copy space left.
#
# Half rather than the 40% the observed cases needed: a square source in a 4:5
# portrait lands on exactly 0.40, and a threshold a rounding error away from the
# preset it exists to allow is not a threshold.
SAFE_AREA_MAX_OVERLAP = 0.50

# Duplicate subjects and brand chrome in expanded pixels are always failures.
DEFAULT_NEGATIVE = (
    "podium, pedestal, cylinder, platform, pillar, object, product, duplicate, "
    "repeated shapes, cloned object, extra product, extra podium, text, logo, "
    "watermark, seam, hard edge, border, inset image, picture-in-picture, card, "
    "poster, panel, framed image"
)

EXPAND_PROMPT = (
    "Continue the existing scene naturally through the newly revealed canvas as one "
    "continuous edge-to-edge photograph. Match its camera, perspective, lighting, "
    "colour, depth, and texture. Keep the expanded background calm and low-detail for "
    "copy. Add no new subjects and do not duplicate anything already in the source."
)


@dataclass
class RunOutcome:
    run_id: str
    attempts: int
    asset: AssetOut
    provenance: ProvenanceOut
    # Non-fatal notes about the result the user should see. A run that produced
    # a real asset must never be reported as failed, so these ride alongside a
    # successful outcome rather than becoming an error.
    warnings: list[str] = field(default_factory=list)


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


def run_outpaint(req: RunRequest, workspace: str) -> RunOutcome:
    if req.format is None:
        raise RunFailed("outpaint requires a format")

    api_token = os.environ.get("BRIA_API_TOKEN", "").strip()
    if not api_token:
        raise RunFailed(
            "Extend Canvas is not configured: add BRIA_API_TOKEN to peg-service"
        )

    if req.source_b64:
        raw = base64.b64decode(req.source_b64)
        source_key = f"inline-sha256:{hashlib.sha256(raw).hexdigest()}"
    elif req.source_asset_key:
        raw = fetch_workspace_object(req.source_asset_key, workspace)
        source_key = req.source_asset_key
    else:
        raise RunFailed("outpaint requires source_asset_key or source_b64")

    with Image.open(io.BytesIO(raw)) as im:
        # convert() detaches from the file handle, so this survives the close
        # and can be re-planned when a safe area needs alternatives suggested.
        source = im.convert("RGB")
    plan = prepare_expand(source, req.format)

    # Whether an overlap is acceptable depends on what else was available, not
    # on the raw number. If some other band clears the source completely, say so
    # and refuse — using a worse one would be a silent downgrade. If nothing
    # clears it, the best band on offer is the only copy space there is, so a
    # partial overlap becomes a warning rather than a dead end.
    warnings: list[str] = []
    overlap = safe_area_overlap(plan)
    if overlap.overlaps:
        alternatives = clear_safe_areas(source, req.format)
        if alternatives:
            raise RunFailed(
                f"{req.format.safe_area} safe area is {overlap.ratio:.0%} covered by "
                f"protected source pixels; try {' or '.join(alternatives)} instead"
            )
        if overlap.ratio > SAFE_AREA_MAX_OVERLAP:
            raise RunFailed(
                f"{req.format.safe_area} safe area is {overlap.ratio:.0%} covered by "
                "protected source pixels and no other safe area clears this source; "
                "expand to a taller or wider canvas, or start from a source with a "
                "different aspect ratio"
            )
        warnings.append(
            f"{req.format.safe_area} safe area is {overlap.ratio:.0%} covered by "
            "source pixels — no safe area clears this source at this target, so "
            "check headline legibility over that edge"
        )
    if plan.original_image_size == plan.canvas_size and plan.original_image_location == (0, 0):
        raise RunFailed("target format does not extend the source canvas")

    negative_prompt = DEFAULT_NEGATIVE
    if req.negative_prompt:
        negative_prompt = f"{DEFAULT_NEGATIVE}, {req.negative_prompt}"
    prompt = EXPAND_PROMPT
    if req.prompt:
        prompt = f"{prompt} Additional background-only direction: {req.prompt.strip()}"

    params = plan.provider_params()
    params["negative_prompt"] = negative_prompt
    seed = req.params.get("seed")
    if seed is not None:
        params["seed"] = seed

    with tempfile.TemporaryDirectory(prefix="peg-expand-") as temp:
        directory = Path(temp)
        source = _staged_asset(directory, "source", source_key, plan.model_input)
        with BriaExpandProvider(
            api_token,
            directory,
            input_roots=(directory,),
            finalize_output=lambda expanded: finalize_expand(expanded, plan),
        ) as provider:
            result = (
                Pipeline("peg-expand", preflight=False)
                .step(
                    provider,
                    model=EXPAND_MODEL,
                    prompt=prompt,
                    modality=Modality.IMAGE,
                    step_type=StepType.EDIT,
                    external_inputs=[source],
                    params=params,
                    metadata={
                        "operation": "canvas-expand",
                        "workspace_prefix": workspace_prefix(workspace),
                        "safe_area": req.format.safe_area,
                        "focal_point": req.format.focal_point,
                    },
                )
                .run(sink=_sink(workspace), timeout=420, raise_on_failure=True)
            )
            run = getattr(result, "run", result)
            run_id = str(getattr(run, "run_id", ""))

    asset, prov = _collect_run_output(run_id, workspace)
    if (asset.width, asset.height) != (req.format.width, req.format.height):
        raise RunFailed(
            f"outpaint returned {asset.width}x{asset.height}; expected "
            f"{req.format.width}x{req.format.height}"
        )
    return RunOutcome(
        run_id=run_id, attempts=1, asset=asset, provenance=prov, warnings=warnings
    )


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
