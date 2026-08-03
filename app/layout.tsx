import type {Metadata} from 'next';
import type {ReactNode} from 'react';
import {ClerkProvider} from '@clerk/nextjs';

import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-neutral/theme.css';

import {clerkAppearance} from '@/components/chrome/clerkAppearance';

import {Providers} from './providers';

export const metadata: Metadata = {
  title: 'PEG',
  description: 'Node-based generative media workflows.',
};

export default function RootLayout({children}: {children: ReactNode}) {
  // Clerk mounts dialogs directly under the document, outside the Theme
  // wrapper. Seeding the root attributes gives those portals Astryx tokens
  // on first paint; Providers keeps the same values synchronized afterwards.
  return (
    <html lang="en" data-theme="dark" data-astryx-theme="neutral">
      <body>
        {/* Inside <body>, and outside the Astryx boundary so Clerk's own
            components can render before the theme has anything to say.
            The URLs are set here rather than in env so sign-in stays inside the
            app on any machine, without per-environment configuration. */}
        <ClerkProvider
          signInUrl="/sign-in"
          signUpUrl="/sign-up"
          afterSignOutUrl="/sign-in"
          appearance={clerkAppearance}
        >
          <Providers>{children}</Providers>
        </ClerkProvider>
      </body>
    </html>
  );
}
