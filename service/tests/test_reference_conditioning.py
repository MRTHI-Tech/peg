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
from schemas import RunRequest  # noqa: E402


def png_b64() -> str:
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (10, 140, 90)).save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


class ReferenceReachesTheModel(unittest.TestCase):
    def _capture(self, req: RunRequest) -> dict:
        captured: dict = {}

        def fake_submit(model, prompt, params, workspace):
            captured.update(model=model, prompt=prompt, params=params)
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


if __name__ == "__main__":
    unittest.main()
