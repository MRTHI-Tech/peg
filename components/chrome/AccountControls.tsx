'use client';

import {OrganizationSwitcher, UserButton} from '@clerk/nextjs';

/**
 * Who you are, and which workspace you are acting in.
 *
 * The organization switcher is not decoration: the workspace decides which brand
 * kit loads and which B2 prefix everything is written to, so without a visible
 * switcher a user in two orgs has no way to tell whose brand they are editing.
 *
 * Clerk's components bring their own styling. They are given the dark surface
 * tokens so they do not read as a light-mode panel dropped into a dark product.
 */
const appearance = {
  variables: {
    colorBackground: 'var(--color-background-popover)',
    colorText: 'var(--color-text-primary)',
    colorTextSecondary: 'var(--color-text-secondary)',
    colorInputBackground: 'var(--color-background-surface)',
    colorInputText: 'var(--color-text-primary)',
    borderRadius: 'var(--radius-container)',
  },
};

export function AccountControls() {
  return (
    <>
      {/* `hidePersonal`: pages require an organization, so offering the personal
          account here would switch someone into a workspace every page then
          bounces them out of. */}
      <OrganizationSwitcher
        appearance={appearance}
        hidePersonal
        afterCreateOrganizationUrl="/"
        afterSelectOrganizationUrl="/"
      />
      <UserButton appearance={appearance} />
    </>
  );
}
