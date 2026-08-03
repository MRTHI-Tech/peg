from __future__ import annotations

import base64
import io
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import runner  # noqa: E402
from genblaze_core.models import StepType  # noqa: E402
from schemas import AssetOut, FormatSpec, ProvenanceOut, RunRequest  # noqa: E402


CYAN = (3, 241, 244)


def _framed_source() -> bytes:
    image = Image.new("RGB", (500, 500), CYAN)
    draw = ImageDraw.Draw(image)
    draw.rectangle((14, 14, 485, 485), fill=(74, 58, 41))
    draw.rectangle((396, 396, 485, 485), fill=CYAN)
    draw.rectangle((420, 425, 470, 470), fill=(8, 5, 12))
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


class _FakeProvider:
    instances: list[_FakeProvider] = []

    def __init__(self, api_token, output_dir, **kwargs):
        self.api_token = api_token
        self.output_dir = Path(output_dir)
        self.finalize_output = kwargs["finalize_output"]
        self.input_roots = kwargs["input_roots"]
        self.closed = False
        self.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.closed = True


class _FakePipeline:
    captured: dict = {}

    def __init__(self, name, **kwargs):
        self.captured = {"name": name, "pipeline_kwargs": kwargs}
        type(self).captured = self.captured

    def step(self, provider, **kwargs):
        source = kwargs["external_inputs"][0]
        source_path = Path(source.url.removeprefix("file://"))
        source_raw = source_path.read_bytes()
        with Image.open(io.BytesIO(source_raw)) as image:
            self.captured["source_size"] = image.size
        self.captured.update(kwargs)
        self.captured["source_metadata"] = dict(source.metadata)
        self.captured["provider"] = provider

        params = kwargs["params"]
        inner = Image.new(
            "RGB", (params["canvas_width"], params["canvas_height"]), (120, 90, 40)
        )
        finalized = provider.finalize_output(inner)
        self.captured["final_size"] = finalized.size
        self.captured["final_corners"] = [
            finalized.getpixel((0, 0)),
            finalized.getpixel((finalized.width - 1, finalized.height - 1)),
        ]
        return self

    def run(self, **kwargs):
        self.captured["run_kwargs"] = kwargs
        return SimpleNamespace(run=SimpleNamespace(run_id="direct-expand-run"))


class RunnerOutpaintTests(unittest.TestCase):
    def setUp(self) -> None:
        _FakeProvider.instances.clear()
        _FakePipeline.captured = {}

    def test_extend_canvas_uses_direct_expand_and_finalizes_brand_chrome(self) -> None:
        request = RunRequest(
            operation="outpaint",
            source_b64=base64.b64encode(_framed_source()).decode(),
            prompt="Continue the empty wet road",
            negative_prompt="new vehicles",
            params={"seed": 17, "strength": 0.9},
            format=FormatSpec(
                width=1000,
                height=500,
                focal_point="right",
                safe_area="left-third",
            ),
        )
        asset = AssetOut(
            asset_key="peg/workspaces/test/runs/output.png",
            bucket="test",
            url="https://example.invalid/output.png",
            width=1000,
            height=500,
        )

        with (
            patch.dict("os.environ", {"BRIA_API_TOKEN": "direct-token"}),
            patch.object(runner, "BriaExpandProvider", _FakeProvider),
            patch.object(runner, "Pipeline", _FakePipeline),
            patch.object(runner, "_sink", return_value=object()),
            patch.object(
                runner,
                "_collect_run_output",
                return_value=(
                    asset,
                    ProvenanceOut(run_id="direct-expand-run", model=runner.EXPAND_MODEL),
                ),
            ),
        ):
            outcome = runner.run_outpaint(request, "test")

        captured = _FakePipeline.captured
        self.assertEqual(outcome.run_id, "direct-expand-run")
        self.assertEqual(captured["name"], "peg-expand")
        self.assertEqual(captured["model"], "bria-expand-v2")
        self.assertEqual(captured["step_type"], StepType.EDIT)
        self.assertEqual(captured["source_size"], (472, 472))
        self.assertEqual(captured["final_size"], (1000, 500))
        self.assertEqual(captured["final_corners"], [CYAN, CYAN])
        self.assertEqual(
            captured["source_metadata"]["asset_key"],
            f"inline-sha256:{__import__('hashlib').sha256(_framed_source()).hexdigest()}",
        )
        self.assertEqual(captured["params"]["seed"], 17)
        self.assertIn("new vehicles", captured["params"]["negative_prompt"])
        self.assertNotIn("strength", captured["params"])
        self.assertNotIn("image", captured["params"])
        self.assertNotIn("mask", captured["params"])
        self.assertTrue(_FakeProvider.instances[0].closed)

    def test_missing_direct_credential_fails_before_processing(self) -> None:
        request = RunRequest(
            operation="outpaint",
            source_b64=base64.b64encode(_framed_source()).decode(),
            format=FormatSpec(width=1000, height=500),
        )

        with patch.dict("os.environ", {"BRIA_API_TOKEN": ""}):
            with self.assertRaisesRegex(runner.RunFailed, "BRIA_API_TOKEN"):
                runner.run_outpaint(request, "test")

    def test_unachievable_safe_area_is_rejected_without_calling_provider(self) -> None:
        source = io.BytesIO()
        Image.new("RGB", (500, 500), (40, 50, 60)).save(source, format="PNG")
        request = RunRequest(
            operation="outpaint",
            source_b64=base64.b64encode(source.getvalue()).decode(),
            format=FormatSpec(
                width=600,
                height=500,
                focal_point="right",
                safe_area="left-third",
            ),
        )

        with (
            patch.dict("os.environ", {"BRIA_API_TOKEN": "direct-token"}),
            patch.object(runner, "BriaExpandProvider", _FakeProvider),
        ):
            with self.assertRaisesRegex(runner.RunFailed, "overlaps"):
                runner.run_outpaint(request, "test")

        self.assertEqual(_FakeProvider.instances, [])


if __name__ == "__main__":
    unittest.main()
