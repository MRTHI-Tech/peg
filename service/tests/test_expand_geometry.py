from __future__ import annotations

import io
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image, ImageDraw  # noqa: E402

from expand_geometry import (  # noqa: E402
    ExpandGeometryError,
    finalize_expand,
    prepare_expand,
    safe_area_overlap,
)
from schemas import FormatSpec  # noqa: E402


CYAN = (0, 240, 244)


def framed_artwork() -> Image.Image:
    image = Image.new("RGB", (500, 500), CYAN)
    pixels = image.load()
    for y in range(14, 486):
        for x in range(14, 486):
            pixels[x, y] = (40 + (x - 14) // 4, 35 + (y - 14) // 5, 25)

    draw = ImageDraw.Draw(image)
    draw.rectangle((396, 396, 485, 485), fill=CYAN)
    draw.rectangle((420, 425, 470, 470), fill=(8, 5, 12))
    return image


def decode(raw: bytes) -> Image.Image:
    with Image.open(io.BytesIO(raw)) as image:
        image.load()
        return image.convert("RGB")


class ExpandGeometryTests(unittest.TestCase):
    def test_exact_framed_desktop_contract_and_finalization(self) -> None:
        plan = prepare_expand(
            framed_artwork(),
            FormatSpec(
                width=1000,
                height=500,
                focal_point="right",
                safe_area="left-third",
            ),
        )

        self.assertEqual(plan.canvas_size, (972, 472))
        self.assertEqual(plan.original_image_size, (472, 472))
        self.assertEqual(plan.original_image_location, (500, 0))
        self.assertEqual(plan.frame_insets, (14, 14, 14, 14))
        self.assertEqual(
            plan.provider_params(),
            {
                "canvas_width": 972,
                "canvas_height": 472,
                "original_width": 472,
                "original_height": 472,
                "original_x": 500,
                "original_y": 0,
            },
        )
        self.assertFalse(safe_area_overlap(plan).overlaps)
        model_input = decode(plan.model_input)
        self.assertEqual(model_input.size, (472, 472))
        # The flattened badge stays verbatim. PEG does not invent replacement
        # scene pixels underneath brand artwork it cannot actually see.
        self.assertEqual(model_input.getpixel((410, 415)), (8, 5, 12))

        result = finalize_expand(Image.new("RGB", plan.canvas_size, (210, 170, 110)), plan)
        self.assertEqual(result.size, (1000, 500))

        for point in ((0, 250), (500, 0), (999, 250), (500, 499)):
            self.assertEqual(result.getpixel(point), CYAN)

        # The old frame is absent from the source/generation join. The only
        # cyan on this column may be the final top and bottom frame pixels.
        join_x = plan.frame_insets[0] + plan.original_image_location[0]
        cyan_on_join = sum(
            result.getpixel((join_x, y)) == CYAN for y in range(result.height)
        )
        self.assertEqual(cyan_on_join, 28)

        # Pixels outside the four-pixel seam are restored from the cleaned
        # source, while the extracted lockup is placed at the final corner.
        self.assertEqual(result.getpixel((join_x + 20, 100)), plan.source_overlay.getpixel((20, 86)))
        self.assertEqual(result.getpixel((950, 450)), (8, 5, 12))

    def test_focal_point_controls_horizontal_location_without_a_side_copy_band(self) -> None:
        source = Image.new("RGB", (500, 500), (30, 60, 90))
        left = prepare_expand(
            source,
            FormatSpec(width=1000, height=500, focal_point="left", safe_area="upper-third"),
        )
        center = prepare_expand(
            source,
            FormatSpec(width=1000, height=500, focal_point="center", safe_area="upper-third"),
        )
        right = prepare_expand(
            source,
            FormatSpec(width=1000, height=500, focal_point="right", safe_area="upper-third"),
        )

        self.assertEqual(left.original_image_location, (0, 0))
        self.assertEqual(center.original_image_location, (250, 0))
        self.assertEqual(right.original_image_location, (500, 0))

    def test_side_safe_area_overrides_conflicting_focal_point_when_possible(self) -> None:
        source = Image.new("RGB", (500, 500), (30, 60, 90))
        copy_left = prepare_expand(
            source,
            FormatSpec(width=1000, height=500, focal_point="left", safe_area="left-third"),
        )
        copy_right = prepare_expand(
            source,
            FormatSpec(width=1000, height=500, focal_point="right", safe_area="right-third"),
        )

        self.assertEqual(copy_left.original_image_location, (500, 0))
        self.assertEqual(copy_right.original_image_location, (0, 0))
        self.assertFalse(safe_area_overlap(copy_left).overlaps)
        self.assertFalse(safe_area_overlap(copy_right).overlaps)

    def test_portrait_upper_and_lower_safe_areas_choose_the_opposite_edge(self) -> None:
        source = Image.new("RGB", (500, 500), (30, 60, 90))
        upper = prepare_expand(
            source,
            FormatSpec(width=500, height=1000, focal_point="center", safe_area="upper-third"),
        )
        lower = prepare_expand(
            source,
            FormatSpec(width=500, height=1000, focal_point="center", safe_area="lower-third"),
        )

        self.assertEqual(upper.original_image_location, (0, 500))
        self.assertEqual(lower.original_image_location, (0, 0))
        self.assertFalse(safe_area_overlap(upper).overlaps)
        self.assertFalse(safe_area_overlap(lower).overlaps)

    def test_unavoidable_overlap_is_reported_without_regenerating_source(self) -> None:
        source = Image.new("RGB", (500, 500), (17, 43, 89))
        plan = prepare_expand(
            source,
            FormatSpec(width=600, height=500, focal_point="right", safe_area="left-third"),
        )
        report = safe_area_overlap(plan)

        self.assertTrue(report.overlaps)
        self.assertEqual(report.safe_box, (0, 0, 200, 500))
        self.assertEqual(report.protected_box, (100, 0, 600, 500))
        self.assertEqual(report.overlap_box, (100, 0, 200, 500))
        self.assertEqual(report.pixels, 50_000)
        self.assertEqual(decode(plan.model_input).getpixel((250, 250)), (17, 43, 89))
        self.assertEqual(plan.source_overlay.getpixel((250, 250)), (17, 43, 89))

    def test_only_the_generated_facing_seam_is_feathered(self) -> None:
        source = Image.new("RGB", (500, 500), (0, 0, 255))
        plan = prepare_expand(
            source,
            FormatSpec(width=1000, height=500, focal_point="right", safe_area="left-third"),
        )
        result = finalize_expand(Image.new("RGB", plan.canvas_size, (255, 0, 0)), plan)

        self.assertEqual(result.getpixel((499, 250)), (255, 0, 0))
        self.assertNotEqual(result.getpixel((500, 250)), (0, 0, 255))
        self.assertEqual(result.getpixel((504, 250)), (0, 0, 255))
        self.assertEqual(result.getpixel((999, 250)), (0, 0, 255))

    def test_model_input_is_staged_at_its_declared_rendered_size(self) -> None:
        plan = prepare_expand(
            Image.new("RGB", (2000, 2000), (30, 60, 90)),
            FormatSpec(width=500, height=1000, safe_area="upper-third"),
        )

        self.assertEqual(plan.original_image_size, (500, 500))
        self.assertEqual(decode(plan.model_input).size, plan.original_image_size)

    def test_portrait_locks_badged_source_to_final_bottom_right(self) -> None:
        plan = prepare_expand(
            framed_artwork(),
            FormatSpec(
                width=500,
                height=1000,
                focal_point="right",
                safe_area="left-third",
            ),
        )
        self.assertEqual(plan.canvas_size, (472, 972))
        self.assertEqual(plan.original_image_location, (0, 500))
        # A left copy band cannot coexist with a full-width protected source;
        # the runner must reject or route this explicit conflict.
        self.assertTrue(safe_area_overlap(plan).overlaps)

        result = finalize_expand(Image.new("RGB", plan.canvas_size, (210, 170, 110)), plan)
        self.assertNotEqual(result.getpixel((450, 700)), (8, 5, 12))
        self.assertEqual(result.getpixel((450, 950)), (8, 5, 12))

    def test_badged_portrait_can_leave_an_upper_copy_band_clear(self) -> None:
        plan = prepare_expand(
            framed_artwork(),
            FormatSpec(
                width=500,
                height=1000,
                focal_point="center",
                safe_area="upper-third",
            ),
        )

        self.assertEqual(plan.original_image_location, (0, 500))
        self.assertIsNotNone(plan.badge)
        self.assertEqual(plan.badge.final_location, (382, 882))
        self.assertFalse(safe_area_overlap(plan).overlaps)

    def test_wrong_provider_dimensions_are_rejected(self) -> None:
        plan = prepare_expand(
            Image.new("RGB", (500, 500), (30, 60, 90)),
            FormatSpec(width=1000, height=500),
        )
        with self.assertRaisesRegex(ExpandGeometryError, "expected 1000x500"):
            finalize_expand(Image.new("RGB", (999, 500)), plan)


if __name__ == "__main__":
    unittest.main()
