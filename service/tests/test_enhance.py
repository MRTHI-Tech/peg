from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import brand  # noqa: E402
import enhance  # noqa: E402
from schemas import FormatSpec  # noqa: E402


DESKTOP = FormatSpec(width=1920, height=600, focal_point="right", safe_area="left-third")


class UserTurnTests(unittest.TestCase):
    """What the model is told about this brief, short of calling it."""

    def test_palette_travels_as_hex(self) -> None:
        """Named hex is the mechanism that actually holds — see AGENTS.md."""
        current = brand.Brand(name="Halo", palette=["#1B1035", "#E4572E"])

        turn = enhance.build_user_turn("premium savings", current=current)

        self.assertIn("#1B1035", turn)
        self.assertIn("#E4572E", turn)

    def test_target_canvas_becomes_composition_direction(self) -> None:
        """The point of the whole feature: a brief that knows its breakpoint."""
        turn = enhance.build_user_turn("premium savings", spec=DESKTOP)

        self.assertIn("1920 by 600", turn)
        self.assertIn("right of centre", turn)
        self.assertIn("left third of the frame", turn)

    def test_portrait_and_landscape_read_as_different_canvases(self) -> None:
        wide = enhance.build_user_turn("x", spec=DESKTOP)
        tall = enhance.build_user_turn(
            "x",
            spec=FormatSpec(width=1080, height=1920, focal_point="center", safe_area="upper-third"),
        )

        self.assertIn("extremely wide banner", wide)
        self.assertIn("portrait canvas", tall)

    def test_brief_survives_verbatim(self) -> None:
        """Enhancement adds craft; it must not quietly restate the ask."""
        turn = enhance.build_user_turn("launch the Tembo card in Maseru", spec=DESKTOP)

        self.assertIn("launch the Tembo card in Maseru", turn)

    def test_unknown_intent_passes_through_rather_than_vanishing(self) -> None:
        turn = enhance.build_user_turn("x", intent="Editorial portrait")

        self.assertIn("Editorial portrait", turn)

    def test_a_workspace_without_a_brand_still_gets_a_turn(self) -> None:
        turn = enhance.build_user_turn("premium savings", current=None, spec=None)

        self.assertIn("premium savings", turn)

    def test_typography_is_direction_never_a_font_request(self) -> None:
        """Fonts are never sent to a model — see brand.Typography."""
        current = brand.Brand(typography=brand.Typography(heading="serif"))

        turn = enhance.build_user_turn("x", current=current)

        self.assertIn("Never render any type in the image", turn)


class SystemInstructionTests(unittest.TestCase):
    def test_forbids_conjuring_brand_assets(self) -> None:
        """The one rule AGENTS.md says is non-negotiable."""
        self.assertIn("Never name a brand asset the model has not been shown", enhance.SYSTEM_INSTRUCTION)

    def test_forbids_rendered_text(self) -> None:
        self.assertIn("Never ask for text", enhance.SYSTEM_INSTRUCTION)


class ResponseHandlingTests(unittest.TestCase):
    def test_reads_the_paragraph(self) -> None:
        payload = {"choices": [{"message": {"content": "  A wide plate.  "}}]}

        self.assertEqual(enhance._extract_text(payload), "A wide plate.")

    def test_strips_the_quotes_models_add_anyway(self) -> None:
        payload = {"choices": [{"message": {"content": '"A wide plate."'}}]}

        self.assertEqual(enhance._extract_text(payload), "A wide plate.")

    def test_a_thinking_model_that_ran_out_of_room_is_not_silent_success(self) -> None:
        """Empty content with finish_reason=length is a real outcome, not a bug."""
        payload = {"choices": [{"message": {"content": ""}, "finish_reason": "length"}]}

        with self.assertRaises(enhance.EnhanceError) as caught:
            enhance._extract_text(payload)
        self.assertIn("ran out of room", str(caught.exception))

    def test_a_refusal_says_so(self) -> None:
        payload = {"choices": [{"message": {"content": ""}, "finish_reason": "content_filter"}]}

        with self.assertRaises(enhance.EnhanceError) as caught:
            enhance._extract_text(payload)
        self.assertIn("refused", str(caught.exception))

    def test_no_choices_at_all(self) -> None:
        with self.assertRaises(enhance.EnhanceError):
            enhance._extract_text({"choices": []})


class GuardTests(unittest.TestCase):
    def test_an_empty_brief_is_refused_before_the_call(self) -> None:
        with self.assertRaises(enhance.EnhanceError):
            enhance.enhance("   ", api_key="test-key")

    def test_an_oversized_brief_is_refused_before_the_call(self) -> None:
        with self.assertRaises(enhance.EnhanceError) as caught:
            enhance.enhance("x" * (enhance.MAX_BRIEF_CHARS + 1), api_key="test-key")
        self.assertIn("too long", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
