"""Geometry and deterministic reconstruction for true image expansion.

Bria Expand differs from a masked generative fill: it receives the original
image plus an explicit final canvas, rendered size, and location.  This module
owns those coordinates and keeps the flattened outer frame out of the model
call. The returned expansion is then finished locally so the source pixels,
outer frame, and corner lockup do not depend on a model reproducing them.
"""

from __future__ import annotations

import io
from collections import deque
from dataclasses import dataclass, field

from PIL import Image

from schemas import FormatSpec


FRAME_COLOR_TOLERANCE = 24
FRAME_BLEED_TOLERANCE = 80
FRAME_EDGE_COVERAGE = 0.95
FRAME_LINE_COVERAGE = 0.85
FRAME_MAX_RATIO = 0.12
FRAME_INTERIOR_MAX_COVERAGE = 0.35
BADGE_MIN_RATIO = 0.08
BADGE_MAX_RATIO = 0.45
BADGE_MIN_COLOR_COVERAGE = 0.45
SEAM_FEATHER = 4

Box = tuple[int, int, int, int]
Point = tuple[int, int]
Size = tuple[int, int]


class ExpandGeometryError(RuntimeError):
    """The requested source/target geometry cannot produce a valid expansion."""


@dataclass(frozen=True)
class EmbeddedFrame:
    left: int
    top: int
    right: int
    bottom: int
    color: tuple[int, int, int]

    def content_box(self, size: Size) -> Box:
        width, height = size
        return (
            self.left,
            self.top,
            width - self.right,
            height - self.bottom,
        )


@dataclass(frozen=True)
class EmbeddedBadge:
    left: int
    top: int
    right: int
    bottom: int

    @property
    def box(self) -> Box:
        return self.left, self.top, self.right, self.bottom

    @property
    def size(self) -> Size:
        return self.right - self.left, self.bottom - self.top


@dataclass(frozen=True)
class OuterFrameMetadata:
    detected: EmbeddedFrame
    output_insets: tuple[int, int, int, int]
    source_image: Image.Image = field(repr=False, compare=False)


@dataclass(frozen=True)
class CornerBadgeMetadata:
    """A flattened badge kept verbatim by locking its source to bottom-right."""

    source_box: Box
    rendered_size: Size
    final_location: Point


@dataclass(frozen=True)
class SafeAreaOverlap:
    """Intersection of copy-safe space and pixels PEG promises to preserve."""

    safe_box: Box
    protected_box: Box
    overlap_box: Box | None

    @property
    def overlaps(self) -> bool:
        return self.overlap_box is not None

    @property
    def pixels(self) -> int:
        if self.overlap_box is None:
            return 0
        left, top, right, bottom = self.overlap_box
        return (right - left) * (bottom - top)

    @property
    def safe_pixels(self) -> int:
        left, top, right, bottom = self.safe_box
        return (right - left) * (bottom - top)

    @property
    def ratio(self) -> float:
        """Fraction of the copy-safe band sitting on protected source pixels.

        Absolute pixel counts say nothing on their own — 150k pixels is most of
        a 1920x600 band and a corner of a 1080x1920 one. Callers threshold on
        this instead.
        """
        total = self.safe_pixels
        return self.pixels / total if total else 0.0


@dataclass(frozen=True)
class ExpandPlan:
    """All model-facing geometry and local-only reconstruction material."""

    target_size: Size
    canvas_size: Size
    original_image_size: Size
    original_image_location: Point
    safe_area: str
    model_input: bytes = field(repr=False)
    cleaned_scene: Image.Image = field(repr=False, compare=False)
    source_overlay: Image.Image = field(repr=False, compare=False)
    frame: OuterFrameMetadata | None = None
    badge: CornerBadgeMetadata | None = None

    @property
    def frame_insets(self) -> tuple[int, int, int, int]:
        if self.frame is None:
            return 0, 0, 0, 0
        return self.frame.output_insets

    @property
    def protected_box(self) -> Box:
        """Protected source rectangle in final, outer-canvas coordinates."""
        x, y = self.original_image_location
        width, height = self.original_image_size
        left, top, _, _ = self.frame_insets
        return left + x, top + y, left + x + width, top + y + height

    def provider_params(self) -> dict[str, int]:
        """Stable scalar params for the local Bria provider/manifest."""
        canvas_width, canvas_height = self.canvas_size
        original_width, original_height = self.original_image_size
        original_x, original_y = self.original_image_location
        return {
            "canvas_width": canvas_width,
            "canvas_height": canvas_height,
            "original_width": original_width,
            "original_height": original_height,
            "original_x": original_x,
            "original_y": original_y,
        }


def _close_to_color(
    pixel: tuple[int, int, int],
    color: tuple[int, int, int],
    tolerance: int = FRAME_COLOR_TOLERANCE,
) -> bool:
    return max(abs(channel - expected) for channel, expected in zip(pixel, color)) <= tolerance


def _median_color(pixels: list[tuple[int, int, int]]) -> tuple[int, int, int]:
    middle = len(pixels) // 2
    return tuple(sorted(pixel[channel] for pixel in pixels)[middle] for channel in range(3))


def _edge_line(source: Image.Image, side: str, offset: int) -> list[tuple[int, int, int]]:
    width, height = source.size
    if side == "top":
        return list(source.crop((0, offset, width, offset + 1)).getdata())
    if side == "bottom":
        y = height - offset - 1
        return list(source.crop((0, y, width, y + 1)).getdata())
    if side == "left":
        return list(source.crop((offset, 0, offset + 1, height)).getdata())
    x = width - offset - 1
    return list(source.crop((x, 0, x + 1, height)).getdata())


def _detect_embedded_frame(source: Image.Image) -> EmbeddedFrame | None:
    source = source.convert("RGB")
    width, height = source.size
    short_edge = min(width, height)
    if short_edge < 64:
        return None

    perimeter = (
        _edge_line(source, "top", 0)
        + _edge_line(source, "bottom", 0)
        + _edge_line(source, "left", 0)
        + _edge_line(source, "right", 0)
    )
    color = _median_color(perimeter)
    coverage = sum(_close_to_color(pixel, color) for pixel in perimeter) / len(perimeter)
    if coverage < FRAME_EDGE_COVERAGE:
        return None

    max_scan = max(1, round(short_edge * FRAME_MAX_RATIO))

    def thickness(side: str) -> int:
        for offset in range(max_scan):
            line = _edge_line(source, side, offset)
            line_coverage = sum(_close_to_color(pixel, color) for pixel in line) / len(line)
            if line_coverage < FRAME_LINE_COVERAGE:
                return offset
        return max_scan

    sides = [thickness(side) for side in ("left", "top", "right", "bottom")]
    minimum = max(2, round(short_edge * 0.005))
    if min(sides) < minimum or max(sides) > min(sides) * 1.75:
        return None

    frame = EmbeddedFrame(*sides, color=color)
    box = frame.content_box(source.size)
    if box[2] - box[0] < 32 or box[3] - box[1] < 32:
        return None

    sample = source.crop(box)
    sample.thumbnail((96, 96), Image.Resampling.BOX)
    interior = list(sample.getdata())
    interior_coverage = sum(_close_to_color(pixel, color) for pixel in interior) / len(interior)
    return frame if interior_coverage <= FRAME_INTERIOR_MAX_COVERAGE else None


def _detect_corner_badge(
    content: Image.Image, frame_color: tuple[int, int, int]
) -> EmbeddedBadge | None:
    content = content.convert("RGB")
    width, height = content.size
    pixels = content.load()
    start = (width - 1, height - 1)
    if not _close_to_color(pixels[start], frame_color):
        return None

    pending = deque([start])
    visited = {start}
    min_x = max_x = start[0]
    min_y = max_y = start[1]

    while pending:
        x, y = pending.popleft()
        min_x, max_x = min(min_x, x), max(max_x, x)
        min_y, max_y = min(min_y, y), max(max_y, y)
        for candidate in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            cx, cy = candidate
            if not (0 <= cx < width and 0 <= cy < height):
                continue
            if candidate in visited or not _close_to_color(pixels[candidate], frame_color):
                continue
            visited.add(candidate)
            pending.append(candidate)

    badge = EmbeddedBadge(min_x, min_y, max_x + 1, max_y + 1)
    badge_width, badge_height = badge.size
    if not (
        BADGE_MIN_RATIO <= badge_width / width <= BADGE_MAX_RATIO
        and BADGE_MIN_RATIO <= badge_height / height <= BADGE_MAX_RATIO
    ):
        return None
    density = len(visited) / (badge_width * badge_height)
    return badge if density >= BADGE_MIN_COLOR_COVERAGE else None


def _clean_frame_bleed(
    content: Image.Image, frame_color: tuple[int, int, int]
) -> Image.Image:
    """Replace at most two antialiased frame-halo lines without changing size."""
    cleaned = content.copy()
    width, height = cleaned.size
    max_lines = min(2, max(0, min(width, height) // 64))
    if max_lines == 0:
        return cleaned

    for side in ("left", "top", "right", "bottom"):
        for offset in range(max_lines):
            line = _edge_line(cleaned, side, offset)
            coverage = sum(
                _close_to_color(pixel, frame_color, FRAME_BLEED_TOLERANCE)
                for pixel in line
            ) / len(line)
            if coverage < FRAME_LINE_COVERAGE:
                break
            if side == "left":
                replacement = cleaned.crop((offset + 1, 0, offset + 2, height))
                cleaned.paste(replacement, (offset, 0))
            elif side == "top":
                replacement = cleaned.crop((0, offset + 1, width, offset + 2))
                cleaned.paste(replacement, (0, offset))
            elif side == "right":
                x = width - offset - 1
                replacement = cleaned.crop((x - 1, 0, x, height))
                cleaned.paste(replacement, (x, 0))
            else:
                y = height - offset - 1
                replacement = cleaned.crop((0, y - 1, width, y))
                cleaned.paste(replacement, (0, y))
    return cleaned


def _scaled_frame_insets(
    frame: EmbeddedFrame, source_size: Size, target_size: Size
) -> tuple[int, int, int, int]:
    scale = min(target_size) / min(source_size)
    return tuple(
        max(1, round(value * scale))
        for value in (frame.left, frame.top, frame.right, frame.bottom)
    )


def _safe_area_box(size: Size, safe_area: str) -> Box:
    width, height = size
    third_w = max(1, width // 3)
    third_h = max(1, height // 3)
    if safe_area == "left-third":
        return 0, 0, third_w, height
    if safe_area == "right-third":
        return width - third_w, 0, width, height
    if safe_area == "upper-third":
        return 0, 0, width, third_h
    if safe_area == "lower-third":
        return 0, height - third_h, width, height
    return third_w, third_h, width - third_w, height - third_h


def _intersection(first: Box, second: Box) -> Box | None:
    left = max(first[0], second[0])
    top = max(first[1], second[1])
    right = min(first[2], second[2])
    bottom = min(first[3], second[3])
    return (left, top, right, bottom) if right > left and bottom > top else None


def _area(box: Box | None) -> int:
    if box is None:
        return 0
    return (box[2] - box[0]) * (box[3] - box[1])


def _unique(values: list[int]) -> list[int]:
    return list(dict.fromkeys(values))


def _placement(
    plate_size: Size,
    canvas_size: Size,
    target_size: Size,
    insets: tuple[int, int, int, int],
    fmt: FormatSpec,
    *,
    lock_bottom_right: bool = False,
) -> Point:
    plate_width, plate_height = plate_size
    canvas_width, canvas_height = canvas_size
    max_x, max_y = canvas_width - plate_width, canvas_height - plate_height

    # A flattened badge cannot honestly be erased from protected source pixels.
    # Keep it in the model input and place the whole source so its existing
    # bottom-right corner is already the final inner-canvas bottom-right. Any
    # copy-safe conflict is reported by safe_area_overlap for the caller to
    # reject or route to an explicit editing workflow.
    if lock_bottom_right:
        return max_x, max_y

    focal_x = {
        "left": 0,
        "center": max_x // 2,
        "right": max_x,
    }[fmt.focal_point]
    preferred_x = focal_x
    if fmt.safe_area == "left-third":
        preferred_x = max_x
    elif fmt.safe_area == "right-third":
        preferred_x = 0

    preferred_y = max_y // 2
    if fmt.safe_area == "upper-third":
        preferred_y = max_y
    elif fmt.safe_area == "lower-third":
        preferred_y = 0

    x_candidates = _unique([preferred_x, focal_x, 0, max_x, max_x // 2])
    y_candidates = _unique([preferred_y, max_y // 2, 0, max_y])
    safe_box = _safe_area_box(target_size, fmt.safe_area)
    inset_left, inset_top, _, _ = insets

    def overlap_area(position: Point) -> int:
        x, y = position
        protected = (
            inset_left + x,
            inset_top + y,
            inset_left + x + plate_width,
            inset_top + y + plate_height,
        )
        return _area(_intersection(safe_box, protected))

    candidates = [(x, y) for x in x_candidates for y in y_candidates]
    return min(candidates, key=overlap_area)


def _png_bytes(image: Image.Image) -> bytes:
    output = io.BytesIO()
    image.convert("RGB").save(output, format="PNG", optimize=True)
    return output.getvalue()


def prepare_expand(source: Image.Image, fmt: FormatSpec) -> ExpandPlan:
    """Prepare one source and exact placement for Bria's Expand endpoint."""
    source = source.convert("RGB")
    if source.width <= 0 or source.height <= 0:
        raise ExpandGeometryError("source image has invalid dimensions")

    target_size = (fmt.width, fmt.height)
    frame = _detect_embedded_frame(source)
    frame_metadata: OuterFrameMetadata | None = None
    badge_metadata: CornerBadgeMetadata | None = None

    if frame is None:
        content = source.copy()
        insets = (0, 0, 0, 0)
        badge = None
    else:
        raw_content = source.crop(frame.content_box(source.size))
        badge = _detect_corner_badge(raw_content, frame.color)
        content = _clean_frame_bleed(raw_content, frame.color)
        insets = _scaled_frame_insets(frame, source.size, target_size)
        frame_metadata = OuterFrameMetadata(frame, insets, source.copy())

    left, top, right, bottom = insets
    canvas_size = (fmt.width - left - right, fmt.height - top - bottom)
    if canvas_size[0] < 64 or canvas_size[1] < 64:
        raise ExpandGeometryError("target is too small for the detected source frame")

    scale = min(canvas_size[0] / content.width, canvas_size[1] / content.height)
    original_size = (
        min(canvas_size[0], max(1, round(content.width * scale))),
        min(canvas_size[1], max(1, round(content.height * scale))),
    )
    source_overlay = content.resize(original_size, Image.Resampling.LANCZOS)
    original_location = _placement(
        original_size,
        canvas_size,
        target_size,
        insets,
        fmt,
        lock_bottom_right=badge is not None,
    )

    if frame is not None and badge is not None:
        badge_size = (
            max(1, round(badge.size[0] * original_size[0] / content.width)),
            max(1, round(badge.size[1] * original_size[1] / content.height)),
        )
        badge_metadata = CornerBadgeMetadata(
            source_box=badge.box,
            rendered_size=badge_size,
            final_location=(canvas_size[0] - badge_size[0], canvas_size[1] - badge_size[1]),
        )

    return ExpandPlan(
        target_size=target_size,
        canvas_size=canvas_size,
        original_image_size=original_size,
        original_image_location=original_location,
        safe_area=fmt.safe_area,
        # Bria's input bytes and declared rendered size intentionally match.
        # Resizing before upload also keeps a 2048px plate from becoming an
        # unnecessarily large payload when the target's short edge is smaller.
        model_input=_png_bytes(source_overlay),
        cleaned_scene=content,
        source_overlay=source_overlay,
        frame=frame_metadata,
        badge=badge_metadata,
    )


SAFE_AREAS = ("upper-third", "lower-third", "left-third", "right-third", "center")


def clear_safe_areas(source: Image.Image, fmt: FormatSpec) -> list[str]:
    """Safe areas other than the requested one that fully clear the source.

    Each candidate is re-planned rather than measured against the current
    placement, because placement itself depends on the safe area: a free-
    floating source seated for `left-third` sits vertically centred and appears
    to block `upper-third`, when seating it for `upper-third` would clear that
    band completely. Only reached once a run is already in trouble, so the extra
    planning stays off the happy path.
    """
    clear: list[str] = []
    for name in SAFE_AREAS:
        if name == fmt.safe_area:
            continue
        try:
            plan = prepare_expand(source, fmt.model_copy(update={"safe_area": name}))
        except ExpandGeometryError:
            continue
        if safe_area_overlap(plan).overlap_box is None:
            clear.append(name)
    return clear


def safe_area_overlap(plan: ExpandPlan) -> SafeAreaOverlap:
    """Report whether copy-safe space intersects source pixels we will restore."""
    safe_box = _safe_area_box(plan.target_size, plan.safe_area)
    protected_box = plan.protected_box
    return SafeAreaOverlap(
        safe_box=safe_box,
        protected_box=protected_box,
        overlap_box=_intersection(safe_box, protected_box),
    )


def _source_alpha(plan: ExpandPlan, feather: int) -> Image.Image:
    width, height = plan.original_image_size
    canvas_width, canvas_height = plan.canvas_size
    x, y = plan.original_image_location
    alpha = Image.new("L", (width, height), 255)
    pixels = alpha.load()
    feather = max(0, min(feather, width // 2, height // 2))
    if feather == 0:
        return alpha

    if x > 0:
        for column in range(feather):
            value = round(255 * (column + 1) / (feather + 1))
            for row in range(height):
                pixels[column, row] = min(pixels[column, row], value)
    if x + width < canvas_width:
        for distance in range(1, feather + 1):
            column = width - distance
            value = round(255 * distance / (feather + 1))
            for row in range(height):
                pixels[column, row] = min(pixels[column, row], value)
    if y > 0:
        for row in range(feather):
            value = round(255 * (row + 1) / (feather + 1))
            for column in range(width):
                pixels[column, row] = min(pixels[column, row], value)
    if y + height < canvas_height:
        for distance in range(1, feather + 1):
            row = height - distance
            value = round(255 * distance / (feather + 1))
            for column in range(width):
                pixels[column, row] = min(pixels[column, row], value)
    return alpha


def _paint_embedded_frame(
    canvas: Image.Image,
    source: Image.Image,
    frame: EmbeddedFrame,
    insets: tuple[int, int, int, int],
) -> None:
    width, height = canvas.size
    source_width, source_height = source.size
    left, top, right, bottom = insets

    canvas.paste(
        source.crop((0, 0, source_width, frame.top)).resize(
            (width, top), Image.Resampling.LANCZOS
        ),
        (0, 0),
    )
    canvas.paste(
        source.crop((0, source_height - frame.bottom, source_width, source_height)).resize(
            (width, bottom), Image.Resampling.LANCZOS
        ),
        (0, height - bottom),
    )
    inner_height = height - top - bottom
    canvas.paste(
        source.crop((0, frame.top, frame.left, source_height - frame.bottom)).resize(
            (left, inner_height), Image.Resampling.LANCZOS
        ),
        (0, top),
    )
    canvas.paste(
        source.crop(
            (source_width - frame.right, frame.top, source_width, source_height - frame.bottom)
        ).resize((right, inner_height), Image.Resampling.LANCZOS),
        (width - right, top),
    )


def _load_expansion(raw: bytes | Image.Image) -> Image.Image:
    if isinstance(raw, Image.Image):
        return raw.convert("RGB")
    try:
        with Image.open(io.BytesIO(raw)) as image:
            image.load()
            return image.convert("RGB")
    except Exception as exc:  # noqa: BLE001 - normalize provider decode errors
        raise ExpandGeometryError("Bria returned an unreadable image") from exc


def finalize_expand(
    raw: bytes | Image.Image,
    plan: ExpandPlan,
    *,
    seam_feather: int = SEAM_FEATHER,
) -> Image.Image:
    """Restore protected pixels and deterministic chrome around a Bria result."""
    expanded = _load_expansion(raw)
    if expanded.size != plan.canvas_size:
        raise ExpandGeometryError(
            f"Bria returned {expanded.width}x{expanded.height}; expected "
            f"{plan.canvas_size[0]}x{plan.canvas_size[1]}"
        )

    alpha = _source_alpha(plan, seam_feather)
    expanded.paste(plan.source_overlay, plan.original_image_location, alpha)

    if plan.frame is None:
        finished = expanded
    else:
        finished = Image.new("RGB", plan.target_size, plan.frame.detected.color)
        _paint_embedded_frame(
            finished,
            plan.frame.source_image,
            plan.frame.detected,
            plan.frame.output_insets,
        )
        left, top, _, _ = plan.frame.output_insets
        finished.paste(expanded, (left, top))

    if finished.size != plan.target_size:
        raise ExpandGeometryError("final expansion has incorrect dimensions")
    return finished
