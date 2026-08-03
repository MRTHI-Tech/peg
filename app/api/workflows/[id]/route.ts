import {NextResponse} from 'next/server';

import {SERVICE_TIMEOUT_MS, SERVICE_URL, serviceHeaders} from '@/lib/service-config';
import {currentWorkspace, unauthorized} from '@/lib/workspace';

type RouteContext = {params: Promise<{id: string}>};

async function proxy(
  id: string,
  workspace: string,
  init: {method?: 'PUT'; body?: string} = {},
) {
  try {
    const upstream = await fetch(`${SERVICE_URL}/workflows/${encodeURIComponent(id)}`, {
      ...init,
      cache: 'no-store',
      headers: serviceHeaders(workspace),
      signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
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

export async function GET(_: Request, {params}: RouteContext) {
  const workspace = await currentWorkspace();
  if (!workspace) return unauthorized();
  const {id} = await params;
  return proxy(id, workspace);
}

export async function PUT(request: Request, {params}: RouteContext) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({error: 'invalid JSON body'}, {status: 400});
  }

  const workspace = await currentWorkspace();
  if (!workspace) return unauthorized();
  const {id} = await params;
  return proxy(id, workspace, {method: 'PUT', body: JSON.stringify(body)});
}
