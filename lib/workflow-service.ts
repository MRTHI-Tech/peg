/**
 * The single boundary between the UI and the backend.
 *
 * Reads (workflows, gallery) still resolve from fixtures in `mock-data.ts`.
 * Writes — actual generation — now go through the Next.js route handlers to the
 * Python Genblaze service, which is the only thing that can run the SDK.
 *
 * Generation is submit-then-poll: a run takes minutes, so `startRun` returns an
 * id immediately and `pollRun` reports progress until it settles.
 */

import {HERO_WORKFLOW, WORKFLOWS} from './mock-data';
import type {AssetRef, Provenance, Workflow} from './types';

export function listWorkflows(): Workflow[] {
  return WORKFLOWS;
}

export function getWorkflow(id: string): Workflow | undefined {
  return WORKFLOWS.find(w => w.id === id) ?? (id === HERO_WORKFLOW.id ? HERO_WORKFLOW : undefined);
}

// ------------------------------------------------------------------- running

export type RunStatus = 'queued' | 'running' | 'complete' | 'error';

/** Target geometry handed to an outpaint, from the Format node. */
export interface RunFormat {
  width: number;
  height: number;
  focal_point: 'left' | 'center' | 'right';
  safe_area: 'left-third' | 'right-third' | 'upper-third' | 'lower-third' | 'center';
}

export interface RunRequest {
  operation?: 'generate' | 'outpaint';
  node_id?: string;
  model: string;
  prompt?: string;
  negative_prompt?: string;
  params?: Record<string, string | number | boolean>;
  image_b64?: string;
  /** outpaint: recompose an asset already in storage onto `format`. */
  source_asset_key?: string;
  format?: RunFormat;
}

export interface RunResult {
  run_id: string;
  node_id?: string;
  status: RunStatus;
  attempts: number;
  error?: string | null;
  asset?: {
    asset_key: string;
    bucket: string;
    url: string;
    width?: number | null;
    height?: number | null;
    bytes?: number | null;
    content_type?: string;
  } | null;
  provenance?: {
    run_id: string;
    manifest_key?: string | null;
    manifest_url?: string | null;
    canonical_hash?: string | null;
    verified?: boolean | null;
    provider?: string | null;
    model?: string | null;
    created_at?: string | null;
  } | null;
}

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as {error?: string} | null;
  return body?.error ?? `request failed (${response.status})`;
}

export async function startRun(request: RunRequest): Promise<RunResult> {
  const response = await fetch('/api/runs', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}

export async function pollRun(runId: string): Promise<RunResult> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`, {cache: 'no-store'});
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}

export interface RunOptions {
  /** Fired on every poll so the node can show queued vs running. */
  onProgress?: (result: RunResult) => void;
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Submit and poll until the run settles. Throws on error or timeout. */
export async function executeRun(
  request: RunRequest,
  {onProgress, intervalMs = 4000, timeoutMs = 10 * 60 * 1000, signal}: RunOptions = {},
): Promise<RunResult> {
  const submitted = await startRun(request);
  onProgress?.(submitted);

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw new Error('run cancelled');
    if (Date.now() > deadline) throw new Error('run timed out');

    await new Promise(resolve => setTimeout(resolve, intervalMs));
    if (signal?.aborted) throw new Error('run cancelled');

    const current = await pollRun(submitted.run_id);
    onProgress?.(current);

    if (current.status === 'complete') return current;
    if (current.status === 'error') throw new Error(current.error ?? 'generation failed');
  }
}

/** Map a completed run onto the shapes the canvas already renders. */
export function toAssetRef(result: RunResult): AssetRef | undefined {
  const a = result.asset;
  if (!a) return undefined;
  return {
    assetKey: a.asset_key,
    bucket: a.bucket,
    contentType: a.content_type ?? 'image/png',
    bytes: a.bytes ?? undefined,
    url: a.url,
    width: a.width ?? undefined,
    height: a.height ?? undefined,
  };
}

export function toProvenance(result: RunResult, nodeId: string): Provenance | undefined {
  const p = result.provenance;
  if (!p) return undefined;
  return {
    runId: p.run_id,
    nodeId,
    producedBy: {provider: p.provider ?? 'gmicloud-image', model: p.model ?? ''},
    inputAssetKeys: [],
    params: {},
    createdAt: p.created_at ?? new Date().toISOString(),
    manifestKey: p.manifest_key ?? undefined,
    verified: p.verified ?? undefined,
  };
}
