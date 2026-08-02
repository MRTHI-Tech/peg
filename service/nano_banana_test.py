"""Can a Gemini image model render brand-accurate text and marks?

The working assumption so far has been "diffusion cannot render your product,
composite it instead". That was formed on older diffusion behaviour. The Gemini
image family (nano-banana) is markedly better at legible text and at preserving
a supplied reference, and GMI Cloud is a launch partner for it — so the
assumption is worth retesting before we commit to compositing everywhere.

Test: ask for a product card carrying an exact wordmark, in our brand style.
If the text comes back crisp and correctly spelled, the composite-only rule is
too strict and generation becomes viable for some brand elements.

    ./service/.venv/bin/python service/nano_banana_test.py [model-id]
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env.local")

import boto3  # noqa: E402
from PIL import Image  # noqa: E402

from genblaze_core.models import Modality  # noqa: E402
from genblaze_core.pipeline import Pipeline  # noqa: E402
from genblaze_core.storage import KeyStrategy, ObjectStorageSink  # noqa: E402
from genblaze_gmicloud import GMICloudImageProvider  # noqa: E402
from genblaze_s3 import S3StorageBackend  # noqa: E402

SCRATCH = Path("/private/tmp/claude-501/-Users-tlotliso-Desktop-peg2/d36090e6-55b9-4763-b1fb-56c7d29c2439/scratchpad")

# Candidates, cheapest first. GMI is a day-zero partner for the Lite variant.
CANDIDATES = [
    "gemini-3.1-flash-lite-image",
    "gemini-3.1-flash-image",
    "gemini-2.5-flash-image",
    "gemini-3-pro-image",
]

PROMPT = (
    "Studio product shot of a single matte black bank card floating at a slight angle "
    "above a glossy reflective podium. Deep violet to magenta gradient background, dark "
    "falloff, hard rim lighting, fine particle sparkle. The card face carries the "
    'wordmark "PEG" in clean bold sans-serif type, and below it the smaller text '
    '"BRAND STUDIO". The text must be sharp, correctly spelled and perfectly legible.'
)


def run(model: str) -> bool:
    provider = GMICloudImageProvider(api_key=os.environ["GMI_API_KEY"])
    backend = S3StorageBackend.for_backblaze(
        os.environ["B2_BUCKET"],
        region=os.environ["B2_REGION"],
        key_id=os.environ["B2_KEY_ID"],
        app_key=os.environ["B2_APP_KEY"],
    )
    sink = ObjectStorageSink(backend, prefix="peg-nb", key_strategy=KeyStrategy.HIERARCHICAL)

    for attempt in range(1, 4):
        try:
            (
                Pipeline("peg-nano-banana", preflight=False)
                .step(provider, model=model, prompt=PROMPT, modality=Modality.IMAGE, params={"seed": 7})
                .run(sink=sink, timeout=420, raise_on_failure=True)
            )
            return True
        except Exception as exc:  # noqa: BLE001
            msg = str(exc)
            print(f"    attempt {attempt}: {type(exc).__name__}: {msg[:140]}")
            # A missing/unknown model will not fix itself on retry.
            if any(s in msg.lower() for s in ("not found", "unknown model", "does not exist", "no access")):
                return False
            if attempt < 3:
                time.sleep(5 * attempt)
    return False


def main() -> int:
    models = [sys.argv[1]] if len(sys.argv) > 1 else CANDIDATES
    s3 = boto3.client(
        "s3",
        endpoint_url=f"https://s3.{os.environ['B2_REGION']}.backblazeb2.com",
        aws_access_key_id=os.environ["B2_KEY_ID"],
        aws_secret_access_key=os.environ["B2_APP_KEY"],
        region_name=os.environ["B2_REGION"],
    )
    bucket = os.environ["B2_BUCKET"]
    before = {o["Key"] for o in s3.list_objects_v2(Bucket=bucket, Prefix="peg-nb/").get("Contents", [])}

    for model in models:
        print(f"\n=== {model} ===")
        if not run(model):
            print("  unavailable")
            continue

        objs = [
            o
            for o in s3.list_objects_v2(Bucket=bucket, Prefix="peg-nb/").get("Contents", [])
            if o["Key"] not in before and o["Key"].endswith((".jpg", ".png"))
        ]
        if not objs:
            print("  reported success but nothing landed")
            continue

        newest = max(objs, key=lambda o: o["LastModified"])
        out = SCRATCH / "nano_banana.png"
        s3.download_file(bucket, newest["Key"], str(out))
        print(f"  [ok] {newest['Key']}")
        print(f"  size: {Image.open(out).size}")
        print(f"  saved: {out}")
        return 0

    print("\nNo Gemini image model was reachable through GMI.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
