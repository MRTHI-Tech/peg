"""Request and response shapes for the PEG generation service.

Deliberately mirrors the node catalog in lib/catalog.ts: a RunRequest is one
node's worth of work, so the UI can submit whatever the user selected without
the service needing to know about the graph.
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field


class RunStatus(str, Enum):
    queued = "queued"
    running = "running"
    complete = "complete"
    error = "error"


class FormatSpec(BaseModel):
    """Target breakpoint geometry, from the Format node."""

    width: int = Field(ge=64, le=4096)
    height: int = Field(ge=64, le=4096)
    focal_point: Literal["left", "center", "right"] = "right"
    safe_area: Literal["left-third", "right-third", "upper-third", "lower-third", "center"] = (
        "left-third"
    )


class RunRequest(BaseModel):
    """One unit of work.

    `generate` produces a plate at the model's native size. `outpaint` takes an
    existing asset and recomposes it onto a target breakpoint — the only way to
    hit exact dimensions, since no GMI image model honours size parameters.
    """

    operation: Literal["generate", "outpaint"] = "generate"
    node_id: str | None = None
    model: str = "seedream-5.0-lite"
    prompt: str = ""
    negative_prompt: str | None = None
    params: dict[str, Any] = Field(default_factory=dict)

    # generate: optional reference image, base64 (no data: prefix).
    image_b64: str | None = None

    # outpaint: the plate to recompose, plus where it should land.
    source_asset_key: str | None = None
    source_b64: str | None = None
    format: FormatSpec | None = None


class AssetOut(BaseModel):
    """A produced asset, as stored in B2."""

    asset_key: str
    bucket: str
    url: str  # presigned; the bucket is private
    width: int | None = None
    height: int | None = None
    bytes: int | None = None
    content_type: str = "image/png"


class ProvenanceOut(BaseModel):
    """Enough of the Genblaze manifest to render the inspector's provenance panel."""

    run_id: str
    manifest_key: str | None = None
    manifest_url: str | None = None
    canonical_hash: str | None = None
    verified: bool | None = None
    provider: str | None = None
    model: str | None = None
    created_at: str | None = None


AssetKind = Literal["style", "logo", "screenshot", "product", "other"]


class BrandAssetIn(BaseModel):
    """One uploaded brand file, base64-encoded.

    `kind` routes it. A `style` asset teaches the look; a `logo` may be supplied
    to a capable model as separately labelled identity artwork. Composite assets
    remain the approved originals used for deterministic final placement.
    """

    filename: str = Field(max_length=200)
    content_type: str = Field(default="image/png", max_length=100)
    data_b64: str
    kind: AssetKind = "logo"


class AssetKindIn(BaseModel):
    """Relabel an already-uploaded composite. `style` is not reachable — the two
    lanes are separated on purpose and a file crosses them by being re-uploaded."""

    asset_key: str
    kind: Literal["logo", "screenshot", "product", "other"]


class TypographyIn(BaseModel):
    """Captured for the live-text layer. Never sent to a model.

    Values are classifications, not typeface names — see brand.TYPE_CLASSES.
    """

    heading: str = ""
    body: str = ""
    notes: str = ""


class BrandIn(BaseModel):
    """The editable half of a brand.

    Assets and the palette derived from them are owned by /brand/assets and are
    deliberately absent here: a save carries only what the form can change.

    `description` is absent for a different reason — the form no longer asks for
    it, so accepting it would let an empty default silently erase a stored look.
    """

    name: str = ""
    typography: TypographyIn = Field(default_factory=TypographyIn)


class RunResponse(BaseModel):
    run_id: str
    node_id: str | None = None
    status: RunStatus
    attempts: int = 0
    error: str | None = None
    asset: AssetOut | None = None
    provenance: ProvenanceOut | None = None
