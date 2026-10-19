'use client';

import {
  BadgeCheck,
  Car,
  ChevronRight,
  Gift,
  ShoppingBag,
  Ticket as TicketIcon,
  TicketPercent,
  type LucideIcon,
} from 'lucide-react';
import {
  BrandStatusPill,
  brandButtonClasses,
  type BrandStatus,
  type GroupStatusTone,
  type WalletItem,
  type WalletItemType,
} from '@eticketsgo/web-kit';
import { useTranslations } from 'next-intl';
import { useFormat } from '@/lib/format';
import { useVenueWhenText } from '@/components/booking-brand';
import { Link } from '@/i18n/navigation';

const TYPE_ICON: Record<WalletItemType, LucideIcon> = {
  TICKET: TicketIcon,
  MEMBERSHIP: BadgeCheck,
  PARKING: Car,
  COUPON: TicketPercent,
  MERCHANDISE: ShoppingBag,
  REWARD: Gift,
};

/* The wallet's tones as the brand's status pills: words always, the colour only helps. */
const TONE: Record<GroupStatusTone, BrandStatus> = {
  success: 'positive',
  info: 'info',
  warning: 'caution',
  error: 'critical',
  neutral: 'neutral',
};

/** "Fri", "16", "Oct" on the venue's calendar, for the stub; null when there is no date. */
function useStubDate() {
  const { locale } = useFormat();
  return (iso: string | null, timeZone?: string | null) => {
    if (!iso) return null;
    const at = new Date(iso);
    const part = (options: Intl.DateTimeFormatOptions) => {
      try {
        return new Intl.DateTimeFormat(locale ?? 'en-IN', {
          ...options,
          timeZone: timeZone ?? undefined,
        }).format(at);
      } catch {
        return new Intl.DateTimeFormat(locale ?? 'en-IN', options).format(at);
      }
    };
    return {
      weekday: part({ weekday: 'short' }),
      day: part({ day: 'numeric' }),
      month: part({ month: 'short' }),
    };
  };
}

/**
 * Renders ANY wallet item from its normalized shape - no per-type branching. A ticket,
 * membership, coupon or parking pass all draw from WalletItem fields.
 *
 * ── A TICKET STUB, NOT A GRADIENT TILE ─────────────────────────────────────────────
 * The card used to open with an 80px pastel gradient carrying a "Event" chip: the most space
 * on the card given to the one thing that said nothing. On the brand layer the stub on the left
 * is the date on the venue's calendar (the fact people look for first in a wallet), set on the
 * stage tone; an item with no date shows what kind of item it is instead. Everything the card
 * said before is still said, in the brand's type and status pills.
 */
export function WalletCard({
  item,
  onPreview,
}: {
  item: WalletItem;
  onPreview?: (item: WalletItem) => void;
}) {
  const wc = useTranslations('storefront.walletCard');
  const { dateTime } = useFormat();
  // A show is read on the venue's clock with the zone written out, as on every booking page.
  const venueWhenText = useVenueWhenText();
  const stub = useStubDate()(item.startsAt, item.timeZone);
  const Icon = TYPE_ICON[item.icon] ?? TicketIcon;
  const pct = item.progress ? Math.round((item.progress.done / item.progress.total) * 100) : 0;
  // The reference is already in the subtitle for a booking ("2 tickets - ETG-..."); once is enough.
  const showReference = Boolean(item.reference) && !item.subtitle?.includes(item.reference ?? '');

  return (
    <article
      aria-labelledby={`wi-${item.id}`}
      className="flex h-full min-w-0 overflow-hidden rounded-brand-card border border-brand-line bg-brand-surface"
    >
      <div
        data-brand-tone="stage"
        className="flex w-[4.5rem] shrink-0 flex-col items-center justify-center gap-0.5 bg-brand-canvas px-2 py-4 text-center text-brand-ink sm:w-24"
      >
        {stub ? (
          <>
            <span className="text-brand-eyebrow uppercase text-brand-gold-text">
              {stub.weekday}
            </span>
            <span className="font-brand-display text-[2rem] font-bold leading-none tabular-nums">
              {stub.day}
            </span>
            <span className="text-brand-meta text-brand-gold-text">{stub.month}</span>
          </>
        ) : (
          <Icon className="h-6 w-6 text-brand-ink-2" aria-hidden />
        )}
        <span aria-hidden className="mt-2 h-[3px] w-6 rounded-full bg-brand-marigold" />
      </div>

      <div className="flex min-w-0 flex-1 flex-col p-4 sm:p-5">
        <p className="text-brand-eyebrow uppercase text-brand-gold-text">
          {item.badge ?? item.type}
        </p>
        <h2
          id={`wi-${item.id}`}
          className="mt-1 line-clamp-2 font-brand-display text-brand-card text-brand-ink"
        >
          {item.title}
        </h2>
        {item.subtitle && (
          <p className="mt-1 line-clamp-1 text-brand-meta text-brand-ink-2">{item.subtitle}</p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <BrandStatusPill status={TONE[item.statusTone]}>{item.status}</BrandStatusPill>
          {item.startsAt && (
            <span className="text-brand-meta text-brand-ink-2">
              {venueWhenText(item.startsAt, item.timeZone ?? undefined)}
            </span>
          )}
          {item.expiresAt && !item.startsAt && (
            <span className="text-brand-meta text-brand-ink-2">
              {wc('expires', { when: dateTime(item.expiresAt) })}
            </span>
          )}
        </div>

        {item.progress && (
          <div className="mt-3">
            <p className="mb-1 text-brand-meta tabular-nums text-brand-ink-3">
              {item.progress.label}
            </p>
            <div
              className="h-1.5 overflow-hidden rounded-full bg-brand-line"
              role="img"
              aria-label={item.progress.label}
            >
              <div className="h-full rounded-full bg-brand-positive" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}

        <div className="mt-auto flex flex-wrap items-center justify-between gap-3 pt-4">
          <span className="min-w-0 truncate font-mono text-brand-meta text-brand-ink-3">
            {showReference ? item.reference : ''}
          </span>
          {item.primaryAction.href ? (
            <Link
              href={item.primaryAction.href}
              className={`${brandButtonClasses('primary', 'md')} ml-auto`}
            >
              {item.primaryAction.label}
              <ChevronRight className="h-4 w-4" aria-hidden />
            </Link>
          ) : (
            <button
              type="button"
              onClick={() => onPreview?.(item)}
              className={`${brandButtonClasses('secondary', 'md')} ml-auto`}
            >
              {item.primaryAction.label}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
