"""The brand kit: what PEG locks every generation against.

Stored as a single JSON document in B2 rather than a database — the bucket is
already the asset library, and a brand is one small document per workspace.

Two deliberate separations, because collapsing them makes output worse:

- **Style references vs logos.** A style reference teaches the model palette,
  lighting, and materials. A logo fed in the same way produces garbled logo-ish
  shapes. Logos exist to be *composited* on top, never to condition generation.
- **Typography is metadata, not a generation input.** No image model reproduces
  a specific typeface. Fonts are captured for the live-text layer that sits over
  the plate; they are never sent to a model.
"""

from __future__ import annotations

import base64
import binascii
import io
import json
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone

from PIL import Image

import runner

BRAND_KEY = "peg/brand/brand.json"
STYLE_PREFIX = "peg/brand/style"
LOGO_PREFIX = "peg/brand/logos"

# Sampled down before quantizing: full-resolution counting is slow and the
# dominant colours do not change.
SAMPLE_EDGE = 200
PALETTE_SIZE = 6
MAX_UPLOAD_BYTES = 12 * 1024 * 1024

# Quantizing alone returns near-duplicates — three barely-different violets read
# as three palette entries. Colours closer than this in RGB are treated as one,
# so the extracted palette is the handful a designer would actually name.
MIN_COLOR_DISTANCE = 48
# Over-quantize, then merge down: asking for exactly PALETTE_SIZE buckets and
# deduping would leave fewer than requested.
QUANTIZE_BUCKETS = 24


class BrandError(RuntimeError):
    pass


@dataclass
class BrandAsset:
    asset_key: str
    filename: str
    content_type: str
    bytes: int = 0
    url: str = ""


@dataclass
class Typography:
    """Carried for the layout layer. Never sent to a model."""

    heading: str = ""
    body: str = ""
    notes: str = ""


@dataclass
class Brand:
    name: str = ""
    description: str = ""
    palette: list[str] = field(default_factory=list)
    style_references: list[BrandAsset] = field(default_factory=list)
    logos: list[BrandAsset] = field(default_factory=list)
    typography: Typography = field(default_factory=Typography)
    updated_at: str = ""

    def is_complete(self) -> bool:
        """Enough to condition a generation: a stated look, and something to look at."""
        return bool(self.description.strip()) and bool(self.style_references)

    def prompt_prefix(self) -> str:
        """The brand lock, as text prepended to every generation.

        Text rather than image conditioning because this is the mechanism that
        is actually proven to hold — see AGENTS.md. Hex values are included
        verbatim; models honour named colours far better than they honour a
        reference image's palette.
        """
        parts = [self.description.strip()]
        if self.palette:
            parts.append("Brand palette: " + ", ".join(self.palette) + ".")
        return " ".join(p for p in parts if p)


def _decode(data_b64: str) -> bytes:
    try:
        raw = base64.b64decode(data_b64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise BrandError("upload is not valid base64") from exc
    if not raw:
        raise BrandError("upload is empty")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise BrandError(f"upload exceeds {MAX_UPLOAD_BYTES // (1024 * 1024)}MB")
    return raw


def extract_palette(raw: bytes, size: int = PALETTE_SIZE) -> list[str]:
    """Dominant colours as hex, deterministically.

    No model involved: quantize and read the palette back. Transparent pixels
    are dropped so a logo on alpha does not return its background.
    """
    with Image.open(io.BytesIO(raw)) as im:
        im = im.convert("RGBA")
        im.thumbnail((SAMPLE_EDGE, SAMPLE_EDGE))
        opaque = Image.new("RGB", im.size, (0, 0, 0))
        mask = im.getchannel("A").point(lambda a: 255 if a > 200 else 0)
        opaque.paste(im.convert("RGB"), mask=mask)

        quantized = opaque.quantize(colors=QUANTIZE_BUCKETS, method=Image.Quantize.MEDIANCUT)
        palette = quantized.getpalette() or []
        counts = sorted(quantized.getcolors() or [], reverse=True)

    chosen: list[tuple[int, int, int]] = []
    for _count, index in counts:
        rgb = tuple(palette[index * 3 : index * 3 + 3])
        # Skip the padding black introduced by fully transparent regions.
        if rgb == (0, 0, 0) and len(counts) > 1:
            continue
        # Keep only colours a designer would call distinct, most-used first.
        if any(_distance(rgb, seen) < MIN_COLOR_DISTANCE for seen in chosen):
            continue
        chosen.append(rgb)  # type: ignore[arg-type]
        if len(chosen) >= size:
            break

    return [f"#{r:02X}{g:02X}{b:02X}" for r, g, b in chosen]


def _distance(a: tuple[int, ...], b: tuple[int, ...]) -> float:
    """Euclidean RGB distance — crude but adequate for separating brand colours."""
    return sum((int(x) - int(y)) ** 2 for x, y in zip(a, b)) ** 0.5


def upload_asset(data_b64: str, filename: str, content_type: str, *, is_logo: bool) -> BrandAsset:
    """Store one brand asset in B2 and return its record."""
    raw = _decode(data_b64)
    suffix = (filename.rsplit(".", 1)[-1] if "." in filename else "png").lower()[:8]
    prefix = LOGO_PREFIX if is_logo else STYLE_PREFIX
    key = f"{prefix}/{uuid.uuid4().hex[:12]}.{suffix}"

    runner._s3().put_object(
        Bucket=runner._bucket(),
        Key=key,
        Body=raw,
        ContentType=content_type or "application/octet-stream",
    )
    return BrandAsset(
        asset_key=key,
        filename=filename,
        content_type=content_type,
        bytes=len(raw),
        url=runner.presign(key),
    )


def load_brand() -> Brand:
    """Read the workspace brand. A missing document is an empty brand, not an error."""
    try:
        raw = runner.fetch_object(BRAND_KEY)
    except Exception:  # noqa: BLE001 — not-yet-created is the normal first-run case
        return Brand()

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return Brand()

    typography = Typography(**(data.get("typography") or {}))
    brand = Brand(
        name=data.get("name", ""),
        description=data.get("description", ""),
        palette=list(data.get("palette") or []),
        style_references=[BrandAsset(**a) for a in data.get("style_references") or []],
        logos=[BrandAsset(**a) for a in data.get("logos") or []],
        typography=typography,
        updated_at=data.get("updated_at", ""),
    )
    # Presigned URLs expire, so they are re-signed on every read rather than
    # persisted stale into the document.
    for asset in [*brand.style_references, *brand.logos]:
        asset.url = runner.presign(asset.asset_key)
    return brand


def save_brand(brand: Brand) -> Brand:
    brand.updated_at = datetime.now(timezone.utc).isoformat()
    runner._s3().put_object(
        Bucket=runner._bucket(),
        Key=BRAND_KEY,
        Body=json.dumps(asdict(brand), indent=2).encode(),
        ContentType="application/json",
    )
    return brand
