"""Outpaint a square plate into a wide hero banner.

Why this matters: GMI ignores every dimension parameter and always returns
2048x2048 (see AGENTS.md). If we cannot outpaint to a target breakpoint, the
"compose per breakpoint, never crop" thesis does not hold.

The test: take the square plate, seat it on the right of a 1920x600 canvas at
the focal point, mask the empty left region, and have bria-genfill paint the
brand environment into it — leaving clear space for a headline.

    ./service/.venv/bin/python service/outpaint_test.py
"""

from __future__ import annotations

import base64
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env.local")

import boto3  # noqa: E402
from PIL import Image, ImageFilter  # noqa: E402

from genblaze_core.models import Modality  # noqa: E402
from genblaze_core.pipeline import Pipeline  # noqa: E402
from genblaze_core.storage import KeyStrategy, ObjectStorageSink  # noqa: E402
from genblaze_gmicloud import GMICloudImageProvider  # noqa: E402
from genblaze_s3 import S3StorageBackend  # noqa: E402

SCRATCH = Path("/private/tmp/claude-501/-Users-tlotliso-Desktop-peg2/d36090e6-55b9-4763-b1fb-56c7d29c2439/scratchpad")

TARGET_W, TARGET_H = 1920, 600
SOURCE = SCRATCH / "smoke.jpg"

PROMPT = (
    "Empty deep violet to magenta gradient backdrop, smooth vignette falloff, faint "
    "particle sparkle, soft volumetric haze, completely bare studio backdrop with "
    "nothing in it, flat open wall of colour"
)

# The first attempt duplicated the podiums into the fill region. Naming the
# objects explicitly is what keeps the headline area clear.
NEGATIVE_PROMPT = (
    "podium, pedestal, cylinder, platform, pillar, object, product, duplicate, "
    "repeated shapes, reflection of podium, text, logo, watermark, seam, hard edge"
)

# Feathering the mask edge hides the boundary between kept and generated pixels.
FEATHER_PX = 48


def s3_client():
    return boto3.client(
        "s3",
        endpoint_url=f"https://s3.{os.environ['B2_REGION']}.backblazeb2.com",
        aws_access_key_id=os.environ["B2_KEY_ID"],
        aws_secret_access_key=os.environ["B2_APP_KEY"],
        region_name=os.environ["B2_REGION"],
    )


def stage(path: Path, key: str) -> str:
    """Upload to B2 and return a presigned URL GMI can fetch."""
    s3 = s3_client()
    bucket = os.environ["B2_BUCKET"]
    s3.upload_file(str(path), bucket, key)
    return s3.generate_presigned_url(
        "get_object", Params={"Bucket": bucket, "Key": key}, ExpiresIn=3600
    )


def build_canvas_and_mask() -> tuple[Path, Path]:
    """Seat the square plate at the right; mask everything else for filling."""
    src = Image.open(SOURCE).convert("RGB")
    scaled = src.resize((TARGET_H, TARGET_H), Image.LANCZOS)  # 600x600

    canvas = Image.new("RGB", (TARGET_W, TARGET_H), (10, 4, 20))
    paste_x = TARGET_W - TARGET_H  # flush right — Format focalPoint = "Right"
    canvas.paste(scaled, (paste_x, 0))

    # White = generate here, black = keep. Blurring the boundary lets the model
    # blend across it instead of leaving a hard vertical seam.
    mask = Image.new("L", (TARGET_W, TARGET_H), 255)
    mask.paste(Image.new("L", (TARGET_H, TARGET_H), 0), (paste_x, 0))
    mask = mask.filter(ImageFilter.GaussianBlur(FEATHER_PX / 3))

    # JPEG, not PNG. A 1920x600 PNG of a smooth gradient is ~230KB, which is
    # ~310KB base64 — and GMI's endpoint dropped 3 of 4 submits at that size
    # (connection reset / server disconnected / broken pipe mid-transfer).
    # JPEG q92 is visually identical here and roughly a quarter of the bytes.
    cpath, mpath = SCRATCH / "outpaint_input.jpg", SCRATCH / "outpaint_mask.png"
    canvas.save(cpath, quality=92, subsampling=0)
    mask.save(mpath)
    print(f"canvas {canvas.size} with plate at x={paste_x}, mask fills 0..{paste_x}px")
    return cpath, mpath


def main() -> int:
    if not SOURCE.exists():
        print(f"missing {SOURCE} — run smoke_test.py first")
        return 1

    cpath, mpath = build_canvas_and_mask()
    # Presigned B2 URLs got the connection reset on submit; base64 is what the
    # Bria endpoints actually want. ~310KB encoded, well within limits.
    image_b64 = base64.b64encode(cpath.read_bytes()).decode()
    mask_b64 = base64.b64encode(mpath.read_bytes()).decode()
    print(f"payload: image {len(image_b64):,} chars, mask {len(mask_b64):,} chars")

    backend = S3StorageBackend.for_backblaze(
        os.environ["B2_BUCKET"],
        region=os.environ["B2_REGION"],
        key_id=os.environ["B2_KEY_ID"],
        app_key=os.environ["B2_APP_KEY"],
    )
    sink = ObjectStorageSink(backend, prefix="peg-outpaint", key_strategy=KeyStrategy.HIERARCHICAL)
    provider = GMICloudImageProvider(api_key=os.environ["GMI_API_KEY"])

    # GMI drops submits intermittently at this payload size, so retry rather than
    # treating one network hiccup as a verdict on the approach.
    result = None
    for attempt in range(1, 4):
        print(f"submitting genfill (attempt {attempt}/3)…")
        try:
            result = (
                Pipeline("peg-outpaint", preflight=False)
                .step(
                    provider,
                    model="bria-genfill",
                    prompt=PROMPT,
                    modality=Modality.IMAGE,
                    # The API rejects image_url/mask_url as missing — it wants
                    # `image` and `mask`, base64-encoded.
                    params={
                        "image": image_b64,
                        "mask": mask_b64,
                        "negative_prompt": NEGATIVE_PROMPT,
                        "seed": 285241,
                    },
                )
                .run(sink=sink, timeout=420, raise_on_failure=True)
            )
            break
        except Exception as exc:  # noqa: BLE001
            print(f"  attempt {attempt} failed: {type(exc).__name__}: {str(exc)[:120]}")
            if attempt == 3:
                print("\n[FAIL] all 3 attempts failed")
                return 1
            time.sleep(5 * attempt)

    run = getattr(result, "run", result)
    print(f"[ok] status={getattr(run, 'status', '?')} run_id={getattr(run, 'run_id', '?')}")

    # The run reports success even when nothing lands, so verify against the bucket.
    s3, bucket = s3_client(), os.environ["B2_BUCKET"]
    objs = [
        o
        for o in s3.list_objects_v2(Bucket=bucket, Prefix="peg-outpaint/").get("Contents", [])
        if o["Key"].endswith((".jpg", ".png"))
    ]
    if not objs:
        print("[FAIL] run reported success but no asset landed in B2")
        return 1

    newest = max(objs, key=lambda o: o["LastModified"])
    out = SCRATCH / "outpaint_result.png"
    s3.download_file(bucket, newest["Key"], str(out))
    print(f"  {newest['Key']}")
    print(f"  result size: {Image.open(out).size}  (target {TARGET_W}x{TARGET_H})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
