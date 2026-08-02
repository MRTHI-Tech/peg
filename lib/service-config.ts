/**
 * Where the Python Genblaze service lives.
 *
 * Server-side only — imported by route handlers, never by a component.
 *
 * Render's `fromService` injects a bare `host:port` with no scheme, while local
 * development sets a full URL, so both shapes are accepted rather than letting
 * a schemeless value fail at fetch time.
 */
function normalize(raw: string): string {
  const trimmed = raw.trim().replace(/\/$/, '');
  if (!trimmed) return 'http://127.0.0.1:8010';
  return /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
}

export const SERVICE_URL = normalize(process.env.PEG_SERVICE_URL ?? 'http://127.0.0.1:8010');
