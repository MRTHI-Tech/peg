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
import io
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path

import boto3
from dotenv import load_dotenv
from PIL import Image, ImageFilter

from genblaze_core.models import Modality, parse_manifest
from genblaze_core.pipeline import Pipeline
from genblaze_core.storage import KeyStrategy, ObjectStorageSink
from genblaze_gmicloud import GMICloudImageProvider
from genblaze_s3 import S3StorageBackend

from schemas import AssetOut, FormatSpec, ProvenanceOut, RunRequest

load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")

PREFIX = "peg"
MAX_ATTEMPTS = 3
PRESIGN_TTL = 60 * 60 * 12
OUTPAINT_MODEL = "bria-genfill"

# Mask feathering, in pixels, so the outpaint boundary is not a hard seam.
FEATHER_SIGMA = 16

# Without this, genfill cheerfully paints copies of the subject into the space
# that was supposed to stay empty for the headline.
DEFAULT_NEGATIVE = (
    "podium, pedestal, cylinder, platform, pillar, object, product, duplicate, "
    "repeated shapes, cloned object, extra product, extra podium, text, logo, "
    "watermark, seam, hard edge, border"
)

OUTPAINT_PROMPT = (
    "Continue only the existing empty background into the generated area. Match the "
    "source palette, lighting, materials, depth, and perspective exactly. Keep the "
    "declared safe area calm and low-detail. Add no subjects, products, typography, "
    "logos, podiums, platforms, or repeated objects."
)


@dataclass
class RunOutcome:
    run_id: str
    attempts: int
    asset: AssetOut
    provenance: ProvenanceOut


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


def _sink() -> ObjectStorageSink:
    backend = S3StorageBackend.for_backblaze(
        _bucket(),
        region=os.environ["B2_REGION"],
        key_id=os.environ["B2_KEY_ID"],
        app_key=os.environ["B2_APP_KEY"],
    )
    return ObjectStorageSink(backend, prefix=PREFIX, key_strategy=KeyStrategy.HIERARCHICAL)


def _provider() -> GMICloudImageProvider:
    return GMICloudImageProvider(api_key=os.environ["GMI_API_KEY"])


def fetch_object(key: str) -> bytes:
    return _s3().get_object(Bucket=_bucket(), Key=key)["Body"].read()


def _collect_run_output(run_id: str) -> tuple[AssetOut, ProvenanceOut]:
    """Find what a run actually stored. Raises if nothing landed.

    Genblaze reports success even when the transfer failed, so this is the real
    success check.
    """
    s3, bucket = _s3(), _bucket()
    keys = [
        o["Key"]
        for o in s3.list_objects_v2(Bucket=bucket, Prefix=f"{PREFIX}/runs/").get("Contents", [])
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


def _submit(model: str, prompt: str, params: dict) -> tuple[str, int]:
    """Run one step with retry. Returns (run_id, attempts_used)."""
    last: Exception | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            result = (
                Pipeline("peg", preflight=False)
                .step(
                    _provider(),
                    model=model,
                    prompt=prompt,
                    modality=Modality.IMAGE,
                    params=params,
                )
                .run(sink=_sink(), timeout=420, raise_on_failure=True)
            )
            run = getattr(result, "run", result)
            return str(getattr(run, "run_id", "")), attempt
        except Exception as exc:  # noqa: BLE001
            last = exc
            msg = str(exc).lower()
            # A rejected model or missing entitlement will not fix itself.
            if any(s in msg for s in ("not found", "unknown model", "no access", "invalid payload")):
                break
            if attempt < MAX_ATTEMPTS:
                time.sleep(4 * attempt)
    raise RunFailed(f"submit failed after retries: {last}")


# ------------------------------------------------------------------ operations


def run_generate(req: RunRequest) -> RunOutcome:
    params: dict = dict(req.params)
    if req.negative_prompt:
        params["negative_prompt"] = req.negative_prompt
    if req.image_b64:
        params["image"] = req.image_b64

    run_id, attempts = _submit(req.model, req.prompt, params)
    asset, prov = _collect_run_output(run_id)
    return RunOutcome(run_id=run_id, attempts=attempts, asset=asset, provenance=prov)


def _content_rect(fmt: FormatSpec) -> tuple[int, int, int, int]:
    """Return the two-thirds content zone opposite the protected safe band."""
    w, h = fmt.width, fmt.height
    if fmt.safe_area == "left-third":
        safe = w // 3
        return safe, 0, w - safe, h
    if fmt.safe_area == "right-third":
        safe = w // 3
        return 0, 0, w - safe, h
    if fmt.safe_area == "upper-third":
        safe = h // 3
        return 0, safe, w, h - safe
    if fmt.safe_area == "lower-third":
        safe = h // 3
        return 0, 0, w, h - safe

    # A centered safe region has no single rectangular complement. Treat it as
    # prompt-only until Format exposes a richer two-dimensional focal point.
    return 0, 0, w, h


def _placement_for_format(
    source_size: tuple[int, int], fmt: FormatSpec
) -> tuple[tuple[int, int], tuple[int, int]]:
    """Contain the complete plate in the content zone and return (size, position)."""
    source_w, source_h = source_size
    if source_w <= 0 or source_h <= 0:
        raise RunFailed("source image has invalid dimensions")

    zone_x, zone_y, zone_w, zone_h = _content_rect(fmt)
    scale = min(zone_w / source_w, zone_h / source_h)
    plate_w = min(zone_w, max(1, round(source_w * scale)))
    plate_h = min(zone_h, max(1, round(source_h * scale)))

    if fmt.focal_point == "left":
        x = zone_x
    elif fmt.focal_point == "center":
        x = zone_x + (zone_w - plate_w) // 2
    else:
        x = zone_x + zone_w - plate_w

    if fmt.safe_area == "upper-third":
        y = zone_y + zone_h - plate_h
    elif fmt.safe_area == "lower-third":
        y = zone_y
    else:
        y = zone_y + (zone_h - plate_h) // 2

    return (plate_w, plate_h), (x, y)


def _compose_for_format(source: Image.Image, fmt: FormatSpec) -> tuple[bytes, bytes]:
    """Seat the whole plate outside the safe band; mask everything else.

    Returns (canvas_jpeg, mask_png). JPEG for the canvas because a PNG of a
    smooth gradient is ~3x the bytes and the endpoint is size-sensitive.
    """
    w, h = fmt.width, fmt.height
    plate_size, (x, y) = _placement_for_format(source.size, fmt)
    plate = source.resize(plate_size, Image.LANCZOS)

    # A source-derived underlay does not push every customer's fill toward the
    # fictional demo brand's violet, while still giving genfill a compatible base.
    swatch = source.resize((1, 1), Image.Resampling.BOX).getpixel((0, 0))
    canvas = Image.new("RGB", (w, h), swatch)
    canvas.paste(plate, (x, y))

    # White = generate, black = keep. Feathered so the join is not a visible seam.
    mask = Image.new("L", (w, h), 255)
    mask.paste(Image.new("L", plate_size, 0), (x, y))
    if mask.getextrema() == (0, 0):
        raise RunFailed("target format leaves no area to outpaint")
    mask = mask.filter(ImageFilter.GaussianBlur(FEATHER_SIGMA))

    cbuf, mbuf = io.BytesIO(), io.BytesIO()
    canvas.save(cbuf, format="JPEG", quality=92, subsampling=0)
    mask.save(mbuf, format="PNG")
    return cbuf.getvalue(), mbuf.getvalue()


def run_outpaint(req: RunRequest) -> RunOutcome:
    if req.format is None:
        raise RunFailed("outpaint requires a format")

    if req.source_b64:
        raw = base64.b64decode(req.source_b64)
    elif req.source_asset_key:
        raw = fetch_object(req.source_asset_key)
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
    run_id, attempts = _submit(OUTPAINT_MODEL, prompt, params)
    asset, prov = _collect_run_output(run_id)
    if (asset.width, asset.height) != (req.format.width, req.format.height):
        raise RunFailed(
            f"outpaint returned {asset.width}x{asset.height}; expected "
            f"{req.format.width}x{req.format.height}"
        )
    return RunOutcome(run_id=run_id, attempts=attempts, asset=asset, provenance=prov)


def execute(req: RunRequest) -> RunOutcome:
    if req.operation == "outpaint":
        return run_outpaint(req)
    return run_generate(req)
