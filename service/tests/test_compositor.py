from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from compositor import PegCompositorProvider, render_app_store_artwork  # noqa: E402
from genblaze_core.models import Asset, Modality, StepType  # noqa: E402
from genblaze_core.models.step import Step  # noqa: E402


class AppStoreRenderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.background = Image.new("RGB", (660, 1434), (32, 18, 60))
        self.screenshot = Image.new("RGB", (120, 260), (20, 210, 120))

    def test_output_is_exact_and_has_no_alpha_channel(self) -> None:
        result = render_app_store_artwork(
            self.background,
            self.screenshot,
            size=(660, 1434),
            params={
                "layout": "device-only",
                "frameStyle": "none",
                "deviceScale": 80,
                "shadow": False,
            },
        )

        self.assertEqual(result.size, (660, 1434))
        self.assertEqual(result.mode, "RGB")
        # The approved screenshot survives as actual pixels, rather than being
        # described to or redrawn by a model.
        self.assertGreater(sum(pixel == (20, 210, 120) for pixel in result.getdata()), 1000)

    def test_generic_frame_and_copy_render_without_changing_dimensions(self) -> None:
        result = render_app_store_artwork(
            self.background,
            self.screenshot,
            size=(660, 1434),
            params={
                "layout": "copy-top",
                "frameStyle": "dark",
                "headline": "See every project clearly",
                "subheadline": "Your real interface, presented in your brand.",
                "textColor": "#FFFFFF",
            },
        )

        self.assertEqual(result.size, (660, 1434))
        self.assertEqual(result.mode, "RGB")


class PegCompositorProviderTests(unittest.TestCase):
    def test_provider_emits_a_hashed_custom_step_asset(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            background = root / "background.png"
            screenshot = root / "screenshot.png"
            Image.new("RGB", (320, 640), (20, 10, 40)).save(background)
            Image.new("RGB", (120, 260), (30, 180, 110)).save(screenshot)
            step = Step(
                provider="peg-local",
                model="app-store-layout-v1",
                modality=Modality.IMAGE,
                params={"output_width": 320, "output_height": 640},
                inputs=[
                    Asset(
                        url=background.resolve().as_uri(),
                        media_type="image/png",
                        metadata={"peg_role": "background"},
                    ),
                    Asset(
                        url=screenshot.resolve().as_uri(),
                        media_type="image/png",
                        metadata={"peg_role": "screenshot"},
                    ),
                ],
            )

            result = PegCompositorProvider(root).generate(step)

            self.assertEqual(result.step_type, StepType.CUSTOM)
            self.assertEqual(len(result.assets), 1)
            self.assertRegex(result.assets[0].sha256 or "", r"^[0-9a-f]{64}$")
            output = Path(result.assets[0].url.removeprefix("file://"))
            with Image.open(output) as image:
                self.assertEqual(image.size, (320, 640))
                self.assertEqual(image.mode, "RGB")

    def test_pipeline_records_inputs_and_verifies_the_manifest(self) -> None:
        from genblaze_core.pipeline import Pipeline

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            inputs = []
            for role, size, colour in (
                ("background", (320, 640), (20, 10, 40)),
                ("screenshot", (120, 260), (30, 180, 110)),
            ):
                path = root / f"{role}.png"
                Image.new("RGB", size, colour).save(path)
                asset = Asset(
                    url=path.resolve().as_uri(),
                    media_type="image/png",
                    metadata={"peg_role": role},
                )
                asset.set_hash(path.read_bytes())
                inputs.append(asset)

            result = (
                Pipeline("compose-contract", preflight=False)
                .step(
                    PegCompositorProvider(root),
                    model="app-store-layout-v1",
                    modality=Modality.IMAGE,
                    step_type=StepType.CUSTOM,
                    external_inputs=inputs,
                    params={"output_width": 320, "output_height": 640},
                )
                .run(raise_on_failure=True, progress=False)
            )

            step = result.run.steps[0]
            self.assertEqual(len(step.inputs), 2)
            self.assertEqual(len(step.assets), 1)
            self.assertTrue(result.manifest.verify())


if __name__ == "__main__":
    unittest.main()
