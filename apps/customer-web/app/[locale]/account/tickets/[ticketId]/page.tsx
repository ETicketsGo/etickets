'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useRouter } from '@/i18n/navigation';
import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  CalendarPlus,
  Check,
  CloudSun,
  Heart,
  MapPin,
  Navigation,
  ParkingCircle,
  Share2,
} from 'lucide-react';
import {
  BRAND_FOCUS,
  BrandButton,
  BrandStatusPill,
  brandButtonClasses,
  buildIcsDataUrl,
  eventImageSource,
  googleMapsUrl,
  googleDirectionsUrl,
  useCountdown,
  useToast,
  venueAddressLine,
  type BrandStatus,
} from '@eticketsgo/web-kit';
import { api, tokenStore } from '@/lib/api';
import { fetchTicketWithOffline } from '@/lib/offline/sync';
import { useFormat } from '@/lib/format';
import { eventZone } from '@/lib/event-when';
import { isSaved, toggleSaved } from '@/lib/saved';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { useMounted } from '@/lib/use-mounted';
import { useStatusLabel } from '@/lib/status-label';
import { currentPageUrl } from '@/lib/site-url';
import { BRAND_EYEBROW, BRAND_PANEL } from '@/components/booking-brand';
import { Placeholder as LoadingBlock } from '@/components/home/parts';
import { BrandEmpty, BrandPage } from '@/components/storefront-brand';

/*
  ── ONE TICKET ON THE BRAND LAYER (docs/design/DESIGN-SYSTEM.md) ───────────────────────
  The ticket a buyer holds up at the door. It used to open with a pastel gradient, a blue
  category badge and a pulsing blue glow around the QR; it now follows the confirmation page
  the buyer arrived from: the event on a stage band (title in the display face, the venue and
  the time on the venue's clock, the countdown in tabular figures), then the QR on paper with
  its status in words. Same facts, same actions, same order.
*/

/** A ticket's state as the brand's pill. Words always; the colour only helps. */
const TICKET_TONE: Record<string, BrandStatus> = {
  ACTIVE: 'positive',
  CHECKED_IN: 'info',
  TRANSFERRED: 'neutral',
  REFUNDED: 'neutral',
  CANCELLED: 'critical',
  VOID: 'critical',
};

/** The page's column: narrow, like a ticket, with the shell's gutters. */
const COLUMN = 'mx-auto max-w-2xl px-4 sm:px-6';

// Lazy-loaded (WS6): the Apple/Google wallet-pass panel is below the fold and only
// needed when a pass is available, so it's split out of the initial ticket bundle.
const WalletPasses = dynamic(
  () => import('@/components/wallet-passes').then((m) => m.WalletPasses),
  { ssr: false, loading: () => null },
);

/** The placeholder drawn when a QR image fails, in the reader's language. */
function qrFallback(text: string): string {
  const safe = text.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
  return (
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#f1f5f9"/><text x="60" y="64" font-family="sans-serif" font-size="11" fill="#94a3b8" text-anchor="middle">${safe}</text></svg>`,
    )
  );
}

export default function TicketDetailPage() {
  const w = useTranslations('storefront.wallet');
  const td = useTranslations('storefront.ticketDetail');
  const b = useTranslations('storefront.bookingTickets');
  const tx = useTranslations('common');
  const { dateTime, zoneAbbrev } = useFormat();
  const statusLabel = useStatusLabel();
  const mounted = useMounted();
  const { ticketId } = useParams<{ ticketId: string }>();
  const router = useRouter();
  const toast = useToast();
  const [shared, setShared] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!tokenStore.access) router.push(`/login?next=/account/tickets/${ticketId}`);
  }, [router, ticketId]);

  const ticketQ = useQuery({
    queryKey: ['ticket', ticketId],
    // Offline-aware (WS8): falls back to the cached wallet copy when offline.
    queryFn: () => fetchTicketWithOffline(ticketId),
    // Not `typeof window`, which differs between server and first client render. See useMounted.
    enabled: mounted && !!tokenStore.access,
  });
  const ticket = ticketQ.data;

  // Full event (venue, refund policy, organizer) for directions + context.
  const eventQ = useQuery({
    queryKey: ['event', ticket?.event.slug],
    queryFn: () => api.getEvent(ticket!.event.slug),
    enabled: !!ticket,
  });
  const event = eventQ.data;

  const countdown = useCountdown(ticket?.startsAt);

  useEffect(() => {
    if (event) setSaved(isSaved(event.id));
  }, [event]);

  const toggleSave = () => {
    if (!event) return;
    const nowSaved = toggleSaved({
      id: event.id,
      title: event.title,
      slug: event.slug,
      category: event.category,
      venue: {
        name: event.venue.name,
        city: event.venue.city,
        country: event.venue.country,
      },
      organizer: event.organizer.name,
      nextSessionAt: event.sessions[0]?.startsAt ?? null,
      fromPriceMinor: event.sessions[0]?.ticketTypes[0]?.priceMinor ?? null,
      currency: event.sessions[0]?.ticketTypes[0]?.currency ?? 'INR',
    });
    setSaved(nowSaved);
    toast.push(nowSaved ? td('savedToWishlist') : td('removedFromWishlist'), 'success');
  };

  const share = async () => {
    // On the site's own address, never the host this visitor happened to arrive on.
    const url = currentPageUrl();
    if (navigator.share) {
      await navigator.share({ title: ticket?.event.title, url }).catch(() => undefined);
    } else {
      await navigator.clipboard.writeText(url).catch(() => undefined);
      setShared(true);
      setTimeout(() => setShared(false), 2000);
    }
  };

  if (ticketQ.isError)
    return (
      <BrandPage>
        <div className={`${COLUMN} pt-10`}>
          <BrandEmpty
            title={td('loadError')}
            action={
              <BrandButton variant="secondary" onClick={() => void ticketQ.refetch()}>
                {tx('action.retry')}
              </BrandButton>
            }
          />
        </div>
      </BrandPage>
    );
  if (ticketQ.isLoading || !ticket)
    return (
      <BrandPage>
        <div className={`${COLUMN} space-y-6 pt-6 sm:pt-10`} aria-busy="true">
          <LoadingBlock className="h-48 w-full" />
          <LoadingBlock className="h-72 w-full" />
        </div>
      </BrandPage>
    );

  const zone = ticket.timezone ?? (event ? eventZone(event) : undefined);
  const venueName = event?.venue.name ?? '';
  const venueLine = event
    ? // Same composer as the event page, so the ticket and the listing agree and neither
      // prints the city twice. See `venueAddressLine`.
      venueAddressLine(event.venue)
    : '';
  const mapsQuery = event ? `${event.venue.name}, ${event.venue.city}` : ticket.event.title;
  const fallback = qrFallback(w('qrUnavailable'));
  const thumb = event
    ? eventImageSource({ variants: event.imageVariants, path: event.imagePath }, 'card')
    : null;

  const ics = buildIcsDataUrl({
    title: ticket.event.title,
    location: venueName ? `${venueName}, ${event?.venue.city}` : undefined,
    description: td('calendarDescription', { serial: ticket.serial }),
    start: ticket.startsAt,
  });

  return (
    <BrandPage>
      <div className={`${COLUMN} pt-4 sm:pt-8`}>
        <button
          type="button"
          onClick={() => router.push('/account/tickets')}
          className={`-ml-2 inline-flex min-h-11 items-center gap-1.5 rounded-brand-control px-2 text-brand-ui font-medium text-brand-ink-2 hover:text-brand-ink ${BRAND_FOCUS}`}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden /> {b('allTickets')}
        </button>
      </div>

      <div className={`${COLUMN} mt-2 space-y-6`}>
        {/* The event, on a stage band: what this ticket is for, where, and how long until. */}
        <section
          data-brand-tone="stage"
          aria-labelledby="ticket-title"
          className="overflow-hidden rounded-brand-card bg-brand-canvas text-brand-ink"
        >
          <div className="flex items-start gap-4 p-5 sm:p-6">
            <div className="min-w-0 flex-1">
              <p className="text-brand-eyebrow uppercase text-brand-ink-2">
                {event?.category ?? td('categoryFallback')}
              </p>
              <h1
                id="ticket-title"
                className="mt-2 text-balance font-brand-display text-brand-d3 text-brand-ink"
              >
                {ticket.event.title}
              </h1>
              <p className="mt-2 flex items-center gap-1.5 text-brand-ui text-brand-ink-2">
                <MapPin className="h-4 w-4 shrink-0" aria-hidden /> {venueName || td('venueTba')}
              </p>
            </div>
            {thumb && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={thumb.src}
                srcSet={thumb.srcSet}
                sizes="96px"
                alt=""
                width={400}
                height={300}
                className="hidden aspect-[4/3] w-24 shrink-0 rounded-brand-control object-cover min-[360px]:block"
              />
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-t border-brand-line px-5 py-4 sm:px-6">
            {countdown.isPast ? (
              <p className="text-brand-ui font-medium text-brand-ink-2">{td('pastEvent')}</p>
            ) : (
              <div className="flex items-center gap-4">
                <span className="text-brand-eyebrow uppercase text-brand-ink-2">
                  {td('startsIn')}
                </span>
                <div className="flex gap-3 tabular-nums">
                  {[
                    { k: 'd', v: countdown.days, l: td('unitDays') },
                    { k: 'h', v: countdown.hours, l: td('unitHours') },
                    { k: 'm', v: countdown.minutes, l: td('unitMinutes') },
                    { k: 's', v: countdown.seconds, l: td('unitSeconds') },
                  ].map((u) => (
                    <div key={u.k} className="text-center">
                      <span className="block text-brand-figure-sm text-brand-ink">
                        {String(u.v).padStart(2, '0')}
                      </span>
                      <span className="text-brand-meta text-brand-ink-2">{u.l}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={toggleSave}
                aria-label={saved ? td('removeFromWishlist') : td('saveToWishlist')}
                aria-pressed={saved}
                // Square: the secondary button's own padding would leave the icon no room.
                className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-brand-control border border-brand-line-strong bg-brand-surface text-brand-ink transition-colors duration-150 hover:border-brand-ink-3 ${BRAND_FOCUS}`}
              >
                <Heart className={`h-4 w-4 ${saved ? 'fill-current' : ''}`} aria-hidden />
              </button>
              <button
                type="button"
                onClick={share}
                aria-label={tx('action.share')}
                className={brandButtonClasses('secondary', 'md')}
              >
                <Share2 className="h-4 w-4" aria-hidden />{' '}
                {shared ? td('copied') : tx('action.share')}
              </button>
            </div>
          </div>
        </section>

        {/* The QR: what the door scans. On white, for the scanner, never tinted. */}
        <section className={`${BRAND_PANEL} p-6 text-center`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            // A vendor barcode the server cannot draw arrives as null: show the fallback.
            src={ticket.qrDataUrl ?? fallback}
            alt={b('qrAlt', { serial: ticket.serial })}
            onError={(e) => {
              const img = e.currentTarget;
              if (img.src !== fallback) img.src = fallback;
            }}
            className="mx-auto h-56 w-56 rounded-brand-control border border-brand-line bg-white p-2"
          />
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <BrandStatusPill status={TICKET_TONE[ticket.status] ?? 'neutral'}>
              {statusLabel('ticket', ticket.status)}
            </BrandStatusPill>
            <span className="font-mono text-brand-meta text-brand-ink-3">{ticket.serial}</span>
          </div>
          {/*
            The venue's clock, named. A phone set to another zone showed a different time from the
            one printed at the venue; the ticket's own zone first, the event's venue if the ticket
            does not carry one.
          */}
          <p className="mt-2 text-brand-ui font-semibold tabular-nums text-brand-ink">
            {dateTime(ticket.startsAt, undefined, zone)}
            {zone ? (
              <span className="font-normal text-brand-ink-2">
                {' '}
                ({zoneAbbrev(ticket.startsAt, zone)})
              </span>
            ) : null}
          </p>
          {ticket.holderName && (
            <p className="mt-1 text-brand-meta text-brand-ink-2">
              {td('holder', { name: ticket.holderName })}
            </p>
          )}
        </section>

        {/* Actions */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <a
            href={ics}
            download={`${ticket.event.slug}.ics`}
            className={`${brandButtonClasses('secondary', 'md')} whitespace-normal text-center`}
          >
            <CalendarPlus className="h-4 w-4 shrink-0" aria-hidden /> {tx('action.addToCalendar')}
          </a>
          <a
            href={googleDirectionsUrl(mapsQuery)}
            target="_blank"
            rel="noreferrer"
            className={`${brandButtonClasses('secondary', 'md')} whitespace-normal text-center`}
          >
            <Navigation className="h-4 w-4 shrink-0" aria-hidden /> {td('directions')}
          </a>
          <a
            href={googleMapsUrl(mapsQuery)}
            target="_blank"
            rel="noreferrer"
            className={`${brandButtonClasses('secondary', 'md')} col-span-2 whitespace-normal text-center sm:col-span-1`}
          >
            <MapPin className="h-4 w-4 shrink-0" aria-hidden /> {td('viewVenue')}
          </a>
        </div>

        {/* Wallet passes (only when a provider is configured + the ticket is eligible) */}
        <WalletPasses ticketId={ticket.id} ticketStatus={ticket.status} />

        {/* Venue + placeholders */}
        <div className="grid gap-3 sm:grid-cols-3">
          <div className={`${BRAND_PANEL} p-4 sm:col-span-3`}>
            <p className="font-brand-display text-brand-card text-brand-ink">
              {venueName || td('venue')}
            </p>
            <p className="mt-1 text-brand-ui text-brand-ink-2">
              {venueLine || td('detailsToFollow')}
            </p>
          </div>
          <Placeholder icon={CloudSun} title={td('weather')} note={td('weatherNote')} />
          <Placeholder icon={ParkingCircle} title={td('parking')} note={td('parkingNote')} />
          <Placeholder icon={Navigation} title={td('gettingThere')} note={td('gettingThereNote')} />
        </div>

        {/* Status timeline */}
        <section className={`${BRAND_PANEL} p-5`}>
          <h2 className={`mb-4 ${BRAND_EYEBROW}`}>{w('ticketStatus')}</h2>
          <Timeline status={ticket.status} />
        </section>
      </div>
    </BrandPage>
  );
}

function Placeholder({
  icon: Icon,
  title,
  note,
}: {
  icon: typeof CloudSun;
  title: string;
  note: string;
}) {
  return (
    <div className="rounded-brand-card bg-brand-sunken p-4">
      <div className="flex items-center gap-2 text-brand-ink-2">
        <Icon className="h-4 w-4" aria-hidden />
        <p className="text-brand-ui font-semibold text-brand-ink">{title}</p>
      </div>
      <p className="mt-1 text-brand-meta text-brand-ink-2">{note}</p>
    </div>
  );
}

function Timeline({ status }: { status: string }) {
  const td = useTranslations('storefront.ticketDetail');
  const refunded = status === 'REFUNDED' || status === 'CANCELLED' || status === 'VOID';
  const steps = [
    { key: 'ISSUED', label: td('timeline.issued'), done: true },
    {
      key: 'ACTIVE',
      label: refunded ? td('timeline.cancelled') : td('timeline.ready'),
      done: status === 'ACTIVE' || status === 'CHECKED_IN' || refunded,
      tone: refunded ? ('error' as const) : ('success' as const),
    },
    {
      key: 'CHECKED_IN',
      label: td('timeline.checkedIn'),
      done: status === 'CHECKED_IN',
      tone: 'info' as const,
    },
  ];
  return (
    <ol className="space-y-4">
      {steps.map((s, i) => (
        <li key={s.key} className="flex gap-3">
          <div className="flex flex-col items-center">
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-full text-brand-meta tabular-nums ${
                s.done ? 'bg-brand-action text-brand-on-action' : 'bg-brand-sunken text-brand-ink-3'
              }`}
            >
              {s.done ? <Check className="h-3.5 w-3.5" aria-hidden /> : i + 1}
            </span>
            {i < steps.length - 1 && <span className="my-1 h-6 w-px bg-brand-line-strong" />}
          </div>
          <span
            className={`pt-0.5 text-brand-ui ${s.done ? 'text-brand-ink' : 'text-brand-ink-3'}`}
          >
            {s.label}
          </span>
        </li>
      ))}
    </ol>
  );
}
