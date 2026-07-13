import type { RecentEvent } from '@/lib/recent';

// A saved event stores the full card so the Saved page renders with no API call.
export type SavedEvent = RecentEvent;

const KEY = 'etg_saved';

export function getSaved(): SavedEvent[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as SavedEvent[];
  } catch {
    return [];
  }
}

export function isSaved(id: string): boolean {
  return getSaved().some((e) => e.id === id);
}

/** Toggles an event in the saved list; returns the new saved state. */
export function toggleSaved(card: SavedEvent): boolean {
  if (typeof window === 'undefined') return false;
  const list = getSaved();
  const exists = list.some((e) => e.id === card.id);
  const next = exists ? list.filter((e) => e.id !== card.id) : [card, ...list];
  try {
    localStorage.setItem(KEY, JSON.stringify(next.slice(0, 50)));
  } catch {
    /* ignore */
  }
  return !exists;
}
