'use client';

import { useSyncExternalStore } from 'react';

/*
  Whether the Overview is on a phone (below Tailwind's `md`, 768px).

  Asked of the browser rather than answered with CSS, because the phone does not just restyle
  the page - it reads in a different ORDER (figures, the next events, then what to do) and folds
  the detail away. Reordering with CSS `order` would leave the tab order and a screen reader's
  reading order on the desktop sequence while the eye followed another; rendering the sections
  in the phone's order keeps all three the same. The server assumes a wide screen.
*/
const PHONE_QUERY = '(max-width: 767.98px)';

function subscribe(onChange: () => void) {
  const mq = window.matchMedia(PHONE_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

export function usePhone(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(PHONE_QUERY).matches,
    () => false,
  );
}
