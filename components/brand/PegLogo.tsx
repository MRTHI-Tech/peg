import type {SVGProps} from 'react';

/** PEG mark: a peg seated into a slot. Inherits color so it themes automatically. */
export function PegLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <rect width="24" height="24" rx="6" fill="currentColor" />
      <path d="M12 4.5v8.5" stroke="var(--color-background-body)" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M7.75 13h8.5L12 19.5 7.75 13Z" fill="var(--color-background-body)" />
    </svg>
  );
}
