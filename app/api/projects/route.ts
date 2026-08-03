import {NextResponse} from 'next/server';

import {SERVICE_URL, serviceHeaders} from '@/lib/service-config';
import {currentWorkspace, unauthorized} from '@/lib/workspace';

/**
 * Everything this workspace has generated.
 *
 * An unreachable service returns an empty list rather than an error: the gallery
 * is not worth breaking a page over, and "nothing yet" is the honest reading for
 * a workspace whose storage we cannot see.
 */
export async function GET() {
  const workspace = await currentWorkspace();
  if (!workspace) return unauthorized();

  try {
    const upstream = await fetch(`${SERVICE_URL}/projects`, {
      cache: 'no-store',
      headers: serviceHeaders(workspace),
      signal: AbortSignal.timeout(20_000),
    });
    if (!upstream.ok) return NextResponse.json({projects: []});
    return NextResponse.json(await upstream.json());
  } catch {
    return NextResponse.json({projects: []});
  }
}
