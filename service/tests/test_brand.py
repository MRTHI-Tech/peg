from __future__ import annotations

import io
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image  # noqa: E402

import brand  # noqa: E402


def solid(size, color, mode="RGB") -> bytes:
    buf = io.BytesIO()
    Image.new(mode, size, color).save(buf, format="PNG")
    return buf.getvalue()


class PaletteExtractionTests(unittest.TestCase):
    def test_two_tone_image_yields_exactly_its_two_colours(self) -> None:
        im = Image.new("RGB", (200, 100), (58, 12, 96))
        for x in range(120, 200):
            for y in range(100):
                im.putpixel((x, y), (214, 31, 168))
        buf = io.BytesIO()
        im.save(buf, format="PNG")

        self.assertEqual(len(brand.extract_palette(buf.getvalue())), 2)

    def test_near_duplicates_collapse_to_one_entry(self) -> None:
        """Quantizing alone returns several barely-different violets; a brand
        palette of near-identical swatches is useless to a designer."""
        im = Image.new("RGB", (120, 60), (58, 12, 96))
        for x in range(60, 120):
            for y in range(60):
                im.putpixel((x, y), (60, 14, 98))  # imperceptibly different
        buf = io.BytesIO()
        im.save(buf, format="PNG")

        self.assertEqual(len(brand.extract_palette(buf.getvalue())), 1)

    def test_transparent_surround_does_not_contribute_black(self) -> None:
        """A logo on alpha must return its own colour, not its background."""
        logo = Image.new("RGBA", (80, 80), (0, 0, 0, 0))
        for x in range(20, 60):
            for y in range(20, 60):
                logo.putpixel((x, y), (255, 200, 0, 255))
        buf = io.BytesIO()
        logo.save(buf, format="PNG")

        self.assertEqual(brand.extract_palette(buf.getvalue()), ["#FFC800"])

    def test_palette_is_capped(self) -> None:
        noisy = Image.effect_noise((150, 150), 120).convert("RGB")
        buf = io.BytesIO()
        noisy.save(buf, format="PNG")

        self.assertLessEqual(len(brand.extract_palette(buf.getvalue(), size=4)), 4)


class BrandCompletenessTests(unittest.TestCase):
    def test_a_description_alone_is_not_enough(self) -> None:
        b = brand.Brand(description="Deep violet studio")
        self.assertFalse(b.is_complete())

    def test_a_reference_alone_is_not_enough(self) -> None:
        b = brand.Brand(style_references=[brand.BrandAsset("k", "f.png", "image/png")])
        self.assertFalse(b.is_complete())

    def test_description_plus_reference_is_complete(self) -> None:
        b = brand.Brand(
            description="Deep violet studio",
            style_references=[brand.BrandAsset("k", "f.png", "image/png")],
        )
        self.assertTrue(b.is_complete())

    def test_logos_do_not_make_a_brand_generation_ready(self) -> None:
        """Logos are composited, never used to condition generation, so they
        cannot satisfy the requirement for a style reference."""
        b = brand.Brand(
            description="Deep violet studio",
            logos=[brand.BrandAsset("k", "logo.png", "image/png")],
        )
        self.assertFalse(b.is_complete())


class PromptPrefixTests(unittest.TestCase):
    def test_palette_hexes_are_included_verbatim(self) -> None:
        b = brand.Brand(description="Dark studio.", palette=["#0A050F", "#D61FA8"])
        prefix = b.prompt_prefix()
        self.assertIn("#0A050F", prefix)
        self.assertIn("#D61FA8", prefix)

    def test_no_palette_still_produces_the_description(self) -> None:
        b = brand.Brand(description="Dark studio.")
        self.assertEqual(b.prompt_prefix(), "Dark studio.")


if __name__ == "__main__":
    unittest.main()
