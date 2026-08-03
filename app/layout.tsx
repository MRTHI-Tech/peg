import type {Metadata} from 'next';
import type {ReactNode} from 'react';
import {ClerkProvider} from '@clerk/nextjs';

import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-neutral/theme.css';

import {Providers} from './providers';

export const metadata: Metadata = {
  title: 'PEG',
  description: 'Node-based generative media workflows.',
};

export default function RootLayout({children}: {children: ReactNode}) {
  return (
    <html lang="en">
      <body>
        {/* Inside <body>, and outside the Astryx boundary so Clerk's own
            components can render before the theme has anything to say.
            The URLs are set here rather than in env so sign-in stays inside the
            app on any machine, without per-environment configuration. */}
        <ClerkProvider signInUrl="/sign-in" signUpUrl="/sign-up">
          <Providers>{children}</Providers>
        </ClerkProvider>
      </body>
    </html>
  );
}
