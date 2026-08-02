"""PEG generation service.

Genblaze is Python-only and a single generation takes minutes, which is well
past any serverless timeout — so this runs as a persistent service and the API
is submit-then-poll rather than request-response.

    POST /runs        -> {run_id, status: "queued"}   returns immediately
    GET  /runs/{id}   -> {status, asset?, provenance?, error?}
    GET  /health

The Next.js route handlers proxy to this; the browser never sees it directly and
no credential ever leaves the server.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware

import runner
from schemas import RunRequest, RunResponse, RunStatus

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
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


async def _execute(job_id: str, req: RunRequest) -> None:
    async with _SEMAPHORE:
        async with _LOCK:
            _JOBS[job_id].status = RunStatus.running

        try:
            # Genblaze blocks; keep it off the event loop.
            outcome = await asyncio.to_thread(runner.execute, req)
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


@app.get("/health")
async def health() -> dict:
    async with _LOCK:
        active = sum(1 for j in _JOBS.values() if j.status == RunStatus.running)
    return {"status": "ok", "bucket": os.environ.get("B2_BUCKET"), "active_runs": active}


@app.post("/runs", response_model=RunResponse, status_code=202)
async def create_run(req: RunRequest, _: None = Depends(require_token)) -> RunResponse:
    job_id = f"job_{uuid.uuid4().hex[:12]}"
    job = RunResponse(run_id=job_id, node_id=req.node_id, status=RunStatus.queued)
    async with _LOCK:
        _JOBS[job_id] = job

    # Detached on purpose: the caller polls rather than waiting.
    asyncio.create_task(_execute(job_id, req))
    return job


@app.get("/runs/{job_id}", response_model=RunResponse)
async def get_run(job_id: str, _: None = Depends(require_token)) -> RunResponse:
    async with _LOCK:
        job = _JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="unknown run")
    return job
