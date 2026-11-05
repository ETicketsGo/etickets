import { useCallback, useRef } from 'react';

/**
 * Run at most one save per key at a time.
 *
 * A switch's `disabled={mutation.isPending}` only takes effect after React re-renders, so two
 * clicks in quick succession (a double tap, or a click that also reaches a wrapping label) can
 * both start a save before the switch is disabled. Each consent save is an audited row, so a
 * second identical save is a false duplicate in the person's history. This guard is synchronous:
 * a call for a key that is already saving is ignored until that save settles.
 */
export function useSingleFlight() {
  const inFlight = useRef(new Set<string>());
  return useCallback(<T>(key: string, run: () => Promise<T>): Promise<T> | null => {
    if (inFlight.current.has(key)) return null;
    inFlight.current.add(key);
    return run().finally(() => {
      inFlight.current.delete(key);
    });
  }, []);
}
