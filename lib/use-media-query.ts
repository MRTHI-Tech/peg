'use client';

import {useEffect, useState} from 'react';

/**
 * Tracks a CSS media query.
 *
 * Always returns `false` on the server and for the first client render, so the
 * markup matches during hydration; the real value lands in the effect.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
