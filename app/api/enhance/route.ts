import {NextResponse} from 'next/server';

import {SERVICE_URL, serviceHeaders} from '@/lib/service-config';
import {currentWorkspace, unauthorized} from '@/lib/workspace';

/**
 * Rewrite a rough brief as art direction.
 *
 * A thin proxy, for the same reason /api/runs is one: the browser never holds
 * a provider key. Unlike a run this answers directly — enhancement is a single
 * text call, so there is no job to poll.
 */

/** Sized for one text completion, not a cold start on a generation. */
const ENHANCE_TIMEOUT_MS = 60_000;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({error: 'invalid JSON body'}, {status: 400});
  }

  const workspace = await currentWorkspace();
  if (!workspace) return unauthorized();

  try {
    const upstream = await fetch(`${SERVICE_URL}/enhance`, {
      method: 'POST',
      headers: serviceHeaders(workspace),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ENHANCE_TIMEOUT_MS),
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
