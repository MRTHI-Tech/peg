import {clerkMiddleware} from '@clerk/nextjs/server';

/**
 * Makes the Clerk session available to the app. It does **not** gate anything.
 *
 * Protection lives with the resource instead — `auth.protect()` on each page and
 * `currentWorkspace()` on each route handler. Clerk deprecated the path-matching
 * approach for a good reason: a matcher pattern can drift from how Next actually
 * routes a request, and the failure mode is a protected resource quietly
 * becoming reachable. Nothing here can drift, because nothing here decides.
 *
 * Next 16 names this file `proxy.ts`; on 15 and below it is `middleware.ts`.
 */
export default clerkMiddleware();

export const config = {
  matcher: [
    // Excludes known static extensions rather than "anything containing a dot",
    // which would have skipped any route with a dot in it. `js(?!on)` is
    // deliberate: `.json` routes still need the session.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Clerk's auto-proxy path. Without it these requests never reach Clerk.
    '/__clerk/:path*',
    '/(api|trpc)(.*)',
  ],
};
