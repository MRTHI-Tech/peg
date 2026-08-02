/**
 * Where the Python Genblaze service lives.
 *
 * Server-side only — this is imported by route handlers, never by a component.
 * On Render both services run in the same project, so this becomes the internal
 * service URL rather than a public one.
 */
export const SERVICE_URL = (
  process.env.PEG_SERVICE_URL ?? 'http://127.0.0.1:8010'
).replace(/\/$/, '');
