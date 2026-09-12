'use client';

import { useSyncExternalStore } from 'react';

const subscribe = () => () => {};

/**
 * False while the server renders and while React hydrates that HTML; true from then on.
 *
 * ── WHY THE ACCOUNT PAGES NEED IT ──────────────────────────────────────────────────
 * They gated their queries on `typeof window !== 'undefined' && !!tokenStore.access`. That is
 * false on the server and true on the client's very first render, so the two renders disagreed:
 * the server sent the empty state ("No bookings yet") and hydration drew the loading skeleton.
 * QA saw React error #418 on every load of /account/bookings and its tickets page, in both
 * languages. Gating on this instead keeps the first client render identical to the server's,
 * and then lets the query start.
 *
 * `useSyncExternalStore` rather than a `useEffect` flag: a page reached by client-side
 * navigation is not hydrating, so it gets `true` straight away instead of a skeleton flash.
 */
export function useMounted(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
