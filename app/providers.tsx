'use client';

import type {ReactNode} from 'react';
import NextLink from 'next/link';
import {Theme} from '@astryxdesign/core/theme';
import {LinkProvider} from '@astryxdesign/core/Link';
import {InternationalizationProvider} from '@astryxdesign/core/i18n';
import {neutralTheme} from '@astryxdesign/theme-neutral/built';

/**
 * Astryx boundary.
 *
 * - PEG is a dark-only product, so the mode is pinned rather than following the OS.
 * - LinkProvider routes every Astryx `href` through next/link, so components get
 *   client-side navigation without each call site passing `as={Link}` (which
 *   would mean sending a function across the server/client boundary).
 * - The locale is pinned. Left to infer, the Node server formats dates as en-GB
 *   while the browser uses en-US, which fails hydration on every Timestamp.
 */
export function Providers({children}: {children: ReactNode}) {
  return (
    <Theme theme={neutralTheme} mode="dark">
      <InternationalizationProvider locale="en-US">
        <LinkProvider component={NextLink}>{children}</LinkProvider>
      </InternationalizationProvider>
    </Theme>
  );
}
