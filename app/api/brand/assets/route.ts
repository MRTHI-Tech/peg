import {NextResponse} from 'next/server';

import {SERVICE_HEADERS, SERVICE_URL} from '@/lib/service-config';

/**
 * Upload one brand asset.
 *
 * Bodies carry a base64 image, so the timeout is generous relative to the other
 * proxies — but the work itself (store plus palette extraction) is deterministic
 * and fast, so this stays request/response rather than becoming a polled job.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({error: 'invalid JSON body'}, {status: 400});
  }

  try {
    const upstream = await fetch(`${SERVICE_URL}/brand/assets`, {
      method: 'POST',
      headers: SERVICE_HEADERS,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const data = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      return NextResponse.json(
        {error: (data as {detail?: string})?.detail ?? `service returned ${upstream.status}`},
        {status: upstream.status},
      );
    }
    return NextResponse.json(data, {status: 201});
  } catch (error) {
    return NextResponse.json(
      {error: `generation service unreachable: ${(error as Error).message}`},
      {status: 503},
    );
  }
}
