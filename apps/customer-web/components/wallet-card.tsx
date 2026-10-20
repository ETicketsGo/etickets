'use client';

import {
  BadgeCheck,
  Car,
  Gift,
  ShoppingBag,
  Ticket as TicketIcon,
  TicketPercent,
  type LucideIcon,
} from 'lucide-react';
import {
  BRAND_FOCUS,
  brandButtonClasses,
  type EventImageVariants,
  type GroupCounts,
  type WalletItem,
  type WalletItemType,
} from '@eticketsgo/web-kit';
import { useTranslations } from 'next-intl';
import { useFormat } from '@/lib/format';
import { useVenueWhen } from '@/components/booking-brand';
import { PassPhoto } from '@/components/pass-brand';
import { Link } from '@/i18n/navigation';

const TYPE_ICON: Record<WalletItemType, LucideIcon> = {
  TICKET: TicketIcon,
  MEMBERSHIP: BadgeCheck,
  PARKING: Car,
  COUPON: TicketPercent,
  MERCHANDISE: ShoppingBag,
  REWARD: Gift,
};

/**
 * What the stub knows about a booking beyond the wallet item: read by the page from the same
 * wallet tickets the item was built from, and from the event's public page (photo and city).
 * Every field is optional, because an older cached wallet or an offline device has less.
 */
export interface WalletStubInfo {
  image?: { variants?: EventImageVariants | null; path?: string | null } | null;
  city?: string | null;
  counts?: GroupCounts | null;
  /** The show has finished (eventTiming's `ended`). */
  ended?: boolean;
  /** At least one ticket on the booking can be transferred by this viewer today. */
  transferable?: boolean;
}

/** The outlined, letter-spaced status label of the stub. Colour helps; the words carry it. */
const STUB_PILL =
  'inline-flex min-h-8 items-center rounded-[3px] border border-current px-3 py-1 text-[0.6875rem] font-semibold uppercase tracking-[0.16em]';
const PILL_TONE = {
  positive: 'text-brand-positive',
  caution: 'text-brand-gold-text',
  critical: 'text-brand-critical',
  neutral: 'text-brand-ink-3',
} as const;

/** "WEDNESDAY 28 OCTOBER", "1:07 am", "IST": the long day on the venue's calendar, its clock. */
function useStubWhen() {
  const { locale } = useFormat();
  const venueWhen = useVenueWhen();
  return (iso: string | null, timeZone?: string | null) => {
    if (!iso) return null;
    const at = new Date(iso);
    const options: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long' };
    let day: string;
    try {
      day = new Intl.DateTimeFormat(locale ?? 'en-IN', {
        ...options,
        timeZone: timeZone ?? undefined,
      }).format(at);
    } catch {
      day = new Intl.DateTimeFormat(locale ?? 'en-IN', options).format(at);
    }
    const when = venueWhen(iso, timeZone ?? undefined);
    return { day: day.replace(/,/g, ''), time: when.time, zone: when.zone };
  };
}

/**
 * Renders ANY wallet item from its normalized shape - no per-type branching. A ticket,
 * membership, coupon or parking pass all draw from WalletItem fields.
 *
 * ── A TICKET STUB (owner's mockup, 2026-10-19) ────────────────────────────────────────
 * The event's photo on the left, then the date on the venue's clock in gold caps, the title,
 * "City - N tickets" and the state as an outlined label; a perforation; and a stub on the
 * right with the booking reference, OPEN PASS (where "View tickets" went) and, only when a
 * ticket on the booking can be transferred today, TRANSFER (the same share-to-transfer dialog
 * the booking's page opens). Below `sm` the stub drops under the ticket so nothing is
 * squeezed at 320px.
 */
export function WalletCard({
  item,
  info,
  onPreview,
}: {
  item: WalletItem;
  info?: WalletStubInfo;
  onPreview?: (item: WalletItem) => void;
}) {
  const wc = useTranslations('storefront.walletCard');
  const b = useTranslations('storefront.bookingTickets');
  const { dateTime } = useFormat();
  const when = useStubWhen()(item.startsAt, item.timeZone);
  const Icon = TYPE_ICON[item.icon] ?? TicketIcon;
  const counts = info?.counts ?? null;
  const titleId = `wi-${item.id}`;

  /*
    The state, from the booking's counts. Every state the old pill said is still said: a
    cancelled or refunded booking keeps its own words, and a mixed booking ("1 active - 1
    refunded") keeps the full summary beside the label.
  */
  let pill: { text: string; tone: keyof typeof PILL_TONE } = { text: item.status, tone: 'neutral' };
  let extra: string | null = null;
  let admitted: { done: number; total: number; left: number } | null = null;
  if (counts && counts.total > 0) {
    const live = counts.active + counts.checkedIn + counts.transferred;
    if (live === 0) {
      pill = { text: item.status, tone: item.statusTone === 'error' ? 'critical' : 'neutral' };
    } else if (counts.checkedIn === counts.total) {
      pill = { text: item.status, tone: 'positive' };
    } else if (counts.checkedIn > 0 && counts.active > 0 && !info?.ended) {
      admitted = { done: counts.checkedIn, total: counts.total, left: counts.active };
      pill = {
        text: wc('admitted', { done: counts.checkedIn, total: counts.total }),
        tone: 'caution',
      };
    } else if (info?.ended) {
      pill = { text: wc('statusEnded'), tone: 'neutral' };
      extra = item.status;
    } else if (counts.active > 0) {
      pill = { text: wc('statusActive'), tone: 'positive' };
      // "2 active" says nothing the label does not; "1 active - 1 refunded" does.
      if (counts.active !== counts.total) extra = item.status;
    }
  }

  const isTicket = item.type === 'TICKET';
  const place = isTicket
    ? [info?.city, counts?.total ? b('ticketCount', { count: counts.total }) : null].filter(
        (part): part is string => Boolean(part),
      )
    : [];
  const href = item.primaryAction.href;

  return (
    <article
      aria-labelledby={titleId}
      className="relative flex min-w-0 flex-col overflow-hidden rounded-[6px] border border-brand-line bg-brand-surface sm:flex-row"
    >
      <div className="flex min-w-0 flex-1">
        <PassPhoto
          image={info?.image}
          className="min-h-[8rem] w-24 shrink-0 self-stretch min-[400px]:w-28 sm:w-44 lg:w-56"
        />

        <div className="flex min-w-0 flex-1 flex-col justify-center gap-2 p-4 sm:px-7 sm:py-6">
          {when ? (
            <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.18em] text-brand-gold-text">
              {when.day}
              <span aria-hidden> · </span>
              <span className="sr-only">, </span>
              <span className="whitespace-nowrap tabular-nums">
                {when.time}
                {when.zone ? ` ${when.zone}` : ''}
              </span>
            </p>
          ) : (
            <p className="flex items-center gap-1.5 text-[0.6875rem] font-semibold uppercase tracking-[0.18em] text-brand-gold-text">
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {item.badge ?? item.type}
            </p>
          )}
          <h2
            id={titleId}
            className="line-clamp-2 break-words font-brand-display text-[1.25rem] font-bold leading-tight tracking-[-0.01em] text-brand-ink sm:text-[1.625rem]"
          >
            {item.title}
          </h2>
          {place.length > 0 ? (
            <p className="text-brand-ui text-brand-ink-3">
              {place.map((part, i) => (
                <span key={part}>
                  {i > 0 && <span aria-hidden> · </span>}
                  {i > 0 && <span className="sr-only">, </span>}
                  {part}
                </span>
              ))}
            </p>
          ) : (
            item.subtitle && (
              <p className="line-clamp-1 text-brand-ui text-brand-ink-3">{item.subtitle}</p>
            )
          )}
          {item.expiresAt && !item.startsAt && (
            <p className="text-brand-meta text-brand-ink-3">
              {wc('expires', { when: dateTime(item.expiresAt) })}
            </p>
          )}

          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className={`${STUB_PILL} ${PILL_TONE[pill.tone]}`}>{pill.text}</span>
            {admitted && (
              <>
                <span
                  className="relative block h-[3px] w-24 overflow-hidden bg-brand-line sm:w-36"
                  role="img"
                  aria-label={pill.text}
                >
                  <span
                    className="absolute inset-y-0 left-0 bg-brand-ink"
                    style={{ width: `${Math.round((admitted.done / admitted.total) * 100)}%` }}
                  />
                </span>
                <span className="text-brand-meta text-brand-ink-3">
                  {wc('stillToArrive', { count: admitted.left })}
                </span>
              </>
            )}
            {extra && <span className="text-brand-meta text-brand-ink-3">{extra}</span>}
          </div>
        </div>
      </div>

      {/* The perforation: dashed, with a half circle cut from each end. */}
      <div aria-hidden className="relative h-0 sm:h-auto sm:w-0">
        <span className="absolute inset-x-4 top-0 border-t border-dashed border-brand-line-strong sm:inset-x-auto sm:inset-y-4 sm:left-0 sm:border-l sm:border-t-0" />
        <span className="absolute -left-3 -top-3 h-6 w-6 rounded-full border border-brand-line bg-brand-canvas" />
        <span className="absolute -right-3 -top-3 h-6 w-6 rounded-full border border-brand-line bg-brand-canvas sm:-bottom-3 sm:-left-3 sm:right-auto sm:top-auto" />
      </div>

      <div className="flex flex-col items-stretch gap-3 px-4 pb-4 pt-5 sm:w-52 sm:shrink-0 sm:items-center sm:justify-center sm:px-6 sm:py-6 lg:w-60">
        {item.reference && (
          <p className="truncate text-center font-mono text-brand-meta uppercase tracking-[0.08em] text-brand-ink-3">
            <span className="sr-only">{wc('reference')}: </span>
            {item.reference}
          </p>
        )}
        <div className="flex items-center gap-4 sm:w-full sm:flex-col sm:gap-2">
          {href ? (
            <Link
              href={href}
              aria-describedby={titleId}
              className={`inline-flex min-h-12 flex-1 items-center justify-center rounded-[3px] bg-brand-action px-6 text-brand-meta font-semibold uppercase tracking-[0.18em] text-brand-on-action transition-colors duration-150 hover:bg-brand-action-hover sm:w-full sm:flex-none ${BRAND_FOCUS}`}
            >
              {isTicket ? wc('openPass') : item.primaryAction.label}
            </Link>
          ) : (
            <button
              type="button"
              onClick={() => onPreview?.(item)}
              className={`${brandButtonClasses('secondary', 'md')} flex-1 sm:w-full sm:flex-none`}
            >
              {item.primaryAction.label}
            </button>
          )}
          {href && info?.transferable && (
            <Link
              href={`${href}?transfer=1`}
              aria-describedby={titleId}
              className={`inline-flex min-h-11 items-center justify-center rounded-sm px-1 text-brand-meta font-semibold uppercase tracking-[0.18em] text-brand-ink underline decoration-brand-ink underline-offset-[6px] hover:text-brand-gold-text hover:decoration-brand-gold-text ${BRAND_FOCUS}`}
            >
              {wc('transfer')}
            </Link>
          )}
        </div>
      </div>
    </article>
  );
}
