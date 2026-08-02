import type {Metadata} from 'next';
import type {ReactNode} from 'react';

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
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
