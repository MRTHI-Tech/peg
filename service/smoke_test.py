"""End-to-end smoke test: GMI generation -> B2 storage -> signed manifest.

Proves the whole socket works before any of it is wired into the UI. Also
resolves which model ids actually run, since GMICloud's image queue accepts
unknown models (the SDK registry is a pricing/param seed, not an allowlist) and
the only honest way to know is to submit one.

    ./service/.venv/bin/python service/smoke_test.py [model-id]
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env.local")

from genblaze_core.models import Modality  # noqa: E402
from genblaze_core.pipeline import Pipeline  # noqa: E402
from genblaze_core.storage import KeyStrategy, ObjectStorageSink  # noqa: E402
from genblaze_gmicloud import GMICloudImageProvider  # noqa: E402
from genblaze_s3 import S3StorageBackend  # noqa: E402

DEFAULT_MODEL = "seedream-5.0-lite"

PROMPT = (
    "Deep violet to magenta gradient studio environment, dark falloff at the edges, "
    "glossy reflective cylindrical podiums, hard rim lighting, fine particle sparkle, "
    "high specular highlights, generous empty space on the left, product hero lighting, "
    "no text, no logos"
)


def build_sink() -> ObjectStorageSink:
    backend = S3StorageBackend.for_backblaze(
        os.environ["B2_BUCKET"],
        region=os.environ["B2_REGION"],
        key_id=os.environ["B2_KEY_ID"],
        app_key=os.environ["B2_APP_KEY"],
    )
    return ObjectStorageSink(backend, prefix="peg", key_strategy=KeyStrategy.HIERARCHICAL)


def main() -> int:
    model = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_MODEL
    print(f"model:  {model}")
    print(f"bucket: {os.environ['B2_BUCKET']} ({os.environ['B2_REGION']})\n")

    provider = GMICloudImageProvider(api_key=os.environ["GMI_API_KEY"])
    sink = build_sink()

    # preflight=False: the model may legitimately be absent from the local
    # registry and still be served by the queue.
    pipeline = Pipeline("peg-smoke-test", preflight=False).step(
        provider,
        model=model,
        prompt=PROMPT,
        modality=Modality.IMAGE,
        params={"resolution": "1536x640", "seed": 285241, "number_of_images": 1},
    )

    print("submitting…")
    try:
        result = pipeline.run(sink=sink, timeout=300)
    except Exception as exc:  # noqa: BLE001
        print(f"\n[FAIL] {type(exc).__name__}: {exc}")
        return 1

    print("\n[ok] run complete")
    run = getattr(result, "run", result)
    print(f"  run_id: {getattr(run, 'run_id', '?')}")
    print(f"  status: {getattr(run, 'status', '?')}")

    assets = getattr(result, "assets", None) or []
    for a in assets:
        print("\n  asset")
        for field in ("url", "uri", "sha256", "mime_type", "modality", "bytes"):
            if hasattr(a, field):
                print(f"    {field}: {getattr(a, field)}")

    manifest = getattr(result, "manifest", None)
    if manifest is not None:
        print("\n  manifest")
        for field in ("run_id", "sha256", "created_at"):
            if hasattr(manifest, field):
                print(f"    {field}: {getattr(manifest, field)}")
        if hasattr(manifest, "verify"):
            try:
                print(f"    verify(): {manifest.verify()}")
            except Exception as exc:  # noqa: BLE001
                print(f"    verify() raised: {exc}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
