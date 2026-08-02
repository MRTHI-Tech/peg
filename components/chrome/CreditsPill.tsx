'use client';

import {Sparkles} from 'lucide-react';

import {Token} from '@astryxdesign/core/Token';
import {Icon} from '@astryxdesign/core/Icon';

import {ACCOUNT} from '@/lib/mock-data';

/** Remaining generation credits. Turns amber once the balance runs low. */
export function CreditsPill({credits = ACCOUNT.credits}: {credits?: number}) {
  const isLow = credits < 100;
  return (
    <Token
      size="sm"
      color={isLow ? 'yellow' : 'default'}
      icon={<Icon icon={Sparkles} size="xsm" />}
      label={`${credits} credits`}
      description={isLow ? 'Low credit balance' : undefined}
    />
  );
}
