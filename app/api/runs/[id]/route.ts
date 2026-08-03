import {NextResponse} from 'next/server';

import {SERVICE_URL, serviceHeaders} from '@/lib/service-config';
import {currentWorkspace, unauthorized} from '@/lib/workspace';

/** Poll one run. The client calls this on an interval until it settles. */
export async function GET(_request: Request, {params}: {params: Promise<{id: string}>}) {
  const {id} = await params;

  const workspace = await currentWorkspace();
  if (!workspace) return unauthorized();

  try {
    const upstream = await fetch(`${SERVICE_URL}/runs/${encodeURIComponent(id)}`, {
      cache: 'no-store',
      headers: serviceHeaders(workspace),
      signal: AbortSignal.timeout(15_000),
    });

    if (upstream.status === 404) {
      return NextResponse.json({error: 'unknown run'}, {status: 404});
    }

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
