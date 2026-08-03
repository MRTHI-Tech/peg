'use client';

import {OrganizationSwitcher, UserButton} from '@clerk/nextjs';

/**
 * Who you are, and which workspace you are acting in.
 *
 * The organization switcher is not decoration: the workspace decides which brand
 * kit loads and which B2 prefix everything is written to, so without a visible
 * switcher a user in two orgs has no way to tell whose brand they are editing.
 *
 * Clerk's behaviour stays encapsulated here; its visual language is configured
 * once on the root ClerkProvider so every nested popover and modal matches too.
 */
export function AccountControls() {
  return (
    <>
      {/* `hidePersonal`: pages require an organization, so offering the personal
          account here would switch someone into a workspace every page then
          bounces them out of. */}
      <OrganizationSwitcher
        hidePersonal
        afterCreateOrganizationUrl="/"
        afterSelectOrganizationUrl="/"
      />
      <UserButton />
    </>
  );
}
