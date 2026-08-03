/**
 * What a workspace has actually generated.
 *
 * Server-side only. This is the first list in the app backed by real storage
 * rather than fixtures — which is why a brand-new workspace shows an empty
 * gallery without any first-run flag: its prefix simply has nothing under it.
 */
import {SERVICE_URL, serviceHeaders} from './service-config';
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

export async function listGenerations(): Promise<Generation[]> {
  const workspace = await currentWorkspace();
  if (!workspace) return [];

  try {
    const response = await fetch(`${SERVICE_URL}/projects`, {
      cache: 'no-store',
      headers: serviceHeaders(workspace),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as {projects?: Generation[]};
    return body.projects ?? [];
  } catch {
    // A gallery is not worth failing a page over, and an unreachable service is
    // indistinguishable from an empty bucket from the reader's point of view.
    return [];
  }
}
