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


class BrandAssetIn(BaseModel):
    """One uploaded brand file, base64-encoded.

    `is_logo` routes it: logos are composited on top of a plate and must never
    condition generation, because a logo used as a style reference produces
    garbled logo-like shapes.
    """

    filename: str = Field(max_length=200)
    content_type: str = Field(default="image/png", max_length=100)
    data_b64: str
    is_logo: bool = False


class TypographyIn(BaseModel):
    """Captured for the live-text layer. Never sent to a model."""

    heading: str = ""
    body: str = ""
    notes: str = ""


class BrandIn(BaseModel):
    name: str = ""
    description: str = ""
    palette: list[str] = Field(default_factory=list)
    style_references: list[dict] = Field(default_factory=list)
    logos: list[dict] = Field(default_factory=list)
    typography: TypographyIn = Field(default_factory=TypographyIn)


class RunResponse(BaseModel):
    run_id: str
    node_id: str | None = None
    status: RunStatus
    attempts: int = 0
    error: str | None = None
    asset: AssetOut | None = None
    provenance: ProvenanceOut | None = None
