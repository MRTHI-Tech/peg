"""Automatic workspace brand inheritance for Gemini image generations."""

from __future__ import annotations

import base64
import io
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image  # noqa: E402

import brand  # noqa: E402
import runner  # noqa: E402
from genblaze_core.models import Modality  # noqa: E402
from genblaze_core.models.step import Step  # noqa: E402
from schemas import RunRequest  # noqa: E402


def png_bytes(colour: tuple[int, int, int] = (12, 40, 90)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (12, 8), colour).save(buf, format="PNG")
    return buf.getvalue()


def asset(filename: str, kind: str, key: str | None = None) -> brand.BrandAsset:
    suffix = "svg" if filename.endswith(".svg") else "png"
    return brand.BrandAsset(
        asset_key=key or f"brand/{filename}",
        filename=filename,
        content_type="image/svg+xml" if suffix == "svg" else "image/png",
        kind=kind,
    )


class BrandAssetSelectionTests(unittest.TestCase):
    def test_prefers_a_light_wordmark_and_symbol(self) -> None:
        assets = [
            asset("Bolt Icon - Black.svg", "logo"),
            asset("Bolt Icon - White.svg", "logo"),
            asset("Bolt Wordmark - Blue.svg", "logo"),
            asset("Bolt Wordmark - White.svg", "logo"),
            asset("Product.png", "product"),
        ]

        selected = runner._select_logo_assets(assets)

        self.assertEqual(
            [item.filename for item in selected],
            ["Bolt Wordmark - White.svg", "Bolt Icon - White.svg"],
        )

    def test_svg_is_rasterized_for_the_model_without_changing_the_asset(self) -> None:
        svg = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 1"><path fill="white" d="M0 0h2v1H0z"/></svg>'
        item = asset("Mark.svg", "logo")

        with mock.patch.object(runner, "fetch_object", return_value=svg):
            reference = runner._asset_reference(item, "logo", "APPROVED LOGO")

        raw = base64.b64decode(reference.data_b64)
        with Image.open(io.BytesIO(raw)) as image:
            self.assertEqual(image.format, "PNG")
            self.assertEqual(image.width, 1024)
        self.assertEqual(reference.asset_key, item.asset_key)
        self.assertEqual(reference.media_type, "image/png")


class AutomaticBrandContextTests(unittest.TestCase):
    def test_workspace_assets_are_added_without_canvas_uploads(self) -> None:
        current = brand.Brand(
            name="Bolt",
            palette=["#050819", "#2E6BF6"],
            style_references=[
                asset(f"style-{index}.png", "style") for index in range(1, 5)
            ],
            composites=[
                asset("Bolt Wordmark - White.png", "logo"),
                asset("Bolt Icon - White.png", "logo"),
            ],
        )
        images = {
            item.asset_key: png_bytes((index * 20, 40, 90))
            for index, item in enumerate(
                [*current.style_references, *current.composites], start=1
            )
        }

        with (
            mock.patch.object(brand, "load_brand", return_value=current),
            mock.patch.object(runner, "fetch_object", side_effect=images.__getitem__),
        ):
            prompt, references = runner._generation_brand_context(
                RunRequest(model="gemini-3.1-flash-image", prompt="An event"),
                "org_a",
            )

        self.assertIn('brand "Bolt"', prompt)
        self.assertIn("#2E6BF6", prompt)
        self.assertIn("only permitted brand", prompt)
        self.assertEqual(
            [reference.role for reference in references],
            ["style", "style", "style", "logo", "logo"],
        )
        self.assertNotIn(
            "brand/style-4.png", [reference.asset_key for reference in references]
        )

    def test_non_gemini_jobs_keep_text_lock_but_receive_no_images(self) -> None:
        current = brand.Brand(
            name="Bolt",
            palette=["#2E6BF6"],
            style_references=[asset("style.png", "style")],
        )
        with mock.patch.object(brand, "load_brand", return_value=current):
            prompt, references = runner._generation_brand_context(
                RunRequest(model="seedream-5.0-lite", prompt="A plate"), "org_a"
            )

        self.assertIn("Bolt", prompt)
        self.assertIn("#2E6BF6", prompt)
        self.assertEqual(references, ())


class MultiReferencePayloadTests(unittest.TestCase):
    def test_campaign_style_and_logo_are_labelled_in_one_gemini_request(self) -> None:
        style = runner.GenerationReference(
            role="style",
            label="BRAND STYLE REFERENCE 1.",
            data_b64=base64.b64encode(png_bytes((20, 30, 40))).decode(),
            media_type="image/png",
            asset_key="brand/style.png",
        )
        logo = runner.GenerationReference(
            role="logo",
            label="APPROVED PRIMARY WORDMARK.",
            data_b64=base64.b64encode(png_bytes((240, 240, 240))).decode(),
            media_type="image/png",
            asset_key="brand/logo.png",
        )
        provider = runner.PegGMICloudImageProvider(
            api_key="test-key", references=(style, logo)
        )
        campaign = base64.b64encode(png_bytes()).decode()
        params = provider.normalize_params(
            {
                "image": campaign,
                "peg_brand_references": [
                    style.manifest_marker(),
                    logo.manifest_marker(),
                ],
            },
            Modality.IMAGE,
        )
        step = Step(
            provider=provider.name,
            model="gemini-3.1-flash-image",
            prompt="Create a Bolt event",
            modality=Modality.IMAGE,
            params=params,
        )

        payload = provider.prepare_payload(step)

        self.assertNotIn("peg_brand_references", payload)
        self.assertNotIn("image", payload)
        parts = payload["contents"][0]["parts"]
        labels = [part["text"] for part in parts if "text" in part]
        images = [part["inlineData"]["data"] for part in parts if "inlineData" in part]
        self.assertTrue(any("COMPOSITION REFERENCE" in label for label in labels))
        self.assertIn(style.label, labels)
        self.assertIn(logo.label, labels)
        self.assertEqual(images, [campaign, style.data_b64, logo.data_b64])


if __name__ == "__main__":
    unittest.main()
