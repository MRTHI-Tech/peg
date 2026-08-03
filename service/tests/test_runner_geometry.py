from __future__ import annotations

import io
import sys
import unittest
from pathlib import Path

# The service modules are flat (`runner`, `schemas`) because Render runs uvicorn
# with service/ as the working directory. Put that on the path so this file runs
# from anywhere instead of only with a hand-set PYTHONPATH.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image, ImageDraw  # noqa: E402

import runner  # noqa: E402
from schemas import FormatSpec  # noqa: E402


class BreakpointGeometryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.source = Image.new("RGB", (300, 300), (80, 30, 120))

    def decode(self, fmt: FormatSpec) -> tuple[Image.Image, Image.Image]:
        canvas_bytes, mask_bytes = runner._compose_for_format(self.source, fmt)
        return Image.open(io.BytesIO(canvas_bytes)), Image.open(io.BytesIO(mask_bytes))

    @staticmethod
    def framed_artwork() -> Image.Image:
        image = Image.new("RGB", (300, 300))
        pixels = image.load()
        for y in range(300):
            for x in range(300):
                pixels[x, y] = (70 + x // 5, 45 + y // 8, 30 + (x + y) // 16)

        draw = ImageDraw.Draw(image)
        cyan = (0, 240, 244)
        halo = (35, 190, 194)
        draw.rectangle((10, 10, 289, 10), fill=halo)
        draw.rectangle((10, 289, 289, 289), fill=halo)
        draw.rectangle((10, 10, 10, 289), fill=halo)
        draw.rectangle((289, 10, 289, 289), fill=halo)
        draw.rectangle((0, 0, 299, 9), fill=cyan)
        draw.rectangle((0, 290, 299, 299), fill=cyan)
        draw.rectangle((0, 0, 9, 299), fill=cyan)
        draw.rectangle((290, 0, 299, 299), fill=cyan)
        # A flattened corner lockup stays part of the retained content. Its cyan
        # backing must not cause the old square frame to survive at the join.
        draw.rectangle((225, 225, 289, 289), fill=cyan)
        draw.rectangle((245, 245, 275, 270), fill=(12, 5, 18))
        return image

    def test_desktop_keeps_plate_right_and_generates_left(self) -> None:
        fmt = FormatSpec(
            width=1920,
            height=600,
            focal_point="right",
            safe_area="left-third",
        )

        self.assertEqual(runner._placement_for_format(self.source.size, fmt), ((600, 600), (1320, 0)))
        canvas, mask = self.decode(fmt)

        self.assertEqual(canvas.size, (1920, 600))
        self.assertEqual(mask.size, (1920, 600))
        self.assertEqual(mask.getpixel((100, 300)), 255)
        self.assertEqual(mask.getpixel((1620, 300)), 0)

    def test_mobile_reserves_the_full_upper_third_without_cropping(self) -> None:
        fmt = FormatSpec(
            width=828,
            height=1104,
            focal_point="center",
            safe_area="upper-third",
        )

        self.assertEqual(runner._placement_for_format(self.source.size, fmt), ((828, 828), (0, 276)))
        canvas, mask = self.decode(fmt)

        self.assertEqual(canvas.size, (828, 1104))
        self.assertEqual(mask.getpixel((414, 100)), 255)
        self.assertEqual(mask.getpixel((414, 736)), 0)

    def test_square_recomposes_below_an_upper_copy_band(self) -> None:
        fmt = FormatSpec(
            width=1080,
            height=1080,
            focal_point="center",
            safe_area="upper-third",
        )

        self.assertEqual(runner._placement_for_format(self.source.size, fmt), ((1080, 1080), (0, 0)))
        _, mask = self.decode(fmt)

        self.assertEqual(mask.getpixel((540, 100)), 255)
        self.assertEqual(mask.getpixel((540, 720)), 0)

    def test_portrait_never_shrinks_the_source_into_a_four_sided_island(self) -> None:
        fmt = FormatSpec(
            width=1080,
            height=1920,
            focal_point="right",
            safe_area="left-third",
        )

        self.assertEqual(
            runner._placement_for_format(self.source.size, fmt),
            ((1080, 1080), (0, 420)),
        )
        canvas, mask = self.decode(fmt)

        self.assertEqual(canvas.size, (1080, 1920))
        self.assertEqual(mask.getpixel((100, 960)), 255)
        self.assertEqual(mask.getpixel((900, 960)), 0)

    def test_mask_feathers_the_preserved_boundary(self) -> None:
        fmt = FormatSpec(
            width=1024,
            height=600,
            focal_point="right",
            safe_area="left-third",
        )
        _, mask = self.decode(fmt)

        low, high = mask.getextrema()
        self.assertEqual((low, high), (0, 255))
        self.assertTrue(any(0 < value < 255 for value in mask.getdata()))

    def test_flat_brand_frame_moves_to_the_final_perimeter(self) -> None:
        self.source = self.framed_artwork()
        fmt = FormatSpec(
            width=900,
            height=300,
            focal_point="right",
            safe_area="left-third",
        )

        frame = runner._detect_embedded_frame(self.source)
        self.assertIsNotNone(frame)
        self.assertEqual((frame.left, frame.top, frame.right, frame.bottom), (10, 10, 10, 10))

        canvas, mask = self.decode(fmt)
        cyan = (0, 240, 244)

        def close(pixel: tuple[int, int, int], expected: tuple[int, int, int]) -> bool:
            return max(abs(a - b) for a, b in zip(pixel, expected)) < 16

        def cyan_like(pixel: tuple[int, int, int]) -> bool:
            return pixel[1] > pixel[0] + 80 and pixel[2] > pixel[0] + 80

        # The frame surrounds the complete wide result and is never offered to
        # genfill, so brand chrome cannot be repainted or omitted.
        for point in ((0, 150), (450, 0), (899, 150), (450, 299)):
            self.assertTrue(close(canvas.getpixel(point), cyan))
            self.assertEqual(mask.getpixel(point), 0)

        # x=610 is where the peeled scene begins. The source's old left cyan
        # rule must not remain there as an internal poster boundary.
        interior_cyan = sum(
            close(canvas.getpixel((610, y)), cyan) for y in range(10, 290)
        )
        self.assertLess(interior_cyan, 10)
        self.assertEqual(mask.getpixel((750, 150)), 0)
        self.assertEqual(mask.getpixel((100, 150)), 255)

        # Simulate a provider response: white mask pixels receive generated
        # scenery while black pixels stay verbatim. The only full cyan rules in
        # the completed image must still be the four outer edges.
        generated = Image.new("RGB", canvas.size, (210, 180, 120))
        completed = Image.composite(generated, canvas, mask)
        for point in ((0, 150), (450, 0), (899, 150), (450, 299)):
            self.assertTrue(close(completed.getpixel(point), cyan))
        completed_internal_cyan = sum(
            cyan_like(completed.getpixel((610, y))) for y in range(10, 290)
        )
        self.assertLess(completed_internal_cyan, 10)
        self.assertLess(max(completed.getpixel((850, 250))), 32)

    def test_portrait_moves_a_flattened_corner_lockup_to_the_final_corner(self) -> None:
        self.source = self.framed_artwork()
        fmt = FormatSpec(
            width=300,
            height=600,
            focal_point="right",
            safe_area="left-third",
        )

        canvas, mask = self.decode(fmt)
        cyan = (0, 240, 244)

        def close(pixel: tuple[int, int, int], expected: tuple[int, int, int]) -> bool:
            return max(abs(a - b) for a, b in zip(pixel, expected)) < 16

        # The scene spans the portrait's full inner width. The old lockup area
        # around y=390 is generated, while the exact panel is protected at the
        # final bottom-right corner.
        self.assertEqual(mask.getpixel((250, 390)), 255)
        self.assertEqual(mask.getpixel((250, 550)), 0)
        self.assertTrue(close(canvas.getpixel((295, 550)), cyan))
        self.assertLess(max(canvas.getpixel((250, 550))), 32)

    def test_unframed_gradient_does_not_trigger_frame_extraction(self) -> None:
        source = Image.new("RGB", (300, 300))
        pixels = source.load()
        for y in range(300):
            for x in range(300):
                pixels[x, y] = (20 + x // 2, 30 + y // 2, 45 + (x + y) // 4)

        self.assertIsNone(runner._detect_embedded_frame(source))

    def test_one_flat_edge_is_not_mistaken_for_a_four_sided_frame(self) -> None:
        source = Image.new("RGB", (300, 300), (80, 60, 40))
        draw = ImageDraw.Draw(source)
        draw.rectangle((0, 0, 299, 14), fill=(120, 180, 240))
        draw.rectangle((0, 15, 299, 299), fill=(40, 40, 40))

        self.assertIsNone(runner._detect_embedded_frame(source))


if __name__ == "__main__":
    unittest.main()
