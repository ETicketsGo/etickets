'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { BrandButton, brandButtonClasses } from '@eticketsgo/web-kit';

/** The id of the wrapper round the card's own "Continue to payment" button. */
export const CONTINUE_ANCHOR_ID = 'event-continue-anchor';

/** The id of the reservation card itself, which the `jump` bar scrolls to. */
export const TICKETS_SECTION_ID = 'tickets';

/** The id of the header's "Book tickets" link on a phone. */
export const BOOK_LINK_ID = 'event-book-link';

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
  mode,
  count,
  total,
  from,
  label,
  jumpLabel,
  pending,
  disabled,
  onContinue,
}: {
  /**
   * `continue`: tickets are chosen; the bar presses the card's own button.
   * `jump`: nothing is chosen yet (or the seats are chosen on the map); the bar takes the
   * buyer to the reservation card, which on a phone is below the story (owner design
   * 2026-10-19). `hidden`: nothing to buy.
   */
  mode: 'continue' | 'jump' | 'hidden';
  count: number;
  /** The quoted total, already formatted. Null while it is being worked out: never a stale one. */
  total: string | null;
  /** The lowest price on sale, for the `jump` bar. Null for a free event or none on sale. */
  from: string | null;
  label: string;
  /** "Book tickets" */
  jumpLabel: string;
  pending: boolean;
  disabled: boolean;
  onContinue: () => void;
}) {
  const t = useTranslations('storefront.event');
  const [anchorOnScreen, setAnchorOnScreen] = useState(false);

  useEffect(() => {
    /*
      In `jump` mode the bar is a way to the card, so it goes while the card OR the header's own
      "Book tickets" link is on screen - never two copies of the same way in one view.
    */
    const ids = mode === 'jump' ? [TICKETS_SECTION_ID, BOOK_LINK_ID] : [CONTINUE_ANCHOR_ID];
    const anchors = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (!anchors.length || typeof IntersectionObserver === 'undefined') return;
    const visible = new Set<Element>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target);
          else visible.delete(entry.target);
        }
        setAnchorOnScreen(visible.size > 0);
      },
      {
        // The bar and the bottom navigation cover the lowest ~9rem; a button behind them is not seen.
        rootMargin: '0px 0px -144px 0px',
      },
    );
    anchors.forEach((anchor) => observer.observe(anchor));
    return () => observer.disconnect();
  }, [mode]);

  const shown = mode !== 'hidden' && !anchorOnScreen;

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
    /*
      On the brand layer: a surface with a hairline and the one overlay shadow the system allows
      (it floats over the page), the total as a tabular figure, the ink button in the
      reservation card's small caps. It sets its own `data-brand` so its colours never depend on
      where it happens to be mounted.
    */
    <div
      data-testid="sticky-continue"
      data-mode={mode}
      data-brand="customer"
      aria-hidden="true"
      className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-30 border-t border-brand-line bg-brand-surface px-4 py-3 font-brand-text shadow-brand-overlay lg:hidden print:hidden"
    >
      <div className="mx-auto flex max-w-shell items-center gap-3">
        <div className="min-w-0 flex-1">
          {mode === 'continue' ? (
            <>
              <p className="text-brand-eyebrow uppercase text-brand-ink-3">
                {t('stickyTickets', { count })}
              </p>
              {total ? (
                <p className="font-brand-display text-brand-figure-sm tabular-nums text-brand-ink">
                  {total}
                </p>
              ) : null}
            </>
          ) : from ? (
            <p className="text-brand-ui text-brand-ink-2">
              {t.rich('fromPrice', {
                price: from,
                strong: (chunks) => (
                  <span className="font-brand-display text-brand-figure-sm tabular-nums text-brand-ink">
                    {chunks}
                  </span>
                ),
              })}
            </p>
          ) : null}
        </div>
        {mode === 'continue' ? (
          <BrandButton
            tabIndex={-1}
            size="lg"
            onClick={onContinue}
            aria-busy={pending || undefined}
            disabled={disabled}
            className="shrink-0 uppercase tracking-[0.08em]"
          >
            {label}
          </BrandButton>
        ) : (
          <a
            tabIndex={-1}
            href={`#${TICKETS_SECTION_ID}`}
            className={`${brandButtonClasses('primary', 'lg')} shrink-0 uppercase tracking-[0.08em]`}
          >
            {jumpLabel}
          </a>
        )}
      </div>
    </div>
  );
}
