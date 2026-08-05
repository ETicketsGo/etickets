import { useEffect, useState } from 'react';

/**
 * Trailing-edge debounce for a changing value.
 *
 * Used for search-as-you-type: without it, "concert" is seven requests, six of which
 * are already stale by the time they land, and on a phone that is six radio wake-ups
 * the user pays for in battery.
 */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}
