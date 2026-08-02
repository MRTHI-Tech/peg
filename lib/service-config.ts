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

const TOKEN = (process.env.PEG_SERVICE_TOKEN ?? '').trim();

export const SERVICE_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  ...(TOKEN ? {'X-PEG-Token': TOKEN} : {}),
};
