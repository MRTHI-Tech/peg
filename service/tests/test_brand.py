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
    def test_a_reference_alone_is_enough(self) -> None:
        """The look is no longer described by hand — artwork is the whole ask."""
        b = brand.Brand(style_references=[brand.BrandAsset("k", "f.png", "image/png")])
        self.assertTrue(b.is_complete())

    def test_a_name_alone_is_not_enough(self) -> None:
        self.assertFalse(brand.Brand(name="Frame ZA").is_complete())

    def test_composites_do_not_make_a_brand_generation_ready(self) -> None:
        """Composites are placed on top, never used to condition generation, so
        they cannot satisfy the requirement for a style reference."""
        b = brand.Brand(
            name="Frame ZA",
            composites=[brand.BrandAsset("k", "logo.png", "image/png", kind="logo")],
        )
        self.assertFalse(b.is_complete())


class MergePaletteTests(unittest.TestCase):
    def test_the_same_colour_from_two_references_appears_once(self) -> None:
        merged = brand.merge_palette([["#3A0C60"], ["#3C0E62"]])
        self.assertEqual(len(merged), 1)

    def test_distinct_colours_from_two_references_both_survive(self) -> None:
        merged = brand.merge_palette([["#3A0C60"], ["#D61FA8"]])
        self.assertEqual(merged, ["#3A0C60", "#D61FA8"])

    def test_first_reference_wins_the_ordering(self) -> None:
        merged = brand.merge_palette([["#D61FA8"], ["#3A0C60"]])
        self.assertEqual(merged[0], "#D61FA8")

    def test_result_is_capped(self) -> None:
        many = [[f"#{v:02X}0000"] for v in range(0, 255, 10)]
        self.assertLessEqual(len(brand.merge_palette(many, size=3)), 3)

    def test_removing_a_reference_drops_only_its_colours(self) -> None:
        """The whole reason palettes are recorded per asset: a merged list
        cannot be un-merged when one reference goes away."""
        refs = [
            brand.BrandAsset("a", "a.png", "image/png", palette=["#3A0C60"]),
            brand.BrandAsset("b", "b.png", "image/png", palette=["#D61FA8"]),
        ]
        self.assertEqual(len(brand.merge_palette([r.palette for r in refs])), 2)
        surviving = [r for r in refs if r.asset_key != "b"]
        self.assertEqual(brand.merge_palette([r.palette for r in surviving]), ["#3A0C60"])

    def test_malformed_hex_is_skipped_not_fatal(self) -> None:
        self.assertEqual(brand.merge_palette([["not-a-colour", "#3A0C60"]]), ["#3A0C60"])


class UploadValidationTests(unittest.TestCase):
    def test_a_non_image_is_rejected_before_it_reaches_the_bucket(self) -> None:
        with self.assertRaises(brand.BrandError):
            brand._verify_raster(b"%PDF-1.7 not an image")

    def test_a_real_image_passes(self) -> None:
        brand._verify_raster(solid((10, 10), (12, 34, 56)))

    def test_svg_is_recognised_by_type_or_extension(self) -> None:
        self.assertTrue(brand.is_svg("mark.svg", "application/octet-stream"))
        self.assertTrue(brand.is_svg("mark", "image/svg+xml"))
        self.assertFalse(brand.is_svg("mark.png", "image/png"))


class AssetKindTests(unittest.TestCase):
    def test_a_document_written_before_kinds_reads_its_logos_as_logos(self) -> None:
        """`logos` is the pre-kind name for the composite lane; anything stored
        under it was, by definition, a logo."""
        legacy = {"logos": [{"asset_key": "k", "filename": "mark.png", "content_type": "image/png"}]}
        composites = [brand._asset(a, "logo") for a in legacy["logos"]]
        self.assertEqual([a.kind for a in composites], ["logo"])

    def test_a_stored_field_that_no_longer_exists_is_ignored(self) -> None:
        stored = {
            "asset_key": "k",
            "filename": "mark.png",
            "content_type": "image/png",
            "retired_field": True,
        }
        self.assertEqual(brand._asset(stored, "logo").asset_key, "k")

    def test_style_references_load_as_style_not_logo(self) -> None:
        stored = {"asset_key": "k", "filename": "ref.png", "content_type": "image/png"}
        self.assertEqual(brand._asset(stored, brand.STYLE_KIND).kind, "style")

    def test_an_unknown_kind_is_refused(self) -> None:
        with self.assertRaises(brand.BrandError):
            brand.upload_asset("ws_test", "", "f.png", "image/png", kind="banner")

    def test_a_composite_cannot_be_relabelled_into_the_style_lane(self) -> None:
        """The two lanes are separated on purpose — crossing them means
        re-uploading, not relabelling."""
        with self.assertRaises(brand.BrandError):
            brand.set_asset_kind("ws_test", "k", brand.STYLE_KIND)


class TypographyMigrationTests(unittest.TestCase):
    def test_typeface_names_are_carried_into_notes_not_silently_dropped(self) -> None:
        t = brand._typography({"heading": "Outfit", "body": "Inter", "notes": "Headings 600"})
        self.assertEqual(t.heading, "")
        self.assertEqual(t.body, "")
        self.assertIn("Outfit", t.notes)
        self.assertIn("Inter", t.notes)
        self.assertIn("Headings 600", t.notes)

    def test_valid_classifications_pass_through_untouched(self) -> None:
        t = brand._typography({"heading": "serif", "body": "sans-serif", "notes": "n"})
        self.assertEqual((t.heading, t.body, t.notes), ("serif", "sans-serif", "n"))

    def test_reloading_does_not_append_the_same_names_twice(self) -> None:
        once = brand._typography({"heading": "Outfit", "body": "", "notes": ""})
        twice = brand._typography({"heading": "", "body": "", "notes": once.notes})
        self.assertEqual(once.notes, twice.notes)

    def test_empty_typography_stays_empty(self) -> None:
        t = brand._typography({})
        self.assertEqual((t.heading, t.body, t.notes), ("", "", ""))


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
