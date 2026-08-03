/**
 * What a workspace has actually generated.
 *
 * Server-side only. This is the first list in the app backed by real storage
 * rather than fixtures — which is why a brand-new workspace shows an empty
 * gallery without any first-run flag: its prefix simply has nothing under it.
 */
import {SERVICE_TIMEOUT_MS, SERVICE_URL, serviceHeaders} from './service-config';
import {currentWorkspace} from './workspace';

export interface Generation {
  run_id: string;
  /** The date segment of the storage key, `YYYY-MM-DD`. */
  created_at: string;
  asset_key: string;
  asset_count: number;
  /** Presigned; the bucket is private. */
  url: string;
}

export interface GenerationList {
  generations: Generation[];
  /**
   * Whether storage actually answered.
   *
   * The distinction is load-bearing: "you have made nothing yet" and "we could
   * not reach your storage" both produce an empty array, and on Render's free
   * tier the second happens every time the service has idled down. Presenting a
   * timeout as an empty gallery would be the app quietly lying about a
   * workspace's contents.
   */
  reachable: boolean;
}

export async function listGenerations(): Promise<GenerationList> {
  const workspace = await currentWorkspace();
  if (!workspace) return {generations: [], reachable: true};

  try {
    const response = await fetch(`${SERVICE_URL}/projects`, {
      cache: 'no-store',
      headers: serviceHeaders(workspace),
      signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
    });
    if (!response.ok) return {generations: [], reachable: false};
    const body = (await response.json()) as {projects?: Generation[]};
    return {generations: body.projects ?? [], reachable: true};
  } catch {
    // Still not worth failing the page over — but the caller is told, so it can
    // say so instead of implying the workspace is empty.
    return {generations: [], reachable: false};
  }
}
