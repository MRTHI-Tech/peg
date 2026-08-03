from __future__ import annotations

import base64
import hashlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

import httpx
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bria_expand import BRIA_EXPAND_URL, BriaExpandProvider  # noqa: E402
from genblaze_core.models import Asset, Modality, StepStatus  # noqa: E402
from genblaze_core.models.enums import ProviderErrorCode  # noqa: E402
from genblaze_core.models.step import Step  # noqa: E402
from genblaze_core.providers.retry import RetryPolicy  # noqa: E402


REQUEST_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
STATUS_URL = f"https://engine.prod.bria-api.com/v2/status/{REQUEST_ID}"
OUTPUT_URL = "https://bria-datasets.s3.us-east-1.amazonaws.com/results/expanded.png"
TOKEN = "test-bria-token-that-must-never-be-persisted"


def _png(size: tuple[int, int], colour: tuple[int, int, int]) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, colour).save(buffer, format="PNG")
    return buffer.getvalue()


def _params(**extra: int) -> dict[str, int]:
    return {
        "canvas_width": 972,
        "canvas_height": 472,
        "original_width": 472,
        "original_height": 472,
        "original_x": 500,
        "original_y": 0,
        **extra,
    }


class BriaExpandProviderTests(unittest.TestCase):
    def _step(self, root: Path, **params: int) -> tuple[Step, bytes]:
        source = _png((472, 472), (30, 80, 120))
        path = root / "source.png"
        path.write_bytes(source)
        asset = Asset(url=path.resolve().as_uri(), media_type="image/png")
        asset.set_hash(source)
        return (
            Step(
                provider="bria-direct",
                model="bria-expand-v2",
                modality=Modality.IMAGE,
                prompt="Continue only the empty parking area and morning light",
                negative_prompt="duplicate vans, inset image, seam",
                seed=17,
                params=_params(**params),
                inputs=[asset],
            ),
            source,
        )

    @staticmethod
    def _provider(
        root: Path,
        handler,
        *,
        finalize_output=None,
        retry_policy: RetryPolicy | None = None,
    ) -> BriaExpandProvider:
        client = httpx.Client(transport=httpx.MockTransport(handler))
        provider = BriaExpandProvider(
            f"  {TOKEN}  ",
            root / "output",
            http_client=client,
            finalize_output=finalize_output,
            input_roots=(root,),
            retry_policy=retry_policy or RetryPolicy.disabled(),
        )
        provider.poll_interval = 0
        return provider

    def test_async_lifecycle_hashes_finalized_asset_without_persisting_inline_data(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            step, source = self._step(root)
            raw_output = _png((972, 472), (120, 90, 40))
            requests: list[httpx.Request] = []
            polls = 0

            def handler(request: httpx.Request) -> httpx.Response:
                nonlocal polls
                requests.append(request)
                if request.method == "POST":
                    return httpx.Response(
                        202,
                        json={"request_id": REQUEST_ID, "status_url": STATUS_URL},
                    )
                if str(request.url) == STATUS_URL:
                    polls += 1
                    if polls == 1:
                        return httpx.Response(
                            200,
                            json={"request_id": REQUEST_ID, "status": "IN_PROGRESS"},
                        )
                    return httpx.Response(
                        200,
                        json={
                            "request_id": REQUEST_ID,
                            "status": "COMPLETED",
                            "result": {"image_url": OUTPUT_URL, "seed": 17},
                        },
                    )
                if str(request.url) == OUTPUT_URL:
                    return httpx.Response(200, content=raw_output, headers={"content-type": "image/png"})
                return httpx.Response(404)

            def finalize(image: Image.Image) -> Image.Image:
                self.assertEqual(image.size, (972, 472))
                canvas = Image.new("RGB", (1000, 500), (0, 255, 255))
                canvas.paste(image, (14, 14))
                return canvas

            provider = self._provider(root, handler, finalize_output=finalize)
            result = provider.invoke(step, {"timeout": 5})

            self.assertEqual(result.status, StepStatus.SUCCEEDED)
            self.assertEqual(len(result.assets), 1)
            asset = result.assets[0]
            self.assertEqual((asset.width, asset.height), (1000, 500))
            self.assertEqual(asset.media_type, "image/png")
            self.assertRegex(asset.sha256 or "", r"^[0-9a-f]{64}$")
            output = Path(asset.url.removeprefix("file://"))
            output_bytes = output.read_bytes()
            self.assertEqual(asset.sha256, hashlib.sha256(output_bytes).hexdigest())
            self.assertEqual(asset.size_bytes, len(output_bytes))
            with Image.open(output) as image:
                self.assertEqual(image.size, (1000, 500))

            post = requests[0]
            body = json.loads(post.content)
            self.assertEqual(str(post.url), BRIA_EXPAND_URL)
            self.assertEqual(body["canvas_size"], [972, 472])
            self.assertEqual(body["original_image_size"], [472, 472])
            self.assertEqual(body["original_image_location"], [500, 0])
            self.assertEqual(body["prompt"], step.prompt)
            self.assertEqual(body["negative_prompt"], step.negative_prompt)
            self.assertEqual(body["seed"], 17)
            self.assertFalse(body["sync"])
            self.assertEqual(base64.b64decode(body["image"]), source)
            self.assertEqual(post.headers["api_token"], TOKEN)
            download = next(request for request in requests if str(request.url) == OUTPUT_URL)
            self.assertNotIn("api_token", download.headers)

            serialized = result.model_dump_json()
            self.assertNotIn(TOKEN, serialized)
            self.assertNotIn(body["image"], serialized)
            self.assertNotIn("image_url", serialized)
            self.assertEqual(result.provider_payload["request_id"], REQUEST_ID)

    def test_provider_rejects_untrusted_status_endpoint_without_calling_it(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            step, _ = self._step(root)
            seen: list[str] = []

            def handler(request: httpx.Request) -> httpx.Response:
                seen.append(str(request.url))
                if request.method == "POST":
                    return httpx.Response(
                        202,
                        json={
                            "request_id": REQUEST_ID,
                            "status_url": "https://attacker.example/status/job",
                        },
                    )
                return httpx.Response(500)

            result = self._provider(root, handler).invoke(step, {"timeout": 5})

            self.assertEqual(result.status, StepStatus.FAILED)
            self.assertEqual(result.error_code, ProviderErrorCode.UNKNOWN)
            self.assertNotIn(STATUS_URL, seen)
            self.assertFalse(any("attacker.example" in url for url in seen))

    def test_rejects_untrusted_result_url_without_downloading_it(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            step, _ = self._step(root)
            seen: list[str] = []

            def handler(request: httpx.Request) -> httpx.Response:
                seen.append(str(request.url))
                if request.method == "POST":
                    return httpx.Response(202, json={"request_id": REQUEST_ID})
                return httpx.Response(
                    200,
                    json={
                        "request_id": REQUEST_ID,
                        "status": "COMPLETED",
                        "result": {"image_url": "https://attacker.example/private.png"},
                    },
                )

            result = self._provider(root, handler).invoke(step, {"timeout": 5})

            self.assertEqual(result.status, StepStatus.FAILED)
            self.assertEqual(result.error_code, ProviderErrorCode.INVALID_INPUT)
            self.assertFalse(any("attacker.example" in url for url in seen))

    def test_poll_and_download_retries_never_repeat_the_paid_post(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            step, _ = self._step(root)
            counts = {"post": 0, "status": 0, "download": 0}

            def handler(request: httpx.Request) -> httpx.Response:
                if request.method == "POST":
                    counts["post"] += 1
                    return httpx.Response(202, json={"request_id": REQUEST_ID})
                if str(request.url) == STATUS_URL:
                    counts["status"] += 1
                    if counts["status"] == 1:
                        return httpx.Response(503)
                    return httpx.Response(
                        200,
                        json={
                            "request_id": REQUEST_ID,
                            "status": "COMPLETED",
                            "result": {"image_url": OUTPUT_URL},
                        },
                    )
                counts["download"] += 1
                if counts["download"] == 1:
                    return httpx.Response(503)
                return httpx.Response(200, content=_png((972, 472), (50, 60, 70)))

            policy = RetryPolicy(
                max_attempts=2,
                initial_backoff_sec=0,
                max_backoff_sec=0,
                jitter="none",
            )
            result = self._provider(root, handler, retry_policy=policy).invoke(
                step, {"timeout": 5, "max_retries": 2}
            )

            self.assertEqual(result.status, StepStatus.SUCCEEDED)
            self.assertEqual(counts, {"post": 1, "status": 2, "download": 2})

    def test_ambiguous_submit_failure_is_not_retried(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            step, _ = self._step(root)
            posts = 0

            def handler(request: httpx.Request) -> httpx.Response:
                nonlocal posts
                posts += 1
                raise httpx.ConnectError("connection dropped", request=request)

            policy = RetryPolicy(
                max_attempts=3,
                initial_backoff_sec=0,
                max_backoff_sec=0,
                jitter="none",
            )
            result = self._provider(root, handler, retry_policy=policy).invoke(
                step, {"timeout": 5, "max_retries": 3}
            )

            self.assertEqual(result.status, StepStatus.FAILED)
            self.assertEqual(result.error_code, ProviderErrorCode.UNKNOWN)
            self.assertEqual(posts, 1)

    def test_rejects_wrong_raw_output_dimensions_before_finalizing(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            step, _ = self._step(root)
            finalized = False

            def handler(request: httpx.Request) -> httpx.Response:
                if request.method == "POST":
                    return httpx.Response(
                        200,
                        json={
                            "request_id": REQUEST_ID,
                            "result": {"image_url": OUTPUT_URL},
                        },
                    )
                return httpx.Response(200, content=_png((971, 472), (1, 2, 3)))

            def finalize(image: Image.Image) -> Image.Image:
                nonlocal finalized
                finalized = True
                return image

            result = self._provider(root, handler, finalize_output=finalize).invoke(
                step, {"timeout": 5}
            )

            self.assertEqual(result.status, StepStatus.FAILED)
            self.assertEqual(result.error_code, ProviderErrorCode.INVALID_INPUT)
            self.assertFalse(finalized)
            self.assertFalse((root / "output").exists())

    def test_seed_in_params_is_forwarded_when_step_seed_is_absent(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            step, _ = self._step(root, seed=99)
            step.seed = None
            submitted: dict = {}
            media_url = "https://cdn.bria.media/results/expanded.png"

            def handler(request: httpx.Request) -> httpx.Response:
                if request.method == "POST":
                    submitted.update(json.loads(request.content))
                    return httpx.Response(
                        200,
                        json={
                            "request_id": REQUEST_ID,
                            "result": {"image_url": media_url},
                        },
                    )
                if str(request.url) == media_url:
                    return httpx.Response(200, content=_png((972, 472), (1, 2, 3)))
                return httpx.Response(404)

            result = self._provider(root, handler).invoke(step, {"timeout": 5})

            self.assertEqual(result.status, StepStatus.SUCCEEDED)
            self.assertEqual(submitted["seed"], 99)

    def test_status_body_request_id_is_per_call_and_must_not_gate_the_poll(self) -> None:
        """Bria mints a new `request_id` for every status GET.

        Verified live on 2026-08-04: three GETs against one finished job
        returned three different ids, none of them the job's. Treating that
        field as a correlation check rejected a job that had actually
        completed, so the only correlation is the URL we build ourselves.
        """
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            step, _ = self._step(root)
            polls = 0

            def handler(request: httpx.Request) -> httpx.Response:
                nonlocal polls
                if request.method == "POST":
                    return httpx.Response(202, json={"request_id": REQUEST_ID})
                if str(request.url) == STATUS_URL:
                    polls += 1
                    return httpx.Response(
                        200,
                        json={
                            # Deliberately never REQUEST_ID, and different each call.
                            "request_id": f"per-call-{polls:032d}",
                            "status": "IN_PROGRESS" if polls == 1 else "COMPLETED",
                            "result": {"image_url": OUTPUT_URL},
                        },
                    )
                if str(request.url) == OUTPUT_URL:
                    return httpx.Response(200, content=_png((972, 472), (7, 7, 7)))
                return httpx.Response(404)

            result = self._provider(root, handler).invoke(step, {"timeout": 5})

            self.assertEqual(result.status, StepStatus.SUCCEEDED)
            self.assertGreaterEqual(polls, 2)

    def test_api_may_resize_source_to_requested_original_size(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            step, _ = self._step(root, original_width=400)
            submitted: dict = {}

            def handler(request: httpx.Request) -> httpx.Response:
                if request.method == "POST":
                    submitted.update(json.loads(request.content))
                    return httpx.Response(
                        200,
                        json={
                            "request_id": REQUEST_ID,
                            "result": {"image_url": OUTPUT_URL},
                        },
                    )
                return httpx.Response(200, content=_png((972, 472), (1, 2, 3)))

            result = self._provider(root, handler).invoke(step, {"timeout": 5})

            self.assertEqual(result.status, StepStatus.SUCCEEDED)
            self.assertEqual(submitted["original_image_size"], [400, 472])

    def test_default_input_allowlist_is_the_output_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            output_dir = root / "staged"
            output_dir.mkdir()
            source = _png((472, 472), (10, 20, 30))
            source_path = output_dir / "source.png"
            source_path.write_bytes(source)
            asset = Asset(url=source_path.resolve().as_uri(), media_type="image/png")
            asset.set_hash(source)
            step = Step(
                provider="bria-direct",
                model="bria-expand-v2",
                modality=Modality.IMAGE,
                params=_params(),
                inputs=[asset],
            )

            def handler(request: httpx.Request) -> httpx.Response:
                if request.method == "POST":
                    return httpx.Response(
                        200,
                        json={
                            "request_id": REQUEST_ID,
                            "result": {"image_url": OUTPUT_URL},
                        },
                    )
                return httpx.Response(200, content=_png((972, 472), (1, 2, 3)))

            client = httpx.Client(transport=httpx.MockTransport(handler))
            provider = BriaExpandProvider(TOKEN, output_dir, http_client=client)
            result = provider.invoke(step, {"timeout": 5})

            self.assertEqual(result.status, StepStatus.SUCCEEDED)

    def test_pipeline_manifest_preserves_input_and_output_provenance(self) -> None:
        from genblaze_core.pipeline import Pipeline

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            step, _ = self._step(root)

            def handler(request: httpx.Request) -> httpx.Response:
                if request.method == "POST":
                    return httpx.Response(
                        200,
                        json={
                            "request_id": REQUEST_ID,
                            "result": {"image_url": OUTPUT_URL},
                        },
                    )
                return httpx.Response(200, content=_png((972, 472), (1, 2, 3)))

            provider = self._provider(root, handler)
            result = (
                Pipeline("bria-expand-contract", preflight=False)
                .step(
                    provider,
                    model="bria-expand-v2",
                    modality=Modality.IMAGE,
                    prompt=step.prompt,
                    negative_prompt=step.negative_prompt,
                    seed=step.seed,
                    params=step.params,
                    external_inputs=step.inputs,
                )
                .run(raise_on_failure=True, progress=False)
            )

            recorded = result.run.steps[0]
            self.assertEqual(len(recorded.inputs), 1)
            self.assertEqual(len(recorded.assets), 1)
            self.assertTrue(result.manifest.verify())
            serialized = result.manifest.model_dump_json()
            self.assertNotIn(TOKEN, serialized)
            self.assertNotIn("image_url", serialized)


if __name__ == "__main__":
    unittest.main()
