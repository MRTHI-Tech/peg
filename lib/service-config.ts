/**
 * Where the Python Genblaze service lives, and how we authenticate to it.
 *
 * Server-side only — imported by route handlers, never by a component.
 *
 * The service has a public URL because Render's private services are a paid
 * feature. A shared secret keeps the generation endpoints from being an open
 * door onto our provider credits; it never reaches the browser.
 */
function normalize(raw: string): string {
  const trimmed = raw.trim().replace(/\/$/, '');
  if (!trimmed) return 'http://127.0.0.1:8010';
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export const SERVICE_URL = normalize(process.env.PEG_SERVICE_URL ?? 'http://127.0.0.1:8010');

/**
 * How long to wait on peg-service before giving up.
 *
 * Sized for a cold start, not a warm request. Render's free tier idles the
 * service after ~15 minutes and waking it was measured at 31s against the live
 * deploy — AGENTS.md documents 50s+. The previous 15–30s ceilings meant the
 * first request after idle always failed, which read as "the service is broken"
 * rather than "the service is waking up".
 */
export const SERVICE_TIMEOUT_MS = 75_000;

const TOKEN = (process.env.PEG_SERVICE_TOKEN ?? '').trim();

export const SERVICE_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  ...(TOKEN ? {'X-PEG-Token': TOKEN} : {}),
};

/**
 * Headers for a request acting on one workspace's data.
 *
 * The workspace travels as a header rather than in the body so it can never be
 * confused with something the browser composed — the browser never sees it, and
 * the service refuses any request that arrives without one.
 */
export function serviceHeaders(workspace: string): Record<string, string> {
  return {...SERVICE_HEADERS, 'X-PEG-Workspace': workspace};
}
