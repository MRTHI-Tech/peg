import {NextResponse} from 'next/server';

import {SERVICE_URL, serviceHeaders} from '@/lib/service-config';
import {canEditBrand, currentWorkspace, forbidden, unauthorized} from '@/lib/workspace';

/** Read the workspace brand. Empty on first run rather than a 404. */
export async function GET() {
  const workspace = await currentWorkspace();
  if (!workspace) return unauthorized();

  try {
    const upstream = await fetch(`${SERVICE_URL}/brand`, {
      cache: 'no-store',
      headers: serviceHeaders(workspace),
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

  const workspace = await currentWorkspace();
  if (!workspace) return unauthorized();
  if (!(await canEditBrand())) return forbidden();

  try {
    const upstream = await fetch(`${SERVICE_URL}/brand`, {
      method: 'PUT',
      headers: serviceHeaders(workspace),
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
