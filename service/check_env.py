"""Verify credentials before anything else runs.

Checks that the required environment variables are present, then makes one live
call per service to confirm the keys actually work. Prints masked values only —
never the secrets themselves.

    ./service/.venv/bin/python service/check_env.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env.local")

REQUIRED = ["GMI_API_KEY", "B2_KEY_ID", "B2_APP_KEY", "B2_BUCKET", "B2_REGION"]
OPTIONAL = ["BRIA_API_TOKEN", "GEMINI_API_KEY", "GMI_BASE_URL"]


def mask(value: str) -> str:
    """Show only enough to tell two keys apart."""
    if len(value) <= 8:
        return "*" * len(value)
    return f"{value[:4]}…{value[-4:]} ({len(value)} chars)"


def check_present() -> list[str]:
    print("Environment")
    missing = []
    for name in REQUIRED:
        value = os.environ.get(name, "").strip()
        if value:
            print(f"  [ok]      {name:16} {mask(value)}")
        else:
            print(f"  [MISSING] {name:16} required")
            missing.append(name)
    for name in OPTIONAL:
        value = os.environ.get(name, "").strip()
        state = mask(value) if value else "not set (optional)"
        print(f"  [--]      {name:16} {state}")
    return missing


def check_gmi() -> bool:
    print("\nGMI Cloud")
    try:
        from genblaze_gmicloud import GMICloudImageProvider

        provider = GMICloudImageProvider(api_key=os.environ["GMI_API_KEY"])
        provider.preflight_auth()
        print("  [ok]      authenticated")
        return True
    except Exception as exc:  # noqa: BLE001 — surfacing the raw cause is the point
        print(f"  [FAIL]    {type(exc).__name__}: {exc}")
        return False


def check_b2() -> bool:
    print("\nBackblaze B2")
    try:
        from genblaze_s3 import S3StorageBackend

        S3StorageBackend.for_backblaze(
            os.environ["B2_BUCKET"],
            region=os.environ["B2_REGION"],
            key_id=os.environ["B2_KEY_ID"],
            app_key=os.environ["B2_APP_KEY"],
            preflight=True,
        )
        print(f"  [ok]      bucket '{os.environ['B2_BUCKET']}' reachable and writable")
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"  [FAIL]    {type(exc).__name__}: {exc}")
        return False


def main() -> int:
    missing = check_present()
    if missing:
        print(f"\nFill these in {ROOT / '.env.local'} then re-run:")
        for name in missing:
            print(f"  {name}=")
        return 1

    ok = check_gmi()
    ok = check_b2() and ok

    print("\n" + ("All checks passed." if ok else "Some checks failed — see above."))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
