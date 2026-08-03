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

def brand_key(workspace: str) -> str:
    return f"{runner.workspace_prefix(workspace)}/brand/brand.json"


def style_prefix(workspace: str) -> str:
    return f"{runner.workspace_prefix(workspace)}/brand/style"


def logo_prefix(workspace: str) -> str:
    return f"{runner.workspace_prefix(workspace)}/brand/logos"

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


# What a composited asset is, which decides how it gets placed rather than
# whether it is generated — nothing in this lane is ever generated.
COMPOSITE_KINDS = ("logo", "screenshot", "product", "other")
STYLE_KIND = "style"

# Typefaces cannot be reproduced by any image model, so what is captured is the
# classification a designer would state in a brand guideline, not a font name.
TYPE_CLASSES = ("sans-serif", "serif", "slab-serif", "monospace", "display", "script")


@dataclass
class BrandAsset:
    asset_key: str
    filename: str
    content_type: str
    bytes: int = 0
    url: str = ""
    # What this reference contributed to the brand palette. Recorded per asset
    # so removing a reference can take its colours with it — a merged top-level
    # list alone cannot be un-merged. Empty for composites, which never contribute.
    palette: list[str] = field(default_factory=list)
    # One of COMPOSITE_KINDS for a composite, STYLE_KIND for a style reference.
    kind: str = "logo"


@dataclass
class Typography:
    """Carried for the layout layer. Never sent to a model.

    Holds classifications from TYPE_CLASSES rather than typeface names: no image
    model renders a named font, and a marketing team knows "serif headings, sans
    body" without having to look up what the licence actually says.
    """

    heading: str = ""
    body: str = ""
    notes: str = ""


@dataclass
class Brand:
    name: str = ""
    description: str = ""
    palette: list[str] = field(default_factory=list)
    style_references: list[BrandAsset] = field(default_factory=list)
    composites: list[BrandAsset] = field(default_factory=list)
    typography: Typography = field(default_factory=Typography)
    updated_at: str = ""

    def is_complete(self) -> bool:
        """Enough to condition a generation: something to look at.

        The look is no longer described by hand — the form asks for artwork and a
        name, and the campaign brief is written on the canvas instead. A stored
        description is still honoured by prompt_prefix if one exists.
        """
        return bool(self.style_references)

    def prompt_prefix(self) -> str:
        """The brand lock, as text prepended to every generation.

        Text rather than image conditioning because this is the mechanism that
        is actually proven to hold — see AGENTS.md. Hex values are included
        verbatim; models honour named colours far better than they honour a
        reference image's palette.

        With the look description no longer collected, a brand created through
        the current form locks on palette alone. Deriving a description from the
        style references is the missing piece — see the Read Style node.
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


def is_svg(filename: str, content_type: str) -> bool:
    """SVG is a valid logo but not something PIL can open, so it skips raster checks."""
    return "svg" in content_type.lower() or filename.lower().endswith(".svg")


def _verify_raster(raw: bytes) -> None:
    """Reject anything PIL cannot decode, before it reaches the bucket.

    Without this a dropped PDF is stored first and blows up during palette
    extraction, leaving an orphan object behind and returning a 500 where the
    honest answer is 'that is not an image'.
    """
    try:
        with Image.open(io.BytesIO(raw)) as im:
            im.verify()
    except Exception as exc:  # noqa: BLE001 — PIL raises a wide range here
        raise BrandError("that file is not an image PEG can read") from exc


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


def merge_palette(palettes: list[list[str]], size: int = PALETTE_SIZE) -> list[str]:
    """Combine per-reference palettes into the one a designer would name.

    Applied across references, not just within one: two references of the same
    brand otherwise contribute the same violet twice under slightly different
    hex values.
    """
    chosen: list[tuple[int, ...]] = []
    for palette in palettes:
        for value in palette:
            try:
                rgb = tuple(int(value.lstrip("#")[i : i + 2], 16) for i in (0, 2, 4))
            except ValueError:
                continue
            if any(_distance(rgb, seen) < MIN_COLOR_DISTANCE for seen in chosen):
                continue
            chosen.append(rgb)
            if len(chosen) >= size:
                return [f"#{r:02X}{g:02X}{b:02X}" for r, g, b in chosen]
    return [f"#{r:02X}{g:02X}{b:02X}" for r, g, b in chosen]


def recompute_palette(brand: Brand) -> None:
    """Rebuild the palette from whatever references are left, in place.

    References saved before palettes were recorded per asset are backfilled from
    the bucket. That is a one-off cost per asset — the record persists with the
    next save — and it is what lets a removal actually drop its colours.
    """
    for asset in brand.style_references:
        if asset.palette or is_svg(asset.filename, asset.content_type):
            continue
        try:
            asset.palette = extract_palette(runner.fetch_object(asset.asset_key))
        except Exception:  # noqa: BLE001 — a missing object must not block removal
            asset.palette = []

    brand.palette = merge_palette([a.palette for a in brand.style_references])


def upload_asset(
    workspace: str, data_b64: str, filename: str, content_type: str, *, kind: str
) -> BrandAsset:
    """Store one brand asset in this workspace's B2 prefix and return its record."""
    if kind != STYLE_KIND and kind not in COMPOSITE_KINDS:
        raise BrandError(f"unknown asset kind: {kind}")

    raw = _decode(data_b64)
    if not is_svg(filename, content_type):
        _verify_raster(raw)
    suffix = (filename.rsplit(".", 1)[-1] if "." in filename else "png").lower()[:8]
    prefix = style_prefix(workspace) if kind == STYLE_KIND else logo_prefix(workspace)
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
        kind=kind,
    )


def set_asset_kind(workspace: str, asset_key: str, kind: str) -> Brand:
    """Relabel a composite. The object itself does not move — only its role changes."""
    if kind not in COMPOSITE_KINDS:
        raise BrandError(f"unknown asset kind: {kind}")

    brand = load_brand(workspace)
    for asset in brand.composites:
        if asset.asset_key == asset_key:
            asset.kind = kind
            save_brand(workspace, brand)
            return brand
    raise BrandError("no such brand asset")


def remove_asset(workspace: str, asset_key: str) -> Brand:
    """Drop one asset from the brand and from the bucket.

    Persisted immediately rather than waiting for a save: a Remove that silently
    reappears on reload reads as data loss.
    """
    brand = load_brand(workspace)
    before = len(brand.style_references) + len(brand.composites)
    brand.style_references = [a for a in brand.style_references if a.asset_key != asset_key]
    brand.composites = [a for a in brand.composites if a.asset_key != asset_key]
    if len(brand.style_references) + len(brand.composites) == before:
        raise BrandError("no such brand asset")

    recompute_palette(brand)
    save_brand(workspace, brand)

    # After the document, so a delete that fails leaves an orphan object rather
    # than a record pointing at nothing.
    try:
        runner._s3().delete_object(Bucket=runner._bucket(), Key=asset_key)
    except Exception:  # noqa: BLE001 — the brand is already correct without this
        pass
    return brand


def load_brand(workspace: str) -> Brand:
    """Read a workspace's brand. A missing document is an empty brand, not an error —
    which is exactly what a workspace that has never been set up returns."""
    try:
        raw = runner.fetch_object(brand_key(workspace))
    except Exception:  # noqa: BLE001 — not-yet-created is the normal first-run case
        return Brand()

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return Brand()

    typography = _typography(data.get("typography") or {})
    brand = Brand(
        name=data.get("name", ""),
        description=data.get("description", ""),
        palette=list(data.get("palette") or []),
        style_references=[_asset(a, STYLE_KIND) for a in data.get("style_references") or []],
        # `logos` is the pre-kind name for this lane; anything stored under it
        # predates the distinction and was, by definition, a logo.
        composites=[
            _asset(a, "logo") for a in (data.get("composites") or data.get("logos") or [])
        ],
        typography=typography,
        updated_at=data.get("updated_at", ""),
    )
    # Presigned URLs expire, so they are re-signed on every read rather than
    # persisted stale into the document.
    for asset in [*brand.style_references, *brand.composites]:
        asset.url = runner.presign(asset.asset_key)
    return brand


def _typography(data: dict) -> Typography:
    """Read typography, converting typeface names into classifications.

    Earlier versions of the form asked for the font itself ("Outfit", "Inter"),
    which no model can render. Those values are not valid classifications, so
    they are moved into the notes — the layout layer may still want them — and
    the selectors come back empty for the user to answer properly.
    """
    heading = str(data.get("heading", ""))
    body = str(data.get("body", ""))
    notes = str(data.get("notes", ""))

    named = [v for v in (heading, body) if v and v not in TYPE_CLASSES]
    if named:
        carried = ", ".join(named)
        notes = f"{notes} ({carried})".strip() if carried not in notes else notes

    return Typography(
        heading=heading if heading in TYPE_CLASSES else "",
        body=body if body in TYPE_CLASSES else "",
        notes=notes,
    )


def _asset(data: dict, default_kind: str) -> BrandAsset:
    """Build an asset from stored JSON, tolerating documents written before a field existed."""
    fields = {k: v for k, v in data.items() if k in BrandAsset.__dataclass_fields__}
    fields.setdefault("kind", default_kind)
    return BrandAsset(**fields)


def save_brand(workspace: str, brand: Brand) -> Brand:
    brand.updated_at = datetime.now(timezone.utc).isoformat()
    runner._s3().put_object(
        Bucket=runner._bucket(),
        Key=brand_key(workspace),
        Body=json.dumps(asdict(brand), indent=2).encode(),
        ContentType="application/json",
    )
    return brand
