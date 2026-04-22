"use client";

import { useEffect, useState } from "react";

/**
 * Subscribe to a media query. Starts as `false` so the SSR render
 * matches a narrow viewport (the overlay form of the Quick peek
 * inspector), and re-evaluates on mount and on viewport changes.
 * The mount-time re-evaluation is what flips wide clients into the
 * inline-split layout without causing hydration mismatches.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
