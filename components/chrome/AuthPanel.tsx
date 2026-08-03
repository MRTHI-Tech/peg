'use client';

import type {ReactNode} from 'react';
import {SignIn, SignUp} from '@clerk/nextjs';

import {Card} from '@astryxdesign/core/Card';
import {Center} from '@astryxdesign/core/Center';
import {Grid} from '@astryxdesign/core/Grid';
import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';

import {PegLogo} from '@/components/brand/PegLogo';

/**
 * Sign-in and sign-up, in the Astryx `login-split` shell.
 *
 * The template ships a hand-rolled email/password form with local state and a
 * simulated two-second login. That chrome is kept — the split card, the cover
 * panel, the stacking behaviour — but the form itself is Clerk's, because the
 * template's inputs authenticate nothing. Rebuilding the real flow out of Astryx
 * controls would mean owning OAuth, email codes, MFA, bot protection, and every
 * error state by hand, which is where auth bugs live.
 *
 * Clerk's card chrome is flattened so its form reads as part of our Card rather
 * than a second surface floating inside one.
 */
const COLUMN_MIN_WIDTH = 240;

// The container query is a plain <style> tag because there is no CSS compiler
// here. It is keyed to the card's own width rather than the viewport, so the
// stack point cannot desync from where Grid actually collapses the columns.
const SPLIT_CSS = `
.auth-split {
  container-type: inline-size;
  container-name: auth-split;
}
.auth-split-grid {
  padding: var(--spacing-8);
}
.auth-split-cover {
  width: 100%;
  min-block-size: 320px;
  border-radius: var(--radius-container);
  order: 0;
  /* Layered over --color-background-body, NOT --color-background-inverted:
     "inverted" is #fff in dark mode, which painted the whole panel white.
     The --color-background-* hues are ~24% alpha and read as an empty grey
     box at this size, so the saturated icon tokens are mixed down instead. */
  background:
    radial-gradient(90% 90% at 20% 15%,
      color-mix(in srgb, var(--color-icon-cyan) 55%, transparent), transparent 65%),
    radial-gradient(85% 85% at 85% 85%,
      color-mix(in srgb, var(--color-icon-purple) 60%, transparent), transparent 60%),
    var(--color-background-body);
}
@container auth-split (max-width: 511px) {
  .auth-split-grid { padding: var(--spacing-4); }
  .auth-split-cover { order: -1; min-block-size: 160px; }
}
`;

/**
 * Clerk renders its own card. Inside ours it needs to be flat, or the page shows
 * two nested surfaces with two borders.
 */
const appearance = {
  variables: {
    colorBackground: 'transparent',
    colorText: 'var(--color-text-primary)',
    colorTextSecondary: 'var(--color-text-secondary)',
    colorInputBackground: 'var(--color-background-surface)',
    colorInputText: 'var(--color-text-primary)',
    borderRadius: 'var(--radius-inner)',
  },
  elements: {
    rootBox: {width: '100%'},
    cardBox: {width: '100%', boxShadow: 'none', border: 'none'},
    card: {
      boxShadow: 'none',
      border: 'none',
      background: 'transparent',
      padding: 0,
    },
    footer: {background: 'transparent'},
  },
};

function AuthShell({children}: {children: ReactNode}) {
  return (
    <Center
      axis="both"
      style={{
        minHeight: '100dvh',
        backgroundColor: 'var(--color-background-body)',
        padding: 'var(--spacing-6)',
      }}>
      <style>{SPLIT_CSS}</style>
      {/* The query container is this wrapper, not the grid: an element cannot
          answer a container query about its own inline size, so the template's
          padding rule never fired where it was. */}
      <div className="auth-split" style={{width: '100%', maxWidth: 1000, marginInline: 'auto'}}>
        <Card padding={0} width="100%">
          <Grid
            columns={{minWidth: COLUMN_MIN_WIDTH, repeat: 'fit'}}
            gap={8}
            align="stretch"
            className="auth-split-grid">
            <VStack gap={5} height="100%">
              <HStack gap={1.5} align="center">
                <PegLogo width={24} height={24} />
                <Text type="body" weight="semibold">
                  PEG
                </Text>
              </HStack>
              {children}
            </VStack>

            {/* Generated rather than photographed: a stock desk photo would be
                the one image in the product that PEG did not make. */}
            <div className="auth-split-cover" aria-hidden="true" />
          </Grid>
        </Card>
      </div>
    </Center>
  );
}

export function SignInPanel() {
  return (
    <AuthShell>
      <SignIn appearance={appearance} />
    </AuthShell>
  );
}

export function SignUpPanel() {
  return (
    <AuthShell>
      <SignUp appearance={appearance} />
    </AuthShell>
  );
}
