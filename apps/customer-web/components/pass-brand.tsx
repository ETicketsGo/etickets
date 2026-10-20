'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, Check } from 'lucide-react';
import {
  BRAND_FOCUS,
  Wordmark,
  eventImageSource,
  type EventImageVariants,
} from '@eticketsgo/web-kit';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { currentUserId } from '@/lib/offline/identity';
import { loadWallet } from '@/lib/offline/wallet-store';

/*
  ── THE PASS, AS A PAPER TICKET ON A DARK PAGE (owner's mockup, 2026-10-19) ──────────────
  The two pages a buyer holds up at the door - one ticket, and a booking's tickets one at a
  time - share this drawing: the lights go down (the page is the stage tone), and the ticket
  itself is a paper card with its photo, the facts a doorperson reads, a perforation, and the
  QR on white. The card sets `data-brand="customer"` again, which puts the paper tokens back
  inside the stage, so a status pill or a link on the card reads as it does everywhere else.

  Only the drawing is shared here. Each page keeps its own data, actions and behaviour.
*/

/** The small gold caps over a title or a fact: "ADMIT ONE - COMMUNITY", "DATE". */
export const PASS_CAPS = 'text-brand-eyebrow uppercase tracking-[0.16em] text-brand-gold-text';

/**
 * An outlined action on the dark page: "ADD TO WALLET", "TRANSFER". 48px tall, letter-spaced
 * caps, a hairline that clears 3:1 on ink (WCAG 1.4.11).
 */
export const PASS_OUTLINE = `inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-brand-control border border-brand-ink-3 px-4 text-brand-meta font-semibold uppercase tracking-[0.16em] text-brand-ink transition-colors duration-150 hover:bg-brand-surface disabled:pointer-events-none disabled:opacity-50 ${BRAND_FOCUS}`;

/**
 * The dark page under the site header. Rendered INSIDE BrandPage, which pads its bottom on
 * paper; the negative margin takes that back so the ink runs down to the footer.
 */
export function PassStage({ children }: { children: ReactNode }) {
  return (
    <div
      data-brand-tone="stage"
      className="-mb-16 min-h-[calc(100dvh-4rem)] bg-brand-canvas pb-16 text-brand-ink lg:-mb-24 lg:pb-24"
    >
      {children}
    </div>
  );
}

/**
 * The pass's own top bar: back to My tickets on the left and - only when this pass is saved
 * on the device - "OFFLINE" with a tick, in gold, on the right. Nothing is shown there when it
 * is not saved: the word would otherwise promise something the device cannot do.
 *
 * No wordmark in the middle (owner, 2026-10-19: "we dont need to show ETicketsGo on the top
 * of the ticket"). The site header above already names the shop, and a doorperson reads the
 * card, not the bar. Two columns, so "< TICKETS" keeps its place whether or not the pass is
 * saved offline.
 */
export function PassTopBar({ storedOffline }: { storedOffline: boolean }) {
  const b = useTranslations('storefront.bookingTickets');
  const router = useRouter();
  return (
    <div className="mx-auto grid max-w-md grid-cols-[1fr_auto] items-center gap-2 px-4 pt-3 sm:max-w-lg sm:pt-6">
      <button
        type="button"
        onClick={() => router.push('/account/tickets')}
        className={`-ml-2 inline-flex min-h-11 items-center gap-1.5 justify-self-start whitespace-nowrap rounded-brand-control px-2 text-brand-eyebrow uppercase tracking-[0.16em] text-brand-ink-2 hover:text-brand-gold-text ${BRAND_FOCUS}`}
      >
        <ArrowLeft className="h-4 w-4" aria-hidden /> {b('passBack')}
      </button>
      <span className="justify-self-end">
        {storedOffline && (
          <span
            className="inline-flex items-center gap-1 text-brand-eyebrow uppercase tracking-[0.16em] text-brand-gold-text"
            title={b('offlineReadyLabel')}
          >
            {/* With two things in the bar the word fits down to 320px; it was dropped below 360 when the wordmark sat between them. */}
            <span aria-hidden>{b('offlineReady')}</span>
            <Check className="h-3.5 w-3.5" aria-hidden />
            <span className="sr-only">{b('offlineReadyLabel')}</span>
          </span>
        )}
      </span>
    </div>
  );
}

/** The paper card. Paper tokens again inside the stage (see the note at the top). */
export function PassCard({
  children,
  label,
  className = '',
}: {
  children: ReactNode;
  label?: string;
  className?: string;
}) {
  return (
    <section
      data-brand="customer"
      aria-label={label}
      className={`relative overflow-hidden rounded-brand-control bg-brand-canvas font-brand-text text-brand-ink ${className}`}
    >
      {children}
    </section>
  );
}

/**
 * The tear line across the card: a dashed rule with a half circle cut from each side. The
 * circles are the page's ink, so they read as notches in the paper.
 */
export function PassPerforation() {
  return (
    <div aria-hidden className="relative my-1 h-6">
      <span className="absolute -left-3 top-0 h-6 w-6 rounded-full bg-etg-ink" />
      <span className="absolute -right-3 top-0 h-6 w-6 rounded-full bg-etg-ink" />
      <span className="absolute inset-x-5 top-1/2 border-t border-dashed border-brand-line-strong" />
    </div>
  );
}

/** One of the three facts under the title: DATE / TIME / GUEST. */
export function PassFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 px-2 py-3 text-center">
      <dt className="text-[0.6875rem] font-semibold uppercase tracking-[0.16em] text-brand-ink-3">
        {label}
      </dt>
      <dd className="mt-1 break-words font-brand-display text-brand-card font-bold leading-tight text-brand-ink">
        {children}
      </dd>
    </div>
  );
}

/**
 * The event's photo across the top of the card, or the brand's mark on ink when the event has
 * none (or it fails to load). Never a stock picture standing in for the organizer's own.
 */
export function PassPhoto({
  image,
  className = 'aspect-[16/9] w-full',
}: {
  image: { variants?: EventImageVariants | null; path?: string | null } | null | undefined;
  className?: string;
}) {
  const source = eventImageSource(image, 'card');
  const [broken, setBroken] = useState(false);
  return (
    <div className={`relative overflow-hidden bg-brand-image-fallback ${className}`}>
      {source && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={source.src}
          srcSet={source.srcSet}
          sizes="(min-width: 640px) 512px, 100vw"
          alt=""
          decoding="async"
          onError={() => setBroken(true)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <PhotoFallback />
      )}
    </div>
  );
}

/** The brand's mark on ink: what a ticket without a photo shows in the photo's place. */
export function PhotoFallback() {
  return (
    <div
      data-brand-tone="stage"
      className="absolute inset-0 flex items-center justify-center bg-brand-image-fallback text-brand-ink-3"
    >
      <Wordmark tone="brand" size="sm" className="opacity-80" />
    </div>
  );
}

/**
 * Whether this ticket is saved in the device's offline wallet for the signed-in person. Read
 * from the same IndexedDB copy the offline fallback reads, so the word "Offline" is shown only
 * when the pass would really open without a network.
 */
export function useStoredOffline(ticketId: string | undefined, refreshKey?: unknown): boolean {
  const [stored, setStored] = useState(false);
  useEffect(() => {
    let live = true;
    const userId = currentUserId();
    if (!ticketId || !userId) {
      setStored(false);
      return;
    }
    loadWallet(userId)
      .then((record) => {
        if (live) setStored(Boolean(record?.items.some((t) => t.id === ticketId)));
      })
      .catch(() => {
        if (live) setStored(false);
      });
    return () => {
      live = false;
    };
  }, [ticketId, refreshKey]);
  return stored;
}

/** "Fri 4 Dec" on the venue's calendar, for the pass's DATE cell. */
export function passDay(iso: string, zone: string | null | undefined, locale: string): string {
  const options: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' };
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: zone ?? undefined })
      .format(new Date(iso))
      .replace(/,/g, '');
  } catch {
    return new Intl.DateTimeFormat(locale, options).format(new Date(iso)).replace(/,/g, '');
  }
}
