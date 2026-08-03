"""Deterministic App Store artwork composition for PEG.

The image model makes the plate. This provider owns everything that must stay
exact: the authentic app screenshot, the generic device frame, approved logo,
live copy, and final pixel dimensions. It is a Genblaze provider so its inputs,
parameters, output hash, and B2 transfer live in the same provenance system as
generated assets.
"""

from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import unquote, urlparse

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

from genblaze_core.models import Asset, Modality, StepType
from genblaze_core.models.step import Step
from genblaze_core.providers.base import ProviderCapabilities, SyncProvider
from genblaze_core.runnable.config import RunnableConfig


MAX_RENDER_PIXELS = 4096 * 4096
HEX_COLOUR = re.compile(r"^#[0-9a-fA-F]{6}$")


class CompositionError(RuntimeError):
    pass


def _number(params: dict, key: str, default: float, low: float, high: float) -> float:
    try:
        value = float(params.get(key, default))
    except (TypeError, ValueError):
        value = default
    return max(low, min(high, value))


def _colour(value: object, default: str = "#FFFFFF") -> str:
    text = str(value or "")
    return text if HEX_COLOUR.fullmatch(text) else default


def _font(size: int, *, bold: bool) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    filenames = (
        "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
        if bold
        else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    )
    for filename in filenames:
        try:
            return ImageFont.truetype(filename, size=size)
        except OSError:
            continue
    # Pillow 10+ accepts a scalable size here; older versions ignore it safely.
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # pragma: no cover - compatibility with older Pillow
        return ImageFont.load_default()


def _text_width(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont) -> int:
    box = draw.textbbox((0, 0), text, font=font)
    return box[2] - box[0]


def _wrap(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont, width: int) -> list[str]:
    words = text.split()
    if not words:
        return []
    lines: list[str] = []
    line = words[0]
    for word in words[1:]:
        candidate = f"{line} {word}"
        if _text_width(draw, candidate, font) <= width:
            line = candidate
        else:
            lines.append(line)
            line = word
    lines.append(line)
    return lines


def _fit_headline(
    draw: ImageDraw.ImageDraw, text: str, width: int, preferred_size: int
) -> tuple[ImageFont.ImageFont, list[str]]:
    minimum = max(24, preferred_size // 2)
    for size in range(preferred_size, minimum - 1, -2):
        font = _font(size, bold=True)
        lines = _wrap(draw, text, font, width)
        if len(lines) <= 3:
            return font, lines
    font = _font(minimum, bold=True)
    return font, _wrap(draw, text, font, width)[:3]


def _rounded_image(image: Image.Image, size: tuple[int, int], radius: int) -> Image.Image:
    contained = ImageOps.contain(image.convert("RGB"), size, Image.Resampling.LANCZOS)
    screen = Image.new("RGB", size, (12, 12, 14))
    position = ((size[0] - contained.width) // 2, (size[1] - contained.height) // 2)
    screen.paste(contained, position)
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size[0], size[1]), radius=radius, fill=255)
    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    layer.paste(screen.convert("RGBA"), (0, 0), mask)
    return layer


def _device_layer(
    screenshot: Image.Image,
    bounds: tuple[int, int, int, int],
    *,
    frame_style: str,
    scale_percent: float,
) -> Image.Image:
    left, top, right, bottom = bounds
    available_w, available_h = max(1, right - left), max(1, bottom - top)
    bezel_ratio = 0 if frame_style == "none" else 0.032
    source_ratio = screenshot.width / screenshot.height

    # Solve for the largest framed device that fits the assigned layout region.
    outer_ratio = (source_ratio + 2 * bezel_ratio) / (1 + 2 * bezel_ratio)
    if available_w / available_h < outer_ratio:
        outer_w = available_w
        outer_h = round(outer_w / outer_ratio)
    else:
        outer_h = available_h
        outer_w = round(outer_h * outer_ratio)
    factor = scale_percent / 100
    outer_w, outer_h = max(1, round(outer_w * factor)), max(1, round(outer_h * factor))

    bezel = 0 if frame_style == "none" else max(6, round(min(outer_w, outer_h) * bezel_ratio))
    screen_size = (max(1, outer_w - 2 * bezel), max(1, outer_h - 2 * bezel))
    screen_radius = max(8, round(screen_size[0] * 0.075))
    screen = _rounded_image(screenshot, screen_size, screen_radius)

    device = Image.new("RGBA", (outer_w, outer_h), (0, 0, 0, 0))
    if frame_style != "none":
        draw = ImageDraw.Draw(device)
        fill = (220, 222, 226, 255) if frame_style == "light" else (22, 23, 27, 255)
        outline = (255, 255, 255, 100) if frame_style == "dark" else (255, 255, 255, 210)
        draw.rounded_rectangle(
            (0, 0, outer_w - 1, outer_h - 1),
            radius=screen_radius + bezel,
            fill=fill,
            outline=outline,
            width=max(1, bezel // 4),
        )
    device.alpha_composite(screen, (bezel, bezel))
    return device


def _layout_boxes(width: int, height: int, layout: str) -> tuple[tuple[int, int, int, int], tuple[int, int, int, int]]:
    margin = round(min(width, height) * 0.055)
    if layout == "copy-left":
        return (
            (margin, margin, round(width * 0.44), height - margin),
            (round(width * 0.46), margin, width - margin, height - margin),
        )
    if layout == "copy-right":
        return (
            (round(width * 0.56), margin, width - margin, height - margin),
            (margin, margin, round(width * 0.54), height - margin),
        )
    if layout == "device-only":
        whole = (margin, margin, width - margin, height - margin)
        return ((0, 0, 0, 0), whole)
    return (
        (margin, margin, width - margin, round(height * 0.25)),
        (margin, round(height * 0.24), width - margin, height - margin),
    )


def _place_logo(
    canvas: Image.Image, logo: Image.Image, box: tuple[int, int, int, int], layout: str
) -> int:
    left, top, right, bottom = box
    max_size = (max(1, round((right - left) * 0.28)), max(1, round((bottom - top) * 0.17)))
    rendered = ImageOps.contain(logo.convert("RGBA"), max_size, Image.Resampling.LANCZOS)
    x = left if layout in {"copy-left", "copy-right"} else left + (right - left - rendered.width) // 2
    canvas.alpha_composite(rendered, (x, top))
    return rendered.height + max(12, round(rendered.height * 0.35))


def _draw_copy(
    canvas: Image.Image,
    box: tuple[int, int, int, int],
    params: dict,
    layout: str,
    logo: Image.Image | None,
) -> None:
    headline = str(params.get("headline", "")).strip()[:180]
    subheadline = str(params.get("subheadline", "")).strip()[:300]
    if not headline and not subheadline and logo is None:
        return

    left, top, right, bottom = box
    if right <= left or bottom <= top:
        return
    inset = round(min(right - left, bottom - top) * 0.025)
    left, top, right, bottom = left + inset, top + inset, right - inset, bottom - inset
    colour = _colour(params.get("textColor"))
    align = "left" if layout in {"copy-left", "copy-right"} else "center"
    x = left if align == "left" else left + (right - left) // 2
    cursor_y = top

    if logo is not None:
        cursor_y += _place_logo(canvas, logo, (left, cursor_y, right, bottom), layout)

    draw = ImageDraw.Draw(canvas)
    if headline:
        preferred = max(36, round(min(canvas.width, canvas.height) * 0.068))
        font, lines = _fit_headline(draw, headline, right - left, preferred)
        line_height = max(1, round(font.size * 1.06)) if hasattr(font, "size") else preferred
        draw.multiline_text(
            (x, cursor_y),
            "\n".join(lines),
            font=font,
            fill=colour,
            anchor="ma" if align == "center" else "la",
            align=align,
            spacing=max(2, round(line_height * 0.08)),
        )
        cursor_y += line_height * len(lines) + round(preferred * 0.32)

    if subheadline:
        body_size = max(24, round(min(canvas.width, canvas.height) * 0.027))
        font = _font(body_size, bold=False)
        lines = _wrap(draw, subheadline, font, right - left)[:4]
        draw.multiline_text(
            (x, cursor_y),
            "\n".join(lines),
            font=font,
            fill=colour,
            anchor="ma" if align == "center" else "la",
            align=align,
            spacing=max(2, round(body_size * 0.3)),
        )


def render_app_store_artwork(
    background: Image.Image,
    screenshot: Image.Image,
    *,
    size: tuple[int, int],
    params: dict,
    logo: Image.Image | None = None,
) -> Image.Image:
    width, height = size
    if width * height > MAX_RENDER_PIXELS:
        raise CompositionError("output dimensions are too large")

    source_ratio = background.width / background.height
    output_ratio = width / height
    if abs(source_ratio - output_ratio) > 0.005:
        raise CompositionError(
            "background aspect ratio does not match the output; connect Extend Canvas "
            "with the same Format before composing"
        )
    canvas = background.convert("RGB").resize(size, Image.Resampling.LANCZOS).convert("RGBA")
    layout = str(params.get("layout", "copy-top"))
    if layout not in {"copy-top", "copy-left", "copy-right", "device-only"}:
        layout = "copy-top"
    frame_style = str(params.get("frameStyle", "dark"))
    if frame_style not in {"dark", "light", "none"}:
        frame_style = "dark"
    copy_box, device_box = _layout_boxes(width, height, layout)
    device = _device_layer(
        screenshot,
        device_box,
        frame_style=frame_style,
        scale_percent=_number(params, "deviceScale", 88, 35, 100),
    )

    box_left, box_top, box_right, box_bottom = device_box
    x = box_left + (box_right - box_left - device.width) // 2
    y = box_top + (box_bottom - box_top - device.height) // 2
    x += round((box_right - box_left) * _number(params, "deviceOffsetX", 0, -30, 30) / 100)
    y += round((box_bottom - box_top) * _number(params, "deviceOffsetY", 0, -30, 30) / 100)
    x = max(-device.width // 2, min(width - device.width // 2, x))
    y = max(-device.height // 2, min(height - device.height // 2, y))

    if bool(params.get("shadow", True)):
        alpha = device.getchannel("A")
        blur = max(8, round(min(device.width, device.height) * 0.035))
        shadow = Image.new("RGBA", device.size, (0, 0, 0, 0))
        shadow.putalpha(alpha.filter(ImageFilter.GaussianBlur(blur)).point(lambda p: round(p * 0.48)))
        canvas.alpha_composite(shadow, (x + blur // 3, y + blur // 2))
    canvas.alpha_composite(device, (x, y))
    _draw_copy(canvas, copy_box, params, layout, logo)

    # App Store Connect rejects alpha channels even when every pixel is opaque.
    return canvas.convert("RGB")


def _local_path(asset: Asset) -> Path:
    parsed = urlparse(asset.url)
    if parsed.scheme != "file":
        raise CompositionError("local compositor inputs must be staged as file URLs")
    return Path(unquote(parsed.path))


class PegCompositorProvider(SyncProvider):
    """A zero-cost local Genblaze provider for final, brand-safe assembly."""

    name = "peg-local"

    def __init__(self, output_dir: str | Path):
        super().__init__()
        self.output_dir = Path(output_dir)

    def get_capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            supported_modalities=[Modality.IMAGE],
            supported_inputs=["image"],
            accepts_chain_input=True,
            output_formats=["image/png"],
        )

    def generate(self, step: Step, config: RunnableConfig | None = None) -> Step:
        by_role = {str(asset.metadata.get("peg_role", "")): asset for asset in step.inputs}
        if "background" not in by_role or "screenshot" not in by_role:
            raise CompositionError("composition requires a background and screenshot")

        with Image.open(_local_path(by_role["background"])) as source:
            background = source.copy()
        with Image.open(_local_path(by_role["screenshot"])) as source:
            screenshot = source.copy()
        logo = None
        if "logo" in by_role:
            with Image.open(_local_path(by_role["logo"])) as source:
                logo = source.copy()

        width = round(_number(step.params, "output_width", 1320, 64, 4096))
        height = round(_number(step.params, "output_height", 2868, 64, 4096))
        rendered = render_app_store_artwork(
            background,
            screenshot,
            size=(width, height),
            params=step.params,
            logo=logo,
        )
        self.output_dir.mkdir(parents=True, exist_ok=True)
        output = self.output_dir / f"{step.step_id}.png"
        rendered.save(output, format="PNG", optimize=True)
        raw = output.read_bytes()

        asset = Asset(
            url=output.resolve().as_uri(),
            media_type="image/png",
            width=width,
            height=height,
            metadata={"kind": "app-store-artwork"},
        )
        asset.set_hash(raw)
        step.assets.append(asset)
        step.step_type = StepType.CUSTOM
        return step
