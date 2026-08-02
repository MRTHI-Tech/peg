"""Dump the real GMI Cloud model catalog.

Why this exists: the static registry shipped in genblaze-gmicloud 0.3.5 seeds only
8 image models (all edit/inpaint). The rest of the catalog — including the
text-to-image and reference-conditioned models our node catalog assumes — is
discovered from the GMI API at runtime, which needs a live key.

Run this before trusting any model id in lib/catalog.ts.

    ./service/.venv/bin/python service/discover_models.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env.local")

# Model ids lib/catalog.ts currently claims exist, so we can diff against reality.
CATALOG_CLAIMS = [
    "seedream-5.0-lite",
    "flux-kontext-pro",
    "bria-fibo-image-blend",
    "reve-remix-20250915",
    "seededit-3-0-i2i-250628",
    "bria-genfill",
    "bria-eraser",
    "bria-fibo-relight",
]


def main() -> int:
    key = os.environ.get("GMI_API_KEY", "").strip()
    if not key:
        print("GMI_API_KEY is not set in .env.local — cannot discover.")
        return 1

    from genblaze_gmicloud import GMICloudImageProvider

    provider = GMICloudImageProvider(api_key=key)

    print("Static registry (ships with the SDK)")
    static = sorted(provider.models.known())
    for name in static:
        print(f"  {name}")

    print(f"\nDiscovery support: {provider.discovery_support}")
    print("\nDiscovering from the GMI API…")
    try:
        discovered = provider.discover_models()
    except Exception as exc:  # noqa: BLE001
        print(f"  [FAIL] {type(exc).__name__}: {exc}")
        return 1

    names = sorted({getattr(m, "model_id", None) or str(m) for m in discovered})
    print(f"  {len(names)} models returned\n")
    for name in names:
        print(f"  {name}")

    available = set(static) | set(names)
    print("\nOur catalog vs reality")
    missing = []
    for claim in CATALOG_CLAIMS:
        if claim in available:
            print(f"  [ok]      {claim}")
        else:
            print(f"  [MISSING] {claim}")
            missing.append(claim)

    if missing:
        print(f"\n{len(missing)} model id(s) in lib/catalog.ts do not exist. Fix them before wiring.")
    else:
        print("\nEvery model id in lib/catalog.ts resolves.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
