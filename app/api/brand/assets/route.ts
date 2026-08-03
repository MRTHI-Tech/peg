import {NextResponse} from 'next/server';

import {SERVICE_TIMEOUT_MS, SERVICE_URL, serviceHeaders} from '@/lib/service-config';
import {canEditBrand, currentWorkspace, forbidden, unauthorized} from '@/lib/workspace';

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

  const workspace = await currentWorkspace();
  if (!workspace) return unauthorized();
  if (!(await canEditBrand())) return forbidden();

  try {
    const upstream = await fetch(`${SERVICE_URL}/brand/assets`, {
      method: 'POST',
      headers: serviceHeaders(workspace),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
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

/** Relabel a composite — what it is decides how it gets placed. */
export async function PATCH(request: Request) {
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
    const upstream = await fetch(`${SERVICE_URL}/brand/assets`, {
      method: 'PATCH',
      headers: serviceHeaders(workspace),
      body: JSON.stringify(body),
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

/** Remove one asset from the brand and the bucket. Returns the updated brand. */
export async function DELETE(request: Request) {
  const assetKey = new URL(request.url).searchParams.get('asset_key');
  if (!assetKey) return NextResponse.json({error: 'asset_key is required'}, {status: 400});

  const workspace = await currentWorkspace();
  if (!workspace) return unauthorized();
  if (!(await canEditBrand())) return forbidden();

  try {
    const upstream = await fetch(
      `${SERVICE_URL}/brand/assets?asset_key=${encodeURIComponent(assetKey)}`,
      {method: 'DELETE', headers: serviceHeaders(workspace), signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS)},
    );
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
