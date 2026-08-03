"""The reference-image path: campaign reference in, model params out.

Covers the link that was missing entirely. The backend has always accepted
`image_b64` and the canvas never sent one, so nothing exercised it end to end —
which is exactly why "find a reference and make it ours" was not expressible.
"""

from __future__ import annotations

import base64
import io
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image  # noqa: E402

import runner  # noqa: E402
from genblaze_core.exceptions import GenblazeError  # noqa: E402
from genblaze_core.models import Modality  # noqa: E402
from genblaze_core.models.step import Step  # noqa: E402
from genblaze_core.pipeline import Pipeline  # noqa: E402
from schemas import RunRequest  # noqa: E402


def png_b64() -> str:
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (10, 140, 90)).save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def credential_collision_png_b64() -> str:
    """A valid PNG whose base64 deliberately contains a fake Google key."""
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (10, 140, 90)).save(buf, format="PNG")
    raw = buf.getvalue()
    # Align the appended bytes so their base64 appears verbatim. PNG readers
    # permit trailing data after IEND, which keeps this a verified image.
    raw += bytes((-len(raw)) % 3)
    raw += base64.b64decode("AIza" + "A" * 32)
    return base64.b64encode(raw).decode()


class ReferenceReachesTheModel(unittest.TestCase):
    def _capture(self, req: RunRequest) -> dict:
        captured: dict = {}

        def fake_submit(model, prompt, params, workspace, references=()):
            captured.update(
                model=model,
                prompt=prompt,
                params=params,
                references=references,
            )
            return "job_x", 1

        with (
            mock.patch.object(runner, "_submit", side_effect=fake_submit),
            mock.patch.object(runner, "_collect_run_output", return_value=(None, None)),
        ):
            runner.run_generate(req, "org_a")
        return captured

    def test_a_reference_arrives_as_the_image_param(self) -> None:
        """`image` is the param name the proven genfill recipe uses; the `_url`
        variants are rejected by the API."""
        captured = self._capture(
            RunRequest(model="gemini-3.1-flash-image", prompt="a hero", image_b64=png_b64())
        )
        self.assertIn("image", captured["params"])

    def test_the_node_chooses_the_model(self) -> None:
        """Reference conditioning is unproven, so the model is switchable from
        the node rather than pinned in the catalog."""
        captured = self._capture(
            RunRequest(model="gpt-image-2-edit", prompt="a hero", image_b64=png_b64())
        )
        self.assertEqual(captured["model"], "gpt-image-2-edit")

    def test_no_reference_means_no_image_param(self) -> None:
        """A plain text-to-image run must not grow an empty image param."""
        captured = self._capture(RunRequest(model="seedream-5.0-lite", prompt="a hero"))
        self.assertNotIn("image", captured["params"])


class InlineImageProvenanceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.provider = runner.PegGMICloudImageProvider(api_key="test-key")

    def test_verified_image_is_replaced_by_a_content_hash_marker(self) -> None:
        encoded = png_b64()
        normalized = self.provider.normalize_params({"image": encoded}, Modality.IMAGE)

        self.assertNotEqual(normalized["image"], encoded)
        self.assertRegex(normalized["image"], r"^peg-inline-image-sha256:[0-9a-f]{64}$")

    def test_pipeline_accepts_an_image_with_a_credential_shaped_collision(self) -> None:
        encoded = credential_collision_png_b64()
        self.assertIn("AIza" + "A" * 32, encoded)
        pipeline = Pipeline("test", preflight=False).step(
            self.provider,
            model="gemini-3.1-flash-image",
            prompt="a hero",
            modality=Modality.IMAGE,
            params={"image": encoded},
        )

        step = pipeline._build_step(pipeline._steps[0])

        self.assertRegex(step.params["image"], r"^peg-inline-image-sha256:[0-9a-f]{64}$")

    def test_gemini_receives_native_inline_data_contents(self) -> None:
        encoded = png_b64()
        normalized = self.provider.normalize_params({"image": encoded}, Modality.IMAGE)
        step = Step(
            provider=self.provider.name,
            model="gemini-3.1-flash-image",
            prompt="a hero",
            modality=Modality.IMAGE,
            params=normalized,
        )

        payload = self.provider.prepare_payload(step)

        self.assertNotIn("image", payload)
        self.assertNotIn("prompt", payload)
        parts = payload["contents"][0]["parts"]
        self.assertEqual(parts[0], {"text": "a hero"})
        self.assertIn("COMPOSITION REFERENCE", parts[1]["text"])
        self.assertEqual(
            parts[2], {"inlineData": {"mimeType": "image/png", "data": encoded}}
        )
        self.assertIn("Generate the final image", parts[3]["text"])
        self.assertNotIn(encoded, step.params.values())

    def test_bria_keeps_the_proven_raw_base64_contract(self) -> None:
        encoded = png_b64()
        normalized = self.provider.normalize_params({"image": encoded}, Modality.IMAGE)
        step = Step(
            provider=self.provider.name,
            model="bria-genfill",
            prompt="extend the empty backdrop",
            modality=Modality.IMAGE,
            params=normalized,
        )

        payload = self.provider.prepare_payload(step)

        self.assertEqual(payload["image"], encoded)

    def test_non_image_value_is_left_for_genblaze_to_reject(self) -> None:
        credential_shaped = "AIza" + "A" * 35

        normalized = self.provider.normalize_params(
            {"image": credential_shaped}, Modality.IMAGE
        )

        self.assertEqual(normalized["image"], credential_shaped)
        pipeline = Pipeline("test", preflight=False).step(
            self.provider,
            model="gemini-3.1-flash-image",
            prompt="a hero",
            modality=Modality.IMAGE,
            params=normalized,
        )
        with self.assertRaisesRegex(GenblazeError, "looks like an API credential"):
            pipeline._build_step(pipeline._steps[0])

    def test_marker_changes_when_image_content_changes(self) -> None:
        first = png_b64()
        buf = io.BytesIO()
        Image.new("RGB", (8, 8), (90, 20, 160)).save(buf, format="PNG")
        second = base64.b64encode(buf.getvalue()).decode()

        marker_a = self.provider.normalize_params({"image": first})["image"]
        marker_b = self.provider.normalize_params({"image": second})["image"]

        self.assertNotEqual(marker_a, marker_b)


if __name__ == "__main__":
    unittest.main()
