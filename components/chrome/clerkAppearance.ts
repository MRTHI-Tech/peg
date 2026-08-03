import type {NextClerkProviderProps} from '@clerk/nextjs/types';

type ClerkAppearance = NonNullable<NextClerkProviderProps['appearance']>;

const raisedSurface = {
  backgroundColor: 'var(--color-background-popover)',
  border: 'var(--border-width) solid var(--color-border)',
  boxShadow: 'var(--shadow-high)',
};

const embeddedAppearance = {
  options: {elevation: 'flush'},
  variables: {colorBackground: 'transparent'},
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
} as const;

/**
 * Clerk owns the behaviour of its auth and organization flows, while Astryx
 * owns their visual language. Keeping the bridge here prevents a newly added
 * Clerk surface from silently falling back to Clerk's fonts and light chrome.
 */
export const clerkAppearance = {
  variables: {
    colorPrimary: 'var(--color-accent)',
    colorPrimaryForeground: 'var(--color-on-accent)',
    colorDanger: 'var(--color-error)',
    colorSuccess: 'var(--color-success)',
    colorWarning: 'var(--color-warning)',
    colorNeutral: 'var(--color-icon-primary)',
    colorForeground: 'var(--color-text-primary)',
    colorMuted: 'var(--color-accent-muted)',
    colorMutedForeground: 'var(--color-text-secondary)',
    colorBackground: 'var(--color-background-popover)',
    colorInputForeground: 'var(--color-text-primary)',
    colorInput: 'var(--color-background-surface)',
    colorRing: 'var(--color-accent)',
    colorShadow: 'var(--color-shadow)',
    colorBorder: 'var(--color-border)',
    colorModalBackdrop: 'var(--color-overlay)',
    fontFamily: 'var(--font-family-body)',
    fontFamilyButtons: 'var(--font-family-body)',
    fontFamilyMono: 'var(--font-family-code)',
    fontSize: 'var(--font-size-base)',
    borderRadius: 'var(--radius-inner)',
    spacing: 'var(--spacing-4)',
  },
  elements: {
    card: raisedSurface,
    modalContent: {borderRadius: 'var(--radius-container)'},
    userButtonPopoverCard: {
      ...raisedSurface,
      boxShadow: 'var(--shadow-med)',
    },
    organizationSwitcherPopoverCard: {
      ...raisedSurface,
      boxShadow: 'var(--shadow-med)',
    },
    headerTitle: {
      fontFamily: 'var(--font-family-heading)',
      fontWeight: 'var(--font-weight-semibold)',
    },
    formButtonPrimary: {
      fontWeight: 'var(--font-weight-medium)',
      boxShadow: 'none',
    },
  },
  captcha: {theme: 'dark'},
  signIn: embeddedAppearance,
  signUp: embeddedAppearance,
  organizationList: embeddedAppearance,
} as const satisfies ClerkAppearance;
