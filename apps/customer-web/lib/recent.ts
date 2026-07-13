import type { PaginatedEvents } from '@/lib/api';

export type RecentEvent = PaginatedEvents['data'][number];

const KEY = 'etg_recent';
const MAX = 8;

export function pushRecent(event: RecentEvent): void {
  if (typeof window === 'undefined') return;
  try {
    const list = getRecent().filter((e) => e.id !== event.id);
    list.unshift(event);
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
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
