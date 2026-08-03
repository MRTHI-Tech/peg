import {NextResponse} from 'next/server';

import {SERVICE_TIMEOUT_MS, SERVICE_URL, serviceHeaders} from '@/lib/service-config';
import {currentWorkspace, unauthorized} from '@/lib/workspace';

/** List the editable canvases owned by the current workspace. */
export async function GET() {
  const workspace = await currentWorkspace();
  if (!workspace) return unauthorized();

  try {
    const upstream = await fetch(`${SERVICE_URL}/workflows`, {
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
