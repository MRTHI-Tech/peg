"""PEG generation service.

Genblaze is Python-only and a single generation takes minutes, which is well
past any serverless timeout — so this runs as a persistent service and the API
is submit-then-poll rather than request-response.

    POST /runs        -> {run_id, status: "queued"}   returns immediately
    GET  /runs/{id}   -> {status, asset?, provenance?, error?}
    POST /enhance     -> {brief, original, model}      text-only, answers directly
    GET  /health

The Next.js route handlers proxy to this; the browser never sees it directly and
no credential ever leaves the server.
"""

from __future__ import annotations

import asyncio
import base64
import os
import uuid
from dataclasses import asdict
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware

import brand
import enhance as enhance_module
import runner
import workflows
from schemas import (
    AssetKindIn,
    BrandAssetIn,
    BrandIn,
    EnhanceRequest,
    EnhanceResponse,
    RunRequest,
    RunResponse,
    RunStatus,
    WorkflowIn,
)

# In-memory job store. Fine for a single instance; if this ever runs replicated,
# move it to Redis or the B2 manifest index.
_JOBS: dict[str, RunResponse] = {}
_LOCK = asyncio.Lock()

# Generation is slow and the upstream is flaky, so cap how many run at once.
_SEMAPHORE = asyncio.Semaphore(int(os.environ.get("PEG_MAX_CONCURRENT_RUNS", "3")))


@asynccontextmanager
async def lifespan(_: FastAPI):
    missing = [
        k
        for k in ("GMI_API_KEY", "B2_KEY_ID", "B2_APP_KEY", "B2_BUCKET", "B2_REGION")
        if not os.environ.get(k)
    ]
    if missing:
        # Fail loudly at boot rather than on the first user-visible run.
        raise RuntimeError(f"missing required env vars: {', '.join(missing)}")
    yield


app = FastAPI(title="PEG generation service", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o for o in os.environ.get("PEG_ALLOWED_ORIGINS", "*").split(",") if o],
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["*"],
)


async def _execute(job_id: str, req: RunRequest, workspace: str) -> None:
    async with _SEMAPHORE:
        async with _LOCK:
            _JOBS[job_id].status = RunStatus.running

        try:
            # Genblaze blocks; keep it off the event loop.
            outcome = await asyncio.to_thread(runner.execute, req, workspace)
        except Exception as exc:  # noqa: BLE001 — surface the real cause to the UI
            async with _LOCK:
                job = _JOBS[job_id]
                job.status = RunStatus.error
                job.error = f"{type(exc).__name__}: {exc}"
            return

        async with _LOCK:
            job = _JOBS[job_id]
            job.status = RunStatus.complete
            job.attempts = outcome.attempts
            job.asset = outcome.asset
            job.provenance = outcome.provenance
            job.warnings = outcome.warnings


def require_token(x_peg_token: str | None = Header(default=None)) -> None:
    """Shared-secret gate on anything that costs money.

    Render's private services are a paid feature, so on the free tier this
    service has a public URL. Without this, the generation endpoints would be an
    open door onto someone else's GMI credits.

    Unset means open, which keeps local development frictionless — but the
    deployed blueprint always sets it.
    """
    expected = os.environ.get("PEG_SERVICE_TOKEN", "").strip()
    if not expected:
        return
    if x_peg_token != expected:
        raise HTTPException(status_code=401, detail="invalid or missing service token")


def require_workspace(x_peg_workspace: str | None = Header(default=None)) -> str:
    """Whose data this request touches.

    Resolved by peg-web from the Clerk session and passed on; this service never
    talks to Clerk. It is a header rather than a body field so it cannot be
    confused with anything the browser composed.

    Note this trusts peg-web. Anyone holding PEG_SERVICE_TOKEN could name any
    workspace directly — acceptable while the token is ours alone, and the fix
    is for this service to verify the Clerk token itself.
    """
    workspace = (x_peg_workspace or "").strip()
    if not workspace:
        raise HTTPException(status_code=400, detail="missing workspace")
    if "/" in workspace:
        raise HTTPException(status_code=400, detail="invalid workspace")
    return workspace


@app.get("/health")
async def health() -> dict:
    async with _LOCK:
        active = sum(1 for j in _JOBS.values() if j.status == RunStatus.running)
    return {
        "status": "ok",
        "bucket": os.environ.get("B2_BUCKET"),
        "active_runs": active,
        "expand_configured": bool(os.environ.get("BRIA_API_TOKEN", "").strip()),
        "enhance_configured": bool(os.environ.get("GMI_API_KEY", "").strip()),
    }


@app.get("/brand")
async def get_brand(
    workspace: str = Depends(require_workspace), _: None = Depends(require_token)
) -> dict:
    """The workspace brand. A first-run workspace returns an empty one, not 404."""
    b = await asyncio.to_thread(brand.load_brand, workspace)
    return {**asdict(b), "is_complete": b.is_complete()}


@app.put("/brand")
async def put_brand(
    payload: BrandIn,
    workspace: str = Depends(require_workspace),
    _: None = Depends(require_token),
) -> dict:
    def _save() -> None:
        current = brand.load_brand(workspace)
        current.name = payload.name
        current.typography = brand.Typography(**payload.typography.model_dump())
        # Assets are owned by /brand/assets. A save only carries the text fields,
        # so an in-flight upload from another tab is not clobbered by a stale
        # client copy of the asset lists.
        brand.save_brand(workspace, current)

    await asyncio.to_thread(_save)
    fresh = await asyncio.to_thread(brand.load_brand, workspace)
    return {**asdict(fresh), "is_complete": fresh.is_complete()}


@app.post("/brand/assets", status_code=201)
async def add_brand_asset(
    payload: BrandAssetIn,
    workspace: str = Depends(require_workspace),
    _: None = Depends(require_token),
) -> dict:
    """Store one asset and, for style references, extract its palette.

    Palette extraction is deterministic and model-free, so it happens inline
    rather than as another job to poll.
    """

    def _add() -> dict:
        asset = brand.upload_asset(
            workspace,
            payload.data_b64,
            payload.filename,
            payload.content_type,
            kind=payload.kind,
        )
        current = brand.load_brand(workspace)
        palette: list[str] = []
        if payload.kind != brand.STYLE_KIND:
            current.composites.append(asset)
        else:
            if not brand.is_svg(payload.filename, payload.content_type):
                palette = brand.extract_palette(base64.b64decode(payload.data_b64))
            # Recorded on the asset so a later removal can take these colours
            # back out; the brand-wide list is the merge of all of them.
            asset.palette = palette
            current.style_references.append(asset)
            # Not a plain merge: references saved before palettes were recorded
            # per asset contribute nothing until backfilled, and would otherwise
            # silently drop their colours the moment a second reference lands.
            brand.recompute_palette(current)
        brand.save_brand(workspace, current)
        return {
            "asset": asdict(asset),
            "extracted_palette": palette,
            "brand_palette": current.palette,
        }

    try:
        return await asyncio.to_thread(_add)
    except brand.BrandError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.patch("/brand/assets")
async def relabel_brand_asset(
    payload: AssetKindIn,
    workspace: str = Depends(require_workspace),
    _: None = Depends(require_token),
) -> dict:
    """Change what a composite is. Placement depends on it; the file does not move."""
    try:
        fresh = await asyncio.to_thread(
            brand.set_asset_kind, workspace, payload.asset_key, payload.kind
        )
    except brand.BrandError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {**asdict(fresh), "is_complete": fresh.is_complete()}


@app.delete("/brand/assets")
async def delete_brand_asset(
    asset_key: str,
    workspace: str = Depends(require_workspace),
    _: None = Depends(require_token),
) -> dict:
    """Remove one asset from the brand and the bucket, and rebuild the palette."""
    try:
        fresh = await asyncio.to_thread(brand.remove_asset, workspace, asset_key)
    except brand.BrandError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {**asdict(fresh), "is_complete": fresh.is_complete()}


@app.post("/enhance", response_model=EnhanceResponse)
async def enhance_brief(
    payload: EnhanceRequest,
    workspace: str = Depends(require_workspace),
    _: None = Depends(require_token),
) -> EnhanceResponse:
    """Rewrite a rough brief as art direction, in the workspace's brand.

    Answers directly rather than joining the submit-then-poll job store: this is
    one text call of a few seconds, and making the user poll for a paragraph
    would be the slower experience by some margin.

    The brand is loaded here rather than sent by the browser, for the same
    reason generation loads it here — the workspace owns it, and a client copy
    could name a palette this workspace does not have.
    """
    try:
        current = await asyncio.to_thread(brand.load_brand, workspace)
    except Exception:  # noqa: BLE001 — a brand-less workspace still gets a rewrite
        current = None

    try:
        text, model = await asyncio.to_thread(
            enhance_module.enhance,
            payload.brief,
            current=current,
            spec=payload.format,
            intent=payload.intent,
        )
    except enhance_module.EnhanceError as exc:
        # These messages are written to be read by the person who typed the
        # brief, so they travel as 400 rather than a generic 500.
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return EnhanceResponse(brief=text, original=payload.brief.strip(), model=model)


@app.get("/projects")
async def list_projects(
    workspace: str = Depends(require_workspace), _: None = Depends(require_token)
) -> dict:
    """What this workspace has actually generated.

    A workspace that has run nothing returns an empty list — the gallery's empty
    state is real storage being empty, not a first-run flag.
    """
    runs = await asyncio.to_thread(runner.list_runs, workspace)
    return {"projects": runs}


@app.get("/workflows")
async def get_workflows(
    workspace: str = Depends(require_workspace), _: None = Depends(require_token)
) -> dict:
    """Every editable canvas owned by this workspace."""
    items = await asyncio.to_thread(workflows.list_workflows, workspace)
    return {"workflows": items}


@app.get("/workflows/{workflow_id}")
async def get_workflow(
    workflow_id: str,
    workspace: str = Depends(require_workspace),
    _: None = Depends(require_token),
) -> dict:
    try:
        return await asyncio.to_thread(workflows.load_workflow, workspace, workflow_id)
    except workflows.WorkflowNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except workflows.WorkflowError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.put("/workflows/{workflow_id}")
async def put_workflow(
    workflow_id: str,
    payload: WorkflowIn,
    workspace: str = Depends(require_workspace),
    _: None = Depends(require_token),
) -> dict:
    try:
        return await asyncio.to_thread(
            workflows.save_workflow,
            workspace,
            workflow_id,
            payload.model_dump(),
        )
    except workflows.WorkflowError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/runs", response_model=RunResponse, status_code=202)
async def create_run(
    req: RunRequest,
    workspace: str = Depends(require_workspace),
    _: None = Depends(require_token),
) -> RunResponse:
    job_id = f"job_{uuid.uuid4().hex[:12]}"
    job = RunResponse(run_id=job_id, node_id=req.node_id, status=RunStatus.queued)
    async with _LOCK:
        _JOBS[job_id] = job

    # Detached on purpose: the caller polls rather than waiting.
    asyncio.create_task(_execute(job_id, req, workspace))
    return job


@app.get("/runs/{job_id}", response_model=RunResponse)
async def get_run(job_id: str, _: None = Depends(require_token)) -> RunResponse:
    async with _LOCK:
        job = _JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="unknown run")
    return job
