from __future__ import annotations

import io
import sys
import unittest
from pathlib import Path

# The service modules are flat (`runner`, `schemas`) because Render runs uvicorn
# with service/ as the working directory. Put that on the path so this file runs
# from anywhere instead of only with a hand-set PYTHONPATH.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image  # noqa: E402

import runner  # noqa: E402
from schemas import FormatSpec  # noqa: E402


class BreakpointGeometryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.source = Image.new("RGB", (300, 300), (80, 30, 120))

    def decode(self, fmt: FormatSpec) -> tuple[Image.Image, Image.Image]:
        canvas_bytes, mask_bytes = runner._compose_for_format(self.source, fmt)
        return Image.open(io.BytesIO(canvas_bytes)), Image.open(io.BytesIO(mask_bytes))

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

        self.assertEqual(runner._placement_for_format(self.source.size, fmt), ((736, 736), (46, 368)))
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

        self.assertEqual(runner._placement_for_format(self.source.size, fmt), ((720, 720), (180, 360)))
        _, mask = self.decode(fmt)

        self.assertEqual(mask.getpixel((540, 100)), 255)
        self.assertEqual(mask.getpixel((540, 720)), 0)

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


if __name__ == "__main__":
    unittest.main()
