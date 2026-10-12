'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui';

/** The id of the wrapper round the card's own "Continue to payment" button. */
export const CONTINUE_ANCHOR_ID = 'event-continue-anchor';

/**
 * "Continue to payment", kept in reach on a phone once tickets are chosen.
 *
 * ── WHY IT EXISTS ──────────────────────────────────────────────────────────────────
 * On a 390px screen the ticket card is followed by a price breakdown, an optional state
 * field and, for a guest, a name and an email. The button is the last thing in a card that is
 * several screens tall, and the buyer has to scroll to it after every change of quantity. The
 * seat page already solved this with a bar at the thumb; this is the same idea for the
 * general-admission page.
 *
 * ── WHAT KEEPS IT FROM GETTING IN THE WAY ──────────────────────────────────────────
 * - It is only there while the card's own button is OFF screen. The moment that button
 *   scrolls into view this bar leaves, so there is never a second copy beside it.
 * - It sits above the bottom navigation, not over it, and pads for the gesture bar with
 *   `env(safe-area-inset-bottom)`.
 * - While it shows, the page reserves room under it (`scroll-padding-bottom`), so a field
 *   that takes focus is scrolled clear of the bar instead of landing behind it.
 * - It is a shortcut for a finger, not a second control for everybody else. It is hidden from
 *   assistive technology and out of the tab order, because the card's own button does the same
 *   job one Tab away and a screen reader should not hear "Continue to payment" twice.
 * - It never decides anything. It presses the same button handler, so the guest form is
 *   validated, and focus goes to the first bad field, exactly as before.
 * - Below `lg` only. From `lg` the card sits beside the page and is sticky already.
 */
export function StickyContinue({
  visible,
  count,
  total,
  label,
  pending,
  disabled,
  onContinue,
}: {
  /** There is something chosen to continue with. */
  visible: boolean;
  count: number;
  /** The quoted total, already formatted. Null while it is being worked out: never a stale one. */
  total: string | null;
  label: string;
  pending: boolean;
  disabled: boolean;
  onContinue: () => void;
}) {
  const t = useTranslations('storefront.event');
  const [anchorOnScreen, setAnchorOnScreen] = useState(false);

  useEffect(() => {
    const anchor = document.getElementById(CONTINUE_ANCHOR_ID);
    if (!anchor || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      ([entry]) => setAnchorOnScreen(entry.isIntersecting),
      {
        // The bar and the bottom navigation cover the lowest ~9rem; a button behind them is not seen.
        rootMargin: '0px 0px -144px 0px',
      },
    );
    observer.observe(anchor);
    return () => observer.disconnect();
  }, [visible]);

  const shown = visible && !anchorOnScreen;

  useEffect(() => {
    if (!shown) return;
    const root = document.documentElement;
    const before = root.style.scrollPaddingBottom;
    root.style.scrollPaddingBottom = '9rem';
    return () => {
      root.style.scrollPaddingBottom = before;
    };
  }, [shown]);

  if (!shown) return null;

  return (
    <div
      data-testid="sticky-continue"
      aria-hidden="true"
      className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-30 border-t border-border bg-background-surface/95 px-4 py-3 shadow-lg backdrop-blur-md lg:hidden print:hidden"
    >
      <div className="mx-auto flex max-w-shell items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-caption text-text-secondary">{t('stickyTickets', { count })}</p>
          {total ? (
            <p className="text-title font-bold tabular-nums text-text-primary">{total}</p>
          ) : null}
        </div>
        <Button
          tabIndex={-1}
          onClick={onContinue}
          loading={pending}
          disabled={disabled}
          className="shrink-0"
        >
          {label}
        </Button>
      </div>
    </div>
  );
}
