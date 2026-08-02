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

# Mask feathering, in pixels, so the outpaint boundary is not a hard seam.
FEATHER_SIGMA = 16

# Without this, genfill cheerfully paints copies of the subject into the space
# that was supposed to stay empty for the headline.
DEFAULT_NEGATIVE = (
    "duplicate, repeated shapes, cloned object, extra product, extra podium, "
    "text, logo, watermark, seam, hard edge, border"
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

        # Verification must come from Genblaze, not a guess at which fields are
        # populated: presence of a `signature` key says nothing about validity,
        # and reporting a valid manifest as unverified would undercut the whole
        # provenance story.
        try:
            # parse_manifest wants the decoded dict, not the JSON text.
            prov.verified = parse_manifest(json.loads(raw)).verify()
        except Exception:  # noqa: BLE001
            prov.verified = None

    return asset, prov


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


def _compose_for_format(source: Image.Image, fmt: FormatSpec) -> tuple[bytes, bytes]:
    """Seat the plate at the focal point on a target canvas; mask the rest.

    Returns (canvas_jpeg, mask_png). JPEG for the canvas because a PNG of a
    smooth gradient is ~3x the bytes and the endpoint is size-sensitive.
    """
    w, h = fmt.width, fmt.height
    # Cover the short edge so the plate fills the canvas height.
    scale = h / source.height
    plate = source.resize((max(1, round(source.width * scale)), h), Image.LANCZOS)
    plate_w = plate.width

    if fmt.focal_point == "left":
        x = 0
    elif fmt.focal_point == "center":
        x = (w - plate_w) // 2
    else:
        x = w - plate_w

    canvas = Image.new("RGB", (w, h), (10, 4, 20))
    canvas.paste(plate, (x, 0))

    # White = generate, black = keep. Feathered so the join is not a visible seam.
    mask = Image.new("L", (w, h), 255)
    mask.paste(Image.new("L", (plate_w, h), 0), (x, 0))
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
    params.update(
        {
            # These exact names matter: image_url/mask_url are rejected.
            "image": base64.b64encode(canvas_bytes).decode(),
            "mask": base64.b64encode(mask_bytes).decode(),
            "negative_prompt": req.negative_prompt or DEFAULT_NEGATIVE,
        }
    )

    prompt = req.prompt or (
        "Empty gradient backdrop matching the existing scene, smooth vignette falloff, "
        "faint particle sparkle, completely bare with nothing in it"
    )
    run_id, attempts = _submit(req.model or "bria-genfill", prompt, params)
    asset, prov = _collect_run_output(run_id)
    return RunOutcome(run_id=run_id, attempts=attempts, asset=asset, provenance=prov)


def execute(req: RunRequest) -> RunOutcome:
    if req.operation == "outpaint":
        return run_outpaint(req)
    return run_generate(req)
