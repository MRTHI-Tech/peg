"""Turn a rough brief into an art-direction prompt.

The people writing briefs in PEG are marketers, not art directors. They type
"make it look premium" and the image model gives back exactly the generic plate
that phrase deserves. This module does the translation a studio would do in the
room: it reads the workspace brand and the target breakpoint, and rewrites the
sentence into the paragraph a model can actually execute.

Two things make this worth a model call rather than a template:

- **The brand is already known.** Palette hexes, the brand name, and any stored
  look description come from the same `Brand` document every generation locks
  against, so the enhanced brief cannot drift from the plate it produces.
- **The canvas is already known.** A brief that reads well says nothing about
  where the product sits. Folding in the target's safe area and focal point is
  what makes "compose, don't crop" survive the trip from words to pixels.

Text-only, so it does not go through Genblaze — that is an image pipeline with
manifests and B2 writes, none of which applies to a paragraph. Nothing produced
here is stored server-side; the enhanced brief goes straight back to the canvas
for the user to accept or discard.

It runs on GMI's OpenAI-compatible chat API rather than Google's own, so the key
already paying for generation pays for this too and PEG stays a one-credential
deployment.
"""

from __future__ import annotations

import os

import httpx

def _api_root() -> str:
    return (os.environ.get("GMI_BASE_URL", "").strip() or "https://api.gmi-serving.com/v1").rstrip(
        "/"
    )


# Chosen by measuring against real briefs, not by reputation. The flash-lite
# tier answers in about four seconds with no reasoning tokens, which matters for
# a button someone is waiting on; the full flash models spend ten seconds
# thinking to produce a paragraph of comparable quality.
#
# Overridable, but note the compatibility layer is thin: some models on this
# endpoint reject `temperature`, and the GPT tier wants max_completion_tokens
# instead of max_tokens. Changing this is a change worth testing.
DEFAULT_MODEL = os.environ.get("PEG_TEXT_MODEL", "").strip() or "google/gemini-3.5-flash-lite"

# A brief is one paragraph. The headroom is for models that think before
# answering — with a tight budget those return empty, having spent it all
# reasoning.
MAX_OUTPUT_TOKENS = 4000

TIMEOUT_SECONDS = 60.0

# Long enough to be worth enhancing, short enough that a pasted novel does not
# become the system prompt.
MAX_BRIEF_CHARS = 4000

# What the model is told it is doing. The prohibitions are not stylistic
# preferences — each one is a failure this pipeline has actually produced.
SYSTEM_INSTRUCTION = """\
You are a senior art director writing the brief that a text-to-image model will \
execute. Your input is a rough brief from a marketer who is not a designer. Your \
job is to turn it into art direction precise enough to generate from, without \
inventing a campaign they did not ask for.

Always specify, in this order and as flowing prose: the scene and subject; the \
composition, including where the subject sits in frame; the camera, meaning lens \
length, angle, and distance; the lighting, including its direction and quality; \
the materials and surfaces; the colour treatment; and the mood.

Hard rules:

- Never name a brand asset the model has not been shown. Do not write "the \
Acme logo" or "their app icon". Approved logos and products are composited onto \
the plate afterwards, so describe the space they will occupy instead.
- Never ask for text, words, lettering, numerals, or typography in the image. \
Headlines are a live text layer over the plate.
- Use any brand palette hex values given to you verbatim, as hex.
- Keep the named copy-safe area visually quiet: no busy detail, no high \
contrast, nothing the subject or its shadow crosses. A headline sits there.
- Place the subject at the named focal point.
- Keep what the brief actually asked for. Add craft, not new ideas. If the \
brief names a product, a season, or an audience, those survive verbatim.

Reply with the brief only: one paragraph, 70 to 140 words, plain declarative \
sentences. No preamble, no markdown, no headings, no bullet points, no quotes \
around the paragraph, no commentary about what you changed.\
"""

# How the node's Intent parameter changes the job. Free-text intents are passed
# through as-is, so the canvas can grow new ones without editing this map.
INTENT_DIRECTION = {
    "Campaign hero": (
        "This is a campaign hero plate: one clear subject, generous negative "
        "space, and a composition that survives having a headline laid over it."
    ),
    "Product beauty": (
        "This is a product beauty shot: the product is the entire subject, shot "
        "close, lit to flatter its material and edges, on a controlled surface."
    ),
    "Abstract background": (
        "This is an abstract background plate: no literal subject, no product. "
        "Texture, gradient, light, and form only, quiet enough to sit behind copy."
    ),
    "Lifestyle": (
        "This is a lifestyle scene: real people in a believable moment, the "
        "product present but not staged, natural light, documentary framing."
    ),
}

SAFE_AREA_PHRASE = {
    "left-third": "the left third of the frame",
    "right-third": "the right third of the frame",
    "upper-third": "the top third of the frame",
    "lower-third": "the bottom third of the frame",
    "center": "the centre of the frame",
}

FOCAL_POINT_PHRASE = {
    "left": "left of centre",
    "center": "centred",
    "right": "right of centre",
}


class EnhanceError(RuntimeError):
    """The brief could not be enhanced. Carries a message fit to show a user."""


def _shape_of(width: int, height: int) -> str:
    """How a designer would name the canvas, not its pixel count.

    The model reasons better about "a wide banner" than about 1920x600, and the
    ratio is what actually decides whether a composition survives.
    """
    ratio = width / height if height else 1.0
    if ratio >= 2.4:
        return "an extremely wide banner"
    if ratio >= 1.6:
        return "a wide landscape canvas"
    if ratio >= 1.15:
        return "a landscape canvas"
    if ratio > 0.87:
        return "a square canvas"
    if ratio > 0.6:
        return "a portrait canvas"
    return "a tall, narrow portrait canvas"


def brand_context(current) -> list[str]:
    """What the brand contributes, as lines for the user turn.

    Takes a loaded `Brand` rather than a workspace so this stays testable
    without B2, and so a workspace with no brand simply contributes nothing.
    """
    lines: list[str] = []
    if current is None:
        return lines

    name = (current.name or "").strip()
    if name:
        lines.append(f"Brand: {name}.")

    description = (current.description or "").strip()
    if description:
        lines.append(f"Brand look: {description}")

    palette = [c for c in (current.palette or []) if c]
    if palette:
        lines.append(
            "Brand palette, to be named verbatim in the brief: " + ", ".join(palette) + "."
        )

    # Typography is metadata and never reaches an image model — but the class
    # tells the art director how much room the headline needs and how formal
    # the plate should read, which is direction, not a font request.
    typography = getattr(current, "typography", None)
    heading = (getattr(typography, "heading", "") or "").strip()
    if heading:
        lines.append(
            f"Headline type is {heading}; the plate should suit it. "
            "Never render any type in the image."
        )
    return lines


def format_context(spec) -> list[str]:
    """What the target breakpoint contributes.

    This is the half a generic prompt improver cannot do. `spec` is a
    `FormatSpec`, or None when the brief is not yet wired to a canvas.
    """
    if spec is None:
        return []

    shape = _shape_of(spec.width, spec.height)
    safe_area = SAFE_AREA_PHRASE.get(spec.safe_area, spec.safe_area)
    focal = FOCAL_POINT_PHRASE.get(spec.focal_point, spec.focal_point)
    return [
        f"Target canvas: {spec.width} by {spec.height} pixels — {shape}.",
        f"Compose the subject {focal}.",
        f"Keep {safe_area} clear and quiet; the headline sits there.",
    ]


def build_user_turn(brief: str, *, current=None, spec=None, intent: str = "") -> str:
    """Assemble everything the model is given about this specific brief."""
    lines: list[str] = []

    intent = (intent or "").strip()
    if intent:
        lines.append(INTENT_DIRECTION.get(intent, f"Intent: {intent}."))

    lines.extend(brand_context(current))
    lines.extend(format_context(spec))

    lines.append("Rough brief to rewrite:")
    lines.append(brief.strip())
    return "\n\n".join(lines)


def _extract_text(payload: dict) -> str:
    """Pull the paragraph out of a chat-completions response.

    Defensive because empty content is a real outcome, not a malformed response:
    a thinking model that spends its whole token budget reasoning returns a
    choice with no content and `length` as the finish reason.
    """
    choices = payload.get("choices") or []
    if not choices:
        raise EnhanceError("the model returned no response")

    choice = choices[0]
    text = ((choice.get("message") or {}).get("content") or "").strip()

    if not text:
        reason = choice.get("finish_reason") or "unknown"
        if reason == "length":
            raise EnhanceError("the model ran out of room before writing the brief")
        if reason == "content_filter":
            raise EnhanceError("the brief was refused by the model")
        raise EnhanceError(f"the model returned no text ({reason})")

    # Models like to wrap a single-paragraph answer in quotes despite being told
    # not to. Cheaper to strip than to re-prompt.
    if len(text) > 1 and text[0] in "\"'" and text[-1] == text[0]:
        text = text[1:-1].strip()
    return text


def enhance(
    brief: str,
    *,
    current=None,
    spec=None,
    intent: str = "",
    model: str = "",
    api_key: str = "",
) -> tuple[str, str]:
    """Rewrite `brief` as art direction. Returns (enhanced brief, model used).

    Raises EnhanceError with a message safe to surface in the UI.
    """
    brief = (brief or "").strip()
    if not brief:
        raise EnhanceError("write a line or two first, then enhance it")
    if len(brief) > MAX_BRIEF_CHARS:
        raise EnhanceError(f"brief is too long to enhance (limit {MAX_BRIEF_CHARS} characters)")

    key = (api_key or os.environ.get("GMI_API_KEY", "")).strip()
    if not key:
        raise EnhanceError("brief enhancement is not configured (GMI_API_KEY is unset)")

    model = (model or DEFAULT_MODEL).strip() or DEFAULT_MODEL
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_INSTRUCTION},
            {
                "role": "user",
                "content": build_user_turn(brief, current=current, spec=spec, intent=intent),
            },
        ],
        # Enough variation to sound written rather than assembled, low enough
        # that the same brief twice does not describe two different campaigns.
        "temperature": 0.7,
        "max_tokens": MAX_OUTPUT_TOKENS,
    }

    try:
        response = httpx.post(
            f"{_api_root()}/chat/completions",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json=body,
            timeout=TIMEOUT_SECONDS,
        )
    except httpx.HTTPError as exc:
        raise EnhanceError(f"could not reach the text model: {exc}") from exc

    if response.status_code >= 400:
        detail = ""
        try:
            detail = (response.json().get("error") or {}).get("message", "")
        except Exception:  # noqa: BLE001 — an error body that is not JSON is still an error
            detail = response.text[:200]
        raise EnhanceError(f"text model returned {response.status_code}: {detail}".strip())

    return _extract_text(response.json()), model
