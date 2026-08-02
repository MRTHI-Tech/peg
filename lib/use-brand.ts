'use client';

import {useEffect, useState} from 'react';

import {emptyBrand, fetchBrand, type Brand} from './brand';

export interface BrandState {
  brand: Brand;
  isLoading: boolean;
  /** True once the brand can actually lock a generation. */
  isReady: boolean;
}

/**
 * The workspace brand, for gating.
 *
 * The gate is soft: a workspace without a brand still opens the canvas, and an
 * unreachable service is treated as "not ready" rather than blocking the app.
 * Generation is what gets withheld, not the product.
 */
export function useBrand(): BrandState {
  const [brand, setBrand] = useState<Brand>(emptyBrand());
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchBrand()
      .then(b => {
        if (!cancelled) setBrand(b);
      })
      .catch(() => {
        // Leave the empty brand in place; the UI shows the setup prompt.
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return {brand, isLoading, isReady: brand.is_complete};
}
