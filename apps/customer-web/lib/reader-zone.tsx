'use client';

import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import { READER_ZONE_COOKIE } from '@/lib/reader-zone-cookie';

/**
 * The reader's own time zone, the same on the server and in the hydrating browser.
 *
 * ── WHY IT IS NOT JUST `Intl...resolvedOptions().timeZone` ─────────────────────────
 * Times are shown on the venue's clock, and the venue's zone is named only when it differs from
 * the reader's. Read straight from `Intl`, the reader's zone was the SERVER's on the server (UTC
 * on Railway) and the visitor's in the browser, so a page the server had drawn with its events
 * failed to hydrate (React #418) and was drawn again on the client - a visible redraw, the very
 * thing server rendering was meant to remove.
 *
 * So the browser mirrors its zone into a cookie (`etg_tz`), the server reads it back
 * (`lib/city-seed.ts`), and both renders start from that value. On a first visit there is no
 * cookie: both start from "unknown" (every zone is named) and the browser settles on its own
 * zone after hydration. A preference for display only, never used to price or schedule anything.
 */

const ReaderZoneContext = createContext<string | undefined>(undefined);

export function ReaderZoneProvider({
  zone,
  children,
}: {
  /** The zone the server rendered with (from the cookie), or undefined. */
  zone?: string;
  children: React.ReactNode;
}) {
  const actual = useReaderZone(zone);
  useEffect(() => {
    if (!actual || actual === zone) return;
    try {
      const secure = location.protocol === 'https:' ? '; Secure' : '';
      document.cookie = `${READER_ZONE_COOKIE}=${encodeURIComponent(actual)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
    } catch {
      /* display preference only */
    }
  }, [actual, zone]);
  return <ReaderZoneContext.Provider value={zone}>{children}</ReaderZoneContext.Provider>;
}

const noSubscription = () => () => undefined;

function browserZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/**
 * The reader's zone: the server's value while hydrating, the browser's own after.
 * `serverZone` is for the provider; components call it with no argument.
 */
export function useReaderZone(serverZone?: string): string | undefined {
  const fromServer = useContext(ReaderZoneContext);
  const start = serverZone ?? fromServer;
  return useSyncExternalStore(noSubscription, browserZone, () => start);
}
