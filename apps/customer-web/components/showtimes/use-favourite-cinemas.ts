'use client';

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'etg_fav_cinemas';

function readStored(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    // Private mode, blocked storage or a hand-edited value: no favourites, not a broken page.
    return [];
  }
}

/**
 * Cinemas this browser has hearted, keyed by `cinemaKey`.
 *
 * ── WHY TWO LISTS ──────────────────────────────────────────────────────────────────
 * `favourites` is what the hearts show, and changes the moment one is pressed. `sortFirst` is
 * what the list is ORDERED by, and only catches up when the page calls `settle()` — on a new
 * day or page of dates. Re-sorting on the press itself would move the card out from under the
 * pointer, and moving a DOM node that holds focus drops keyboard focus to the page.
 *
 * Read after mount, never during render, so the server's HTML and the first client render agree.
 */
export function useFavouriteCinemas() {
  const [favourites, setFavourites] = useState<string[]>([]);
  const [sortFirst, setSortFirst] = useState<string[]>([]);

  useEffect(() => {
    const stored = readStored();
    setFavourites(stored);
    setSortFirst(stored);
  }, []);

  const toggle = useCallback((key: string) => {
    setFavourites((current) => {
      const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Still toggles for this visit; it just will not be remembered.
      }
      return next;
    });
  }, []);

  const settle = useCallback(() => setSortFirst(favourites), [favourites]);

  return { favourites, sortFirst, toggle, settle };
}
