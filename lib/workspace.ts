/**
 * Who a request's data belongs to.
 *
 * Server-side only — imported by route handlers and pages, never by a component.
 *
 * A workspace is a Clerk organization when the user is acting in one, and their
 * personal workspace otherwise. Everything a workspace owns lives under its own
 * B2 prefix, so a new sign-in *is* an empty state: no seeding, no reset, no
 * first-run mode, just a prefix with nothing under it yet.
 *
 * The organization is the unit rather than the user because setting up a brand
 * and using one are usually different people — an admin defines the kit, the
 * marketing team inherits it.
 */
import {auth} from '@clerk/nextjs/server';
import {NextResponse} from 'next/server';

/**
 * The current workspace id, or null when nobody is signed in.
 *
 * This is the authorization check for API routes, not a convenience: the proxy
 * deliberately does not gate anything, so every handler that touches workspace
 * data must call this and refuse without it.
 */
export async function currentWorkspace(): Promise<string | null> {
  const {userId, orgId} = await auth();
  if (!userId) return null;
  // Clerk ids already carry their own `org_` / `user_` prefix, so the two can
  // never collide in the bucket and the key says whose it is on sight.
  return orgId ?? userId;
}

/** Standard refusal for a route handler reached without a session. */
export function unauthorized() {
  return NextResponse.json({error: 'not signed in'}, {status: 401});
}

/**
 * Whether the current user may change the brand kit.
 *
 * Admins only, inside an organization. The brand is the one piece of state every
 * generation in the workspace depends on, and a member deleting the style
 * reference would silently change every asset the team produces afterwards —
 * so editing it is an administrative act, not a normal one.
 *
 * In a personal workspace there is nobody else to protect, so the owner is the
 * admin by definition.
 */
export async function canEditBrand(): Promise<boolean> {
  const {userId, orgId, orgRole} = await auth();
  if (!userId) return false;
  if (!orgId) return true;
  return orgRole === 'org:admin';
}

/** Standard refusal for an authenticated user without the rights to do this. */
export function forbidden(action = 'change the brand kit') {
  return NextResponse.json(
    {error: `Only workspace admins can ${action}. Ask an admin to make the change.`},
    {status: 403},
  );
}
