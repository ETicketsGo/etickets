'use client';

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  BRAND_FOCUS,
  BrandStatusPill,
  EventArtwork,
  brandButtonClasses,
  eventImageSource,
  portableImageUrl,
  type PublicEventCard,
  type PublicMovieCard,
} from '@eticketsgo/web-kit';
import { Link } from '@/i18n/navigation';
import { useFormat } from '@/lib/format';
import { priceSlot, type Buyability } from '@/lib/home-feed';

/*
  ── THE HOME PAGE'S PIECES (docs/design/DESIGN-SYSTEM.md) ─────────────────────────────
  Composed from the brand tokens and web-kit's brand pieces only. Every date is the VENUE's
  clock, with its zone named whenever it is not the reader's own; every price is the API's
  `fromPriceMinor` in the event's own currency, never converted and never summed.
*/

/**
 * "Sat 21 Nov" and "6:30 pm", at the venue, plus the zone when it differs from the reader's.
 *
 * Short day names on purpose (DESIGN-SYSTEM.md section 9): a card has one meta line, and the
 * day of the week is what people plan around. The zone is the audit's C4: an unzoned time on
 * an international platform is a missed show waiting to happen.
 */
/** The reader's own zone; undefined where Intl cannot say, which then names every zone. */
function readerZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

export function useVenueWhen() {
  const fmt = useFormat();
  const locale = fmt.locale ?? 'en-IN';
  return (iso: string | null, timeZone?: string | null) => {
    if (!iso) return null;
    const at = new Date(iso);
    const zone = timeZone ?? undefined;
    let day: string;
    let time: string;
    try {
      day = new Intl.DateTimeFormat(locale, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        timeZone: zone,
      })
        .format(at)
        .replace(/,/g, '');
      time = new Intl.DateTimeFormat(locale, {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: zone,
      }).format(at);
    } catch {
      return null;
    }
    /*
      Compared by what the zone IS at that instant, not by its name: Chromium reports India as
      "Asia/Calcutta" while venues store "Asia/Kolkata", and a name comparison named the zone
      on every Indian card for an Indian reader.
    */
    const venueZone = zone ? fmt.zoneAbbrev(at, zone) : null;
    const named = venueZone && venueZone !== fmt.zoneAbbrev(at, readerZone()) ? venueZone : null;
    return { day, time: named ? `${time} ${named}` : time };
  };
}

/** Whether a session starts today on the venue's calendar. */
export function isTodayAt(iso: string | null, timeZone?: string | null): boolean {
  if (!iso) return false;
  try {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone ?? undefined });
    return f.format(new Date(iso)) === f.format(new Date());
  } catch {
    return false;
  }
}

/**
 * "From Rs 999", "Free", or nothing.
 *
 * Nothing when the API has no price: "From -" reads as a page that failed to load. Always the
 * event's own currency; a group never mixes currencies, and its heading names the one it is in.
 */
export function FromPrice({
  event,
  size = 'ui',
}: {
  event: Pick<PublicEventCard, 'fromPriceMinor' | 'currency'>;
  size?: 'ui' | 'figure';
}) {
  const t = useTranslations('common.state');
  const { money } = useFormat();
  if (event.fromPriceMinor == null) return null;
  const amount =
    size === 'figure'
      ? 'text-brand-figure-sm text-brand-ink'
      : 'text-brand-ui font-semibold text-brand-ink';
  if (event.fromPriceMinor === 0) return <span className={amount}>{t('free')}</span>;
  return (
    <span className="whitespace-nowrap text-brand-meta text-brand-ink-3">
      {t('from')}{' '}
      <span className={`tabular-nums ${amount}`}>
        {money(event.fromPriceMinor, event.currency)}
      </span>
    </span>
  );
}

/**
 * The price, or - when the event cannot be bought - the reason in one word. "From Rs 799" on a
 * sold-out show invites a click that ends at "Sold out" one page later. `state` comes from the
 * event's own payload (see `buyability`).
 */
export function PriceOrState({
  event,
  state,
}: {
  event: Pick<PublicEventCard, 'fromPriceMinor' | 'currency'>;
  state?: Buyability;
}) {
  const common = useTranslations('common.state');
  const t = useTranslations('home.state');
  // A price only once the event's own payload proves something is on sale (see priceSlot).
  switch (priceSlot(state)) {
    case 'price':
      return <FromPrice event={event} />;
    case 'soldOut':
      return <BrandStatusPill status="neutral">{common('soldOut')}</BrandStatusPill>;
    case 'notYet':
      return <BrandStatusPill status="info">{t('notYet')}</BrandStatusPill>;
    case 'closed':
      return <BrandStatusPill status="neutral">{t('closed')}</BrandStatusPill>;
    default:
      return null;
  }
}

export function SectionHead({
  title,
  action,
  hint,
  id,
}: {
  title: string;
  action?: ReactNode;
  hint?: string;
  id?: string;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        <h2 id={id} className="text-balance font-brand-display text-brand-d2 text-brand-ink">
          {title}
        </h2>
        {hint && <p className="mt-2 text-brand-meta text-brand-ink-3">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

/** A text link at the end of a section heading ("See all 38", "Change city"). */
export function sectionLinkClasses(): string {
  return `inline-flex min-h-11 items-center rounded-sm text-brand-ui font-semibold text-brand-ink underline decoration-brand-line-strong decoration-2 underline-offset-4 hover:decoration-brand-ink ${BRAND_FOCUS}`;
}

/** The event's own card copy, or null for the typographic artwork. */
function cardImage(event: PublicEventCard, use: 'card' | 'banner') {
  return eventImageSource({ variants: event.imageVariants, path: event.imagePath }, use);
}

/**
 * The no-photo artwork at thumbnail size.
 *
 * `EventArtwork`'s fallback sets the title at the featured-card size, which at 112px wide
 * overflows its own box. Same idea, smaller type: the title in the display face on the stage
 * tone with the marigold rule. Listed for D-1 to absorb as a size of EventArtwork.
 */
function SmallArtwork({ title }: { title: string }) {
  return (
    <div
      data-brand-tone="stage"
      data-artwork="fallback"
      role="img"
      aria-label={title}
      className="absolute inset-0 flex flex-col justify-end gap-1.5 bg-brand-canvas p-2.5"
    >
      <span className="line-clamp-3 font-brand-display text-[0.8125rem] font-bold leading-[1.1] text-brand-ink">
        {title}
      </span>
      <span aria-hidden className="h-[3px] w-6 rounded-full bg-brand-marigold" />
    </div>
  );
}

/** A 4:3 thumbnail for a list row: the photo, or the small artwork. */
function RowThumb({ event }: { event: PublicEventCard }) {
  const image = cardImage(event, 'card');
  const [failed, setFailed] = useState(false);
  return (
    <div className="relative aspect-[4/3] w-full overflow-hidden rounded-brand-control bg-brand-sunken">
      {image && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={image.src}
          srcSet={image.srcSet}
          sizes="112px"
          alt=""
          width={400}
          height={300}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <SmallArtwork title={event.title} />
      )}
    </div>
  );
}

/** The 16:9 lead of an editorial section. */
export function FeatureCard({ event, state }: { event: PublicEventCard; state?: Buyability }) {
  const when = useVenueWhen()(event.nextSessionAt, event.venue.timezone);
  const image = cardImage(event, 'banner');
  return (
    <Link
      href={`/events/${event.slug}`}
      className={`group block rounded-brand-card ${BRAND_FOCUS}`}
    >
      <div className="overflow-hidden rounded-brand-card">
        <div className="transition-transform duration-150 motion-safe:group-hover:scale-[1.02]">
          <EventArtwork
            src={image?.src}
            srcSet={image?.srcSet}
            sizes="(min-width: 1024px) 58vw, 100vw"
            alt=""
            title={event.title}
            eyebrow={event.category}
            ratio="16:9"
          />
        </div>
      </div>
      <p className="mt-4 text-brand-eyebrow uppercase text-brand-ink-3">{event.category}</p>
      <h3 className="mt-1 line-clamp-3 text-balance font-brand-display text-brand-d3 text-brand-ink">
        {event.title}
      </h3>
      <p className="mt-2 text-brand-ui text-brand-ink">
        {when && (
          <span className="font-semibold">
            {when.day}, {when.time}
          </span>
        )}
        <span className="text-brand-ink-2">
          {when ? ' - ' : ''}
          {event.venue.name}, {event.venue.city}
        </span>
      </p>
      <p className="mt-2">
        <PriceOrState event={event} state={state} />
      </p>
    </Link>
  );
}

/** One row of the 4:3 list beside the feature. */
export function EventRow({ event, state }: { event: PublicEventCard; state?: Buyability }) {
  const when = useVenueWhen()(event.nextSessionAt, event.venue.timezone);
  return (
    <Link
      href={`/events/${event.slug}`}
      className={`grid grid-cols-[96px_1fr] items-center gap-x-4 gap-y-1 rounded-brand-control py-4 sm:grid-cols-[112px_1fr_auto] ${BRAND_FOCUS}`}
    >
      <div className="row-span-2 sm:row-span-1">
        <RowThumb event={event} />
      </div>
      <div className="min-w-0 self-end sm:self-center">
        <p className="text-brand-eyebrow uppercase text-brand-ink-3">{event.category}</p>
        <h3 className="mt-1 line-clamp-2 font-brand-display text-brand-card text-brand-ink">
          {event.title}
        </h3>
        <p className="mt-1 line-clamp-2 text-brand-meta text-brand-ink-2">
          {when ? `${when.day}, ${when.time} - ` : ''}
          {event.venue.name}, {event.venue.city}
        </p>
      </div>
      {/*
        One price element, placed by the grid: under the meta line on a phone, its own
        right-hand column from `sm`. Two copies (one hidden per width) left a hidden "From"
        first in the page, which is what a reader of the DOM - or a test - finds first.
      */}
      <p className="col-start-2 self-start sm:col-start-3 sm:row-start-1 sm:self-center sm:text-right">
        <PriceOrState event={event} state={state} />
      </p>
    </Link>
  );
}

/** A 4:3 card in a rail. `showCity` puts the city in the eyebrow, for events elsewhere. */
export function EventTile({
  event,
  showCity = false,
  state,
}: {
  event: PublicEventCard;
  showCity?: boolean;
  state?: Buyability;
}) {
  const when = useVenueWhen()(event.nextSessionAt, event.venue.timezone);
  const image = cardImage(event, 'card');
  return (
    <Link
      href={`/events/${event.slug}`}
      className={`group block rounded-brand-card ${BRAND_FOCUS}`}
    >
      <div className="overflow-hidden rounded-brand-card">
        <div className="transition-transform duration-150 motion-safe:group-hover:scale-[1.02]">
          <EventArtwork
            src={image?.src}
            srcSet={image?.srcSet}
            sizes="(min-width: 1024px) 25vw, 72vw"
            alt=""
            title={event.title}
            eyebrow={event.category}
            ratio="4:3"
          />
        </div>
      </div>
      <p className="mt-3 text-brand-eyebrow uppercase text-brand-ink-3">
        {event.category}
        {showCity ? ` / ${event.venue.city}` : ''}
      </p>
      <h3 className="mt-1 line-clamp-2 font-brand-display text-brand-card text-brand-ink">
        {event.title}
      </h3>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-brand-meta text-brand-ink-2">
          {when ? `${when.day}, ${when.time}` : event.venue.name}
        </span>
        <PriceOrState event={event} state={state} />
      </div>
    </Link>
  );
}

/** A 2:3 film poster on the stage band. */
export function PosterCard({ movie }: { movie: PublicMovieCard }) {
  const t = useTranslations('showtimes');
  const s = useTranslations('home.sections');
  return (
    <Link
      href={`/movies/${movie.slug}`}
      className={`group block rounded-brand-card ${BRAND_FOCUS}`}
    >
      <div className="relative overflow-hidden rounded-brand-card">
        <div className="transition-transform duration-150 motion-safe:group-hover:scale-[1.02]">
          <EventArtwork
            src={portableImageUrl(movie.posterUrl)}
            sizes="(min-width: 1024px) 18vw, 42vw"
            alt={t('movie.poster', { title: movie.title })}
            title={movie.title}
            eyebrow={s('film')}
            ratio="2:3"
          />
        </div>
        {/*
          On the stage band the no-poster artwork is the band's own colour, so it had no edge.
          A hairline laid over the box gives it one (the specimen sets it on `surface` for the
          same reason); over a real poster it is a barely visible frame.
        */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-brand-card ring-1 ring-inset ring-brand-line-strong"
        />
      </div>
      <h3 className="mt-3 line-clamp-2 font-brand-display text-brand-card text-brand-ink">
        {movie.title}
      </h3>
      <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-brand-meta text-brand-ink-2">
        {movie.certificate && (
          <span className="inline-flex h-5 items-center rounded border border-brand-line-strong px-1.5 text-[0.6875rem] font-semibold text-brand-ink-2">
            {movie.certificate}
          </span>
        )}
        <span>
          {movie.language} - {t('card.runtime', { minutes: movie.runtimeMinutes })}
        </span>
      </p>
    </Link>
  );
}

/**
 * A row that scrolls inside itself on a phone, with the next card peeking, and becomes a grid
 * from `lg`. The page itself never scrolls sideways (DESIGN-SYSTEM.md section 7).
 *
 * `cols` is the desktop column count; `phone` the card width on a phone ("42%" says there is
 * more for posters, a wider card for 4:3 pictures).
 */
export function Rail({
  children,
  cols = 4,
  phone = 'wide',
  label,
}: {
  children: ReactNode;
  cols?: 4 | 5 | 6;
  phone?: 'wide' | 'poster';
  label: string;
}) {
  const grid = { 4: 'lg:grid-cols-4', 5: 'lg:grid-cols-5', 6: 'lg:grid-cols-6' }[cols];
  const width =
    phone === 'poster'
      ? 'auto-cols-[42%] sm:auto-cols-[28%]'
      : 'auto-cols-[72%] sm:auto-cols-[44%]';
  return (
    <ul
      aria-label={label}
      className={`-mx-4 grid scroll-px-4 snap-x snap-mandatory sm:scroll-px-6 grid-flow-col gap-4 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6 lg:mx-0 lg:grid-flow-row lg:gap-6 lg:overflow-visible lg:px-0 lg:pb-0 ${width} ${grid} lg:auto-cols-auto`}
    >
      {children}
    </ul>
  );
}

export function RailItem({ children }: { children: ReactNode }) {
  return <li className="min-w-0 snap-start">{children}</li>;
}

/** The hero: one real event, its photo, and the one action on the page. */
export function StageHero({ event }: { event: PublicEventCard }) {
  const h = useTranslations('home.hero');
  const nav = useTranslations('home.chips');
  const when = useVenueWhen()(event.nextSessionAt, event.venue.timezone);
  const image = cardImage(event, 'banner');
  const [failed, setFailed] = useState(false);
  const today = isTodayAt(event.nextSessionAt, event.venue.timezone);
  return (
    <section
      data-brand-tone="stage"
      aria-label={h('label')}
      className="relative isolate overflow-hidden bg-brand-canvas text-brand-ink"
    >
      {image && !failed && (
        <div className="absolute inset-0 -z-10">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={image.src}
            srcSet={image.srcSet}
            sizes="100vw"
            alt=""
            width={1280}
            height={720}
            loading="eager"
            fetchPriority="high"
            decoding="async"
            onError={() => setFailed(true)}
            className="h-full w-full object-cover"
          />
          {/*
            The scrim: the one gradient the system allows, from the text side only, so the
            words never sit on the photo's busy middle. Bottom-up on a phone, where the text is
            at the bottom; left-to-right from `lg`, where it takes the left third.
          */}
          <div
            aria-hidden
            className="absolute inset-0 bg-gradient-to-t from-brand-scrim/95 via-brand-scrim/60 to-brand-scrim/10 lg:bg-gradient-to-r lg:from-brand-scrim/90 lg:via-brand-scrim/70 lg:to-brand-scrim/0"
          />
        </div>
      )}
      <div className="mx-auto flex min-h-[520px] max-w-shell flex-col justify-end px-4 pb-8 pt-24 sm:px-6 lg:min-h-[600px] lg:px-10 lg:pb-16">
        <div className="max-w-2xl">
          <div className="flex flex-wrap items-center gap-3">
            {today && <BrandStatusPill status="live">{nav('today')}</BrandStatusPill>}
            <span className="text-brand-eyebrow uppercase text-brand-ink-2">
              {event.category} / {event.venue.city}
            </span>
          </div>
          <h2 className="mt-4 line-clamp-3 max-w-[14ch] text-balance font-brand-display text-brand-hero text-brand-ink">
            {event.title}
          </h2>
          <ul className="mt-5 flex flex-wrap gap-x-7 gap-y-2 text-brand-body text-brand-ink-2">
            {when && (
              <li>
                <b className="font-semibold text-brand-ink">{when.day}</b> {when.time}
              </li>
            )}
            <li>
              <b className="font-semibold text-brand-ink">{event.venue.name}</b> {event.venue.city}
            </li>
            {event.organizer && <li>{h('by', { name: event.organizer })}</li>}
          </ul>
          <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3">
            <Link href={`/events/${event.slug}`} className={brandButtonClasses('primary', 'lg')}>
              {h('book')}
            </Link>
            <FromPrice event={event} size="figure" />
          </div>
        </div>
      </div>
    </section>
  );
}

/** A placeholder block while a section loads: a sunken shape, pulsing only if motion is OK. */
export function Placeholder({ className }: { className: string }) {
  return (
    <div
      aria-hidden
      className={`rounded-brand-card bg-brand-sunken motion-safe:animate-pulse ${className}`}
    />
  );
}
