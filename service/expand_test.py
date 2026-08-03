"""Expand a square plate into a wide hero banner against the live Bria API.

Why this matters: no GMI image model honours a dimension parameter, so hitting
an exact breakpoint means growing the canvas rather than asking for a size. The
first attempt at that used `bria-genfill` with a feathered mask, and it failed
in a way unit tests cannot catch — given a large empty region genfill invents a
*second, separate scene* beside the source instead of continuing the original.
Bria's purpose-built `/v2/image/edit/expand` endpoint takes the canvas, the
rendered source size, and its location as explicit geometry, which is what this
script exists to keep honest.

It drives the real shipping stack — `prepare_expand` → `BriaExpandProvider` →
`finalize_expand` — minus the B2 sink, so a failure here is a failure of the
model or the geometry rather than of storage.

    ./service/.venv/bin/python service/expand_test.py [source.png]

Costs one paid Bria request. Requires `BRIA_API_TOKEN`.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env.local")
sys.path.insert(0, str(Path(__file__).resolve().parent))

from PIL import Image  # noqa: E402

from genblaze_core.models import Asset, Modality  # noqa: E402
from genblaze_core.models.step import Step  # noqa: E402

from bria_expand import BriaExpandProvider  # noqa: E402
from expand_geometry import (  # noqa: E402
    finalize_expand,
    prepare_expand,
    safe_area_overlap,
)
from runner import DEFAULT_NEGATIVE, EXPAND_MODEL, EXPAND_PROMPT  # noqa: E402
from schemas import FormatSpec  # noqa: E402

SCRATCH = Path(
    "/private/tmp/claude-501/-Users-tlotliso-Desktop-peg2"
    "/d36090e6-55b9-4763-b1fb-56c7d29c2439/scratchpad"
)
DEFAULT_SOURCE = SCRATCH / "smoke.jpg"

# The same 1920x600 hero the old genfill script targeted, so results compare
# directly: source flush right, headline space opening on the left.
FORMAT = FormatSpec(width=1920, height=600, focal_point="right", safe_area="left-third")

POLL_TIMEOUT = 300.0


def main() -> int:
    token = os.environ.get("BRIA_API_TOKEN", "").strip()
    if not token:
        print("[FAIL] BRIA_API_TOKEN is unset — add it to .env.local")
        return 1

    source_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SOURCE
    if not source_path.exists():
        print(f"missing {source_path} — run smoke_test.py first, or pass a path")
        return 1

    with Image.open(source_path) as image:
        plan = prepare_expand(image.convert("RGB"), FORMAT)

    print(f"source {source_path.name} -> target {plan.target_size[0]}x{plan.target_size[1]}")
    print(
        f"  model canvas {plan.canvas_size[0]}x{plan.canvas_size[1]}, "
        f"source rendered {plan.original_image_size[0]}x{plan.original_image_size[1]} "
        f"at {plan.original_image_location}"
    )
    if plan.frame is not None:
        print(f"  detected flat frame, rebuilt locally with insets {plan.frame_insets}")
    if plan.badge is not None:
        print(f"  detected corner lockup, locked to bottom-right at {plan.badge.final_location}")

    # run_outpaint rejects this rather than shipping a headline over the subject;
    # the script reports it so a bad source is obvious before spending a request.
    overlap = safe_area_overlap(plan)
    if overlap.overlaps:
        print(f"[FAIL] {FORMAT.safe_area} safe area covers {overlap.pixels} protected pixels")
        return 1

    output_dir = SCRATCH if SCRATCH.exists() else ROOT / "service"
    staged = output_dir / "expand_input.png"
    staged.write_bytes(plan.model_input)
    asset = Asset(url=staged.resolve().as_uri(), media_type="image/png")
    asset.set_hash(plan.model_input)

    step = Step(
        provider="bria-direct",
        model=EXPAND_MODEL,
        modality=Modality.IMAGE,
        prompt=EXPAND_PROMPT,
        negative_prompt=DEFAULT_NEGATIVE,
        params=plan.provider_params(),
        inputs=[asset],
    )

    with BriaExpandProvider(
        token,
        output_dir,
        input_roots=(output_dir,),
        finalize_output=lambda expanded: finalize_expand(expanded, plan),
    ) as provider:
        print(f"submitting {EXPAND_MODEL} ({len(plan.model_input):,} bytes)…")
        # Deliberately not retried: the POST is the paid, unsafe-to-repeat half.
        request_id = provider.submit(step)
        print(f"  request_id={request_id}")

        deadline = time.monotonic() + POLL_TIMEOUT
        while not provider.poll(request_id):
            if time.monotonic() > deadline:
                print(f"[FAIL] still IN_PROGRESS after {POLL_TIMEOUT:.0f}s")
                return 1
            time.sleep(provider.poll_interval)

        step = provider.fetch_output(request_id, step)

    result = step.assets[-1]
    out = Path(result.url.removeprefix("file://"))
    print(f"[ok] {out}")
    print(f"  result size: {result.width}x{result.height}  (target {FORMAT.width}x{FORMAT.height})")
    if (result.width, result.height) != (FORMAT.width, FORMAT.height):
        print("[FAIL] finalized image is not the requested breakpoint")
        return 1

    print("\nInspect the image for the failure genfill had: the source must read as")
    print("one continuous photograph, not a second scene pasted beside the original.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
