import {NextResponse} from 'next/server';

import {SERVICE_HEADERS, SERVICE_URL} from '@/lib/service-config';

/**
 * Submit a generation run.
 *
 * A thin proxy to the Python Genblaze service. It exists so the browser never
 * holds a credential and never needs to know where the service lives — the
 * service URL and every API key stay server-side.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({error: 'invalid JSON body'}, {status: 400});
  }

  try {
    const upstream = await fetch(`${SERVICE_URL}/runs`, {
      method: 'POST',
      headers: SERVICE_HEADERS,
      body: JSON.stringify(body),
      // Submission returns immediately; the long work happens behind polling.
      signal: AbortSignal.timeout(30_000),
    });

    const data = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      return NextResponse.json(
        {error: (data as {detail?: string})?.detail ?? `service returned ${upstream.status}`},
        {status: upstream.status},
      );
    }
    return NextResponse.json(data, {status: 202});
  } catch (error) {
    // Most often the service simply is not running.
    return NextResponse.json(
      {error: `generation service unreachable: ${(error as Error).message}`},
      {status: 503},
    );
  }
}
