import type { PaginatedEvents } from '@/lib/api';

export type RecentEvent = PaginatedEvents['data'][number];

const KEY = 'etg_recent';
const MAX = 8;

/**
 * The ids of the recently viewed events, mirrored into a cookie so the server can draw the
 * "Recently viewed" rail in the first paint.
 *
 * Explore puts that rail directly under its heading. Read from localStorage after hydration, it
 * appeared a second into the visit and pushed every section under it down the screen (0.17 of
 * layout shift for anybody who had looked at an event). Ids only - the cards are re-read from the
 * catalogue either way (`useRecentlyViewed`) - and never a credential.
 */
export const RECENT_COOKIE = 'etg_recent_ids';

/** An event id as the API issues them; anything else in the cookie is ignored. */
const ID = /^[A-Za-z0-9_-]{8,40}$/;

/** The ids in a cookie value, in order, valid ones only, at most `MAX`. */
export function parseRecentIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    /* keep the raw value */
  }
  return value
    .split(',')
    .filter((id) => ID.test(id))
    .slice(0, MAX);
}

/** Writes the cookie mirror; called wherever the stored list changes or is read. */
export function rememberRecentIds(ids: readonly string[]): void {
  if (typeof document === 'undefined') return;
  try {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    const value = ids
      .filter((id) => ID.test(id))
      .slice(0, MAX)
      .join(',');
    document.cookie = value
      ? `${RECENT_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`
      : `${RECENT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
  } catch {
    /* ignore */
  }
}

export function pushRecent(event: RecentEvent): void {
  if (typeof window === 'undefined') return;
  try {
    const list = getRecent().filter((e) => e.id !== event.id);
    list.unshift(event);
    const kept = list.slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(kept));
    rememberRecentIds(kept.map((e) => e.id));
  } catch {
    /* ignore */
  }
}

export function getRecent(): RecentEvent[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as RecentEvent[];
  } catch {
    return [];
  }
}
