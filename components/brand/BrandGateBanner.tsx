'use client';

import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';

import {useBrand} from '@/lib/use-brand';

/**
 * The soft gate, on the first screen anyone lands on.
 *
 * Nothing is blocked — the canvas opens either way — but generation without a
 * brand produces on-brand output only by accident, so the prompt is persistent
 * until the kit exists.
 */
export function BrandGateBanner() {
  const {brand, isLoading, isReady} = useBrand();

  if (isLoading || isReady) return null;

  const hasSomething = brand.style_references.length > 0 || brand.description.trim().length > 0;

  return (
    <Banner
      status="info"
      container="card"
      title={hasSomething ? 'Finish your brand kit' : 'Set up your brand kit'}
      description={
        hasSomething
          ? 'A style reference and a description of the look are both needed before PEG can lock generation to your brand.'
          : 'Upload the artwork that defines your look. Every asset PEG generates is locked to it.'
      }
      endContent={<Button label={hasSomething ? 'Finish setup' : 'Set up brand'} href="/brand" />}
    />
  );
}
