import { useCallback, useMemo, useSyncExternalStore } from 'react';

/**
 * The current time, as a React-readable value.
 *
 * `Date.now()` called during render is impure — the same render produces a different
 * result each time, which is exactly what the React Compiler's purity rule exists to
 * catch, and what makes time-dependent UI subtly wrong when React replays a render.
 * The wall clock is an external, mutating system, so it is read the way every other
 * external system is: subscribe to its changes, snapshot its value.
 *
 * The snapshot is quantised to `granularityMs`, which is load-bearing rather than a
 * nicety: useSyncExternalStore re-renders whenever getSnapshot returns something new,
 * so an unquantised Date.now() would return a different number every single call and
 * spin forever. Quantising also means a once-a-minute consumer is not re-rendered
 * sixty times.
 */
export function useNow(granularityMs = 1000): number {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const timer = setInterval(onChange, granularityMs);
      return () => clearInterval(timer);
    },
    [granularityMs],
  );

  const getSnapshot = useMemo(
    () => () => Math.floor(Date.now() / granularityMs) * granularityMs,
    [granularityMs],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
