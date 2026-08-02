import {NextResponse} from 'next/server';

import {SERVICE_HEADERS, SERVICE_URL} from '@/lib/service-config';

/** Read the workspace brand. Empty on first run rather than a 404. */
export async function GET() {
  try {
    const upstream = await fetch(`${SERVICE_URL}/brand`, {
      cache: 'no-store',
      headers: SERVICE_HEADERS,
      signal: AbortSignal.timeout(20_000),
    });
    const data = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      return NextResponse.json(
        {error: (data as {detail?: string})?.detail ?? `service returned ${upstream.status}`},
        {status: upstream.status},
      );
    }
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json(
      {error: `generation service unreachable: ${(error as Error).message}`},
      {status: 503},
    );
  }
}

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({error: 'invalid JSON body'}, {status: 400});
  }

  try {
    const upstream = await fetch(`${SERVICE_URL}/brand`, {
      method: 'PUT',
      headers: SERVICE_HEADERS,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      return NextResponse.json(
        {error: (data as {detail?: string})?.detail ?? `service returned ${upstream.status}`},
        {status: upstream.status},
      );
    }
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json(
      {error: `generation service unreachable: ${(error as Error).message}`},
      {status: 503},
    );
  }
}
