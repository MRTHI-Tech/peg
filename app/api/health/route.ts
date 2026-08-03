import {NextResponse} from 'next/server';

import {SERVICE_HEADERS, SERVICE_TIMEOUT_MS, SERVICE_URL} from '@/lib/service-config';

/**
 * Deployment diagnostics.
 *
 * Reports whether the app can actually reach the generation service, and which
 * address it resolved. Without this, a misconfigured `PEG_SERVICE_URL` looks
 * identical to a dead service — both surface as "fetch failed" on a run, with
 * no way to tell them apart from outside the platform.
 *
 * Never returns the shared token, only whether one is configured.
 */
export async function GET() {
  const diagnostics = {
    app: 'ok',
    serviceUrl: SERVICE_URL,
    tokenConfigured: 'X-PEG-Token' in SERVICE_HEADERS,
    service: 'unknown' as string,
    detail: null as string | null,
  };

  try {
    const upstream = await fetch(`${SERVICE_URL}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
    });
    diagnostics.service = upstream.ok ? 'ok' : `http ${upstream.status}`;
    diagnostics.detail = await upstream.text().then(t => t.slice(0, 200));
  } catch (error) {
    diagnostics.service = 'unreachable';
    diagnostics.detail = (error as Error).message;
  }

  return NextResponse.json(diagnostics, {
    status: diagnostics.service === 'ok' ? 200 : 503,
  });
}
