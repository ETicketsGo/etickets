'use client';

import { useState } from 'react';
import { BadgeCheck, ChevronRight, FileText, Globe, Instagram } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  BRAND_FOCUS,
  apiAssetUrl,
  splitMinutes,
  termsList,
  type EventArtist,
  type PublicEvent,
} from '@eticketsgo/web-kit';
import { Link } from '@/i18n/navigation';
import { Dialog } from '@/components/ui';
import { BrandActionButton } from '@/components/brand-forms';
import { BRAND_EYEBROW, BRAND_LINK } from '@/components/booking-brand';
import type { ArrivalFact } from '@/lib/event-editorial';

/**
 * The event details buyers check before they pay, asked for by the owner after a BookMyShow
 * event page: who is running it and who is on stage, the age limit, how long it runs, and the
 * organizer's terms. Each block renders nothing when the organizer has said nothing - an empty
 * "Artists" heading or "Age limit: none" would be a claim the organizer never made.
 */

/** "1 hour 30 minutes", in the reader's language. */
export function useDurationText() {
  const t = useTranslations('storefront.event');
  return (minutes: number) => {
    const { hours, minutes: rest } = splitMinutes(minutes);
    return [
      hours ? t('durationHours', { count: hours }) : null,
      rest ? t('durationMinutes', { count: rest }) : null,
    ]
      .filter(Boolean)
      .join(' ');
  };
}

/** One cell of the fact row. */
interface FactCell {
  label: string;
  lines: string[];
  sub?: string | null;
  /** Marks the lines as a machine-readable time. */
  dateTime?: string | null;
}

/**
 * The key facts, as the owner's hairline-ruled row: DATE, TIME, VENUE, then how long it runs and
 * who it is for when the organizer said.
 *
 * The design labels the middle cell "DOORS . SHOW". No session has a doors time, so it is the
 * show's time alone and labelled so; a doors time is never guessed from the start.
 *
 * Duration is the SELECTED show's, read from its own start and end - never a separate number
 * that could disagree with the ticket. The date and time are the venue's clock with its zone
 * named, and a short note says so once, here, rather than on every line that prints a time.
 */
export function EventFacts({
  event,
  when,
  startsAt,
  longDate,
  duration,
  dateRange,
  note,
}: {
  event: PublicEvent;
  /** The shown date in the venue's clock, from `useVenueWhen`. */
  when: { day: string; time: string; zone: string } | null;
  /** The shown show's start, for the machine-readable `<time>` around the time. */
  startsAt: string | null;
  /** The same date written out: "Thursday", "5 November 2026". */
  longDate: { weekday: string; date: string } | null;
  /** "3 hours", or null when the show has no length. */
  duration: string | null;
  /** "21 Nov to 28 Nov" when the event has more than one date still to come. */
  dateRange: string | null;
  /** "Times are at the venue, in its time zone." */
  note: string;
}) {
  const t = useTranslations('storefront.event');
  const cells = (
    [
      when && longDate
        ? {
            label: t('dateLabel'),
            lines: [longDate.weekday, longDate.date],
            sub: dateRange,
          }
        : null,
      when
        ? {
            label: t('timeLabel'),
            lines: [`${when.time}${when.zone ? ` ${when.zone}` : ''}`],
            dateTime: startsAt,
          }
        : null,
      { label: t('venueHeading'), lines: [event.venue.name, event.venue.city] },
      duration ? { label: t('durationLabel'), lines: [duration] } : null,
      event.ageLimit
        ? { label: t('ageLabel'), lines: [t('ageLimit', { age: event.ageLimit })] }
        : null,
    ] as (FactCell | null)[]
  ).filter((cell): cell is FactCell => cell !== null);

  return (
    <div>
      {/*
        One ruled row: an ink rule above, a hairline below, hairlines between the cells. Five
        facts at most, three to a row from `sm`, two on a phone.
      */}
      <dl className="grid grid-cols-2 border-t border-brand-ink sm:grid-cols-3">
        {cells.map(({ label, lines, sub, dateTime }) => (
          <div
            key={label}
            className="min-w-0 border-b border-brand-line py-4 even:border-l even:pl-4 sm:border-l sm:px-5 sm:[&:nth-child(3n+1)]:border-l-0 sm:[&:nth-child(3n+1)]:pl-0"
          >
            <dt className="text-brand-eyebrow uppercase text-brand-ink-3">{label}</dt>
            <dd className="mt-2 font-brand-display text-brand-card text-brand-ink">
              {lines.map((line) =>
                dateTime ? (
                  <time key={line} dateTime={dateTime} className="block break-words">
                    {line}
                  </time>
                ) : (
                  <span key={line} className="block break-words">
                    {line}
                  </span>
                ),
              )}
              {sub ? (
                <span className="mt-1 block font-brand-text text-brand-meta text-brand-ink-2">
                  {sub}
                </span>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
      {when?.zone ? <p className="mt-3 text-brand-meta text-brand-ink-3">{note}</p> : null}
    </div>
  );
}

/**
 * "Before you arrive": short facts, two to a row, each only when it is true for this event.
 * Which ones hold is decided in `lib/event-editorial.ts`; this only draws them.
 */
export function ArrivalFacts({ facts }: { facts: ArrivalFact[] }) {
  const t = useTranslations('storefront.event');
  if (!facts.length) return null;
  const copy: Record<ArrivalFact, { title: string; body: string }> = {
    offline: { title: t('arriveOfflineTitle'), body: t('arriveOfflineBody') },
    transfer: { title: t('arriveTransferTitle'), body: t('arriveTransferBody') },
  };
  return (
    <section aria-labelledby="arrive-heading">
      <h2 id="arrive-heading" className="font-brand-display text-brand-d2 text-brand-ink">
        {t('beforeYouArrive')}
      </h2>
      <ul className="mt-5 grid grid-cols-1 gap-x-8 sm:grid-cols-2">
        {facts.map((fact) => (
          <li key={fact} className="border-t border-brand-line py-4">
            <h3 className="text-brand-body font-semibold text-brand-ink">{copy[fact].title}</h3>
            <p className="mt-1 text-brand-meta text-brand-ink-2">{copy[fact].body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Two letters for a face we do not have a photo of: "Venkat Blaze" -> "VB". */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (
    (parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')
  ).toUpperCase();
}

/** Who is on stage, in the order the organizer listed them. */
export function ArtistsCard({ artists }: { artists: EventArtist[] | null | undefined }) {
  const t = useTranslations('storefront.event');
  if (!artists?.length) return null;
  return (
    <section aria-labelledby="artists-heading">
      <h2 id="artists-heading" className="font-brand-display text-brand-d2 text-brand-ink">
        {t('artistsHeading')}
      </h2>
      <ul className="mt-4 grid gap-6 sm:grid-cols-2">
        {artists.map((artist, index) => (
          <li key={`${artist.name}-${index}`} className="flex items-start gap-4">
            {/*
              Initials on the sunken paper, in ink: a face we do not have, said plainly. Never a
              coloured tile - the brand has no category or decoration colours.
            */}
            <span
              aria-hidden
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand-sunken text-brand-ui font-semibold text-brand-ink-2"
            >
              {initials(artist.name)}
            </span>
            <div className="min-w-0">
              <p className="font-brand-display text-brand-card text-brand-ink">{artist.name}</p>
              {artist.role ? (
                <p className="text-brand-meta text-brand-ink-3">{artist.role}</p>
              ) : null}
              {artist.bio ? (
                <p className="mt-1 text-brand-ui text-brand-ink-2">{artist.bio}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * A link the organizer typed, only if it is a web address.
 *
 * An organizer profile field is free text. Rendering it as an href unchecked would let
 * `javascript:` through onto the event page under this platform's name.
 */
function webLink(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Who is running this: logo, name, whether the platform has verified them, a line about them,
 * and where else to find them. The same facts the organizer's public page shows, brought to the
 * page where somebody is deciding whether to trust them with money.
 */
export function OrganizerCard({ organizer }: { organizer: PublicEvent['organizer'] }) {
  const t = useTranslations('storefront.event');
  /*
    An uploaded logo is a PATH on our own API, which `webLink` rejects - it only admits
    absolute http(s) URLs, which is right for the organizer's own website and instagram but
    would silently drop every picture uploaded here. Resolved first, then checked.
  */
  const logo = webLink(apiAssetUrl(organizer.logoUrl));
  const website = webLink(organizer.website);
  const instagram = webLink(organizer.instagramUrl);
  return (
    <section
      aria-labelledby="organizer-heading"
      className="min-w-0 border-t border-brand-line pt-5"
    >
      <h2 id="organizer-heading" className={BRAND_EYEBROW}>
        {t('organizerHeading')}
      </h2>
      <Link
        href={`/organizers/${organizer.id}`}
        className={`group mt-3 flex min-h-11 items-center gap-3 rounded-brand-control ${BRAND_FOCUS}`}
      >
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logo}
            alt=""
            width={44}
            height={44}
            className="h-11 w-11 shrink-0 rounded-full border border-brand-line bg-brand-surface object-cover"
          />
        ) : (
          <span
            aria-hidden
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-sunken text-brand-ui font-semibold text-brand-ink-2"
          >
            {initials(organizer.name)}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1 font-brand-display text-brand-card text-brand-ink">
            <span className="truncate group-hover:underline">{organizer.name}</span>
            {organizer.verified ? (
              <BadgeCheck
                className="h-4 w-4 shrink-0 text-brand-ink"
                aria-label={t('organizerVerified')}
              />
            ) : null}
          </p>
          <p className="text-brand-meta text-brand-ink-3">
            {organizer.verified ? t('organizerVerified') : t('viewProfile')}
          </p>
        </div>
        <ChevronRight
          className="h-4 w-4 text-brand-ink-3 transition-transform group-hover:translate-x-0.5"
          aria-hidden
        />
      </Link>
      {organizer.description ? (
        <p className="mt-3 line-clamp-3 text-brand-ui text-brand-ink-2">{organizer.description}</p>
      ) : null}
      {website || instagram ? (
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-brand-ui">
          {website ? (
            <a
              href={website}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className={`inline-flex min-h-11 items-center gap-1.5 ${BRAND_LINK}`}
            >
              <Globe className="h-4 w-4" aria-hidden /> {t('organizerWebsite')}
              <span className="sr-only">{t('opensInNewTab')}</span>
            </a>
          ) : null}
          {instagram ? (
            <a
              href={instagram}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className={`inline-flex min-h-11 items-center gap-1.5 ${BRAND_LINK}`}
            >
              <Instagram className="h-4 w-4" aria-hidden /> {t('organizerInstagram')}
              <span className="sr-only">{t('opensInNewTab')}</span>
            </a>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The organizer's terms: a row that opens them, and the dialog it opens.
 *
 * In a dialog rather than laid out on the page, as the buyer expects from other ticketing
 * sites: the terms matter, but they are a reference, not the content of the page. Numbered by
 * the page, one per line the organizer wrote.
 */
export function useTermsDialog(event: PublicEvent | undefined) {
  const t = useTranslations('storefront.event');
  const tx = useTranslations('common');
  const [open, setOpen] = useState(false);
  // Called before the page knows whether the event loaded, as a hook must be; nothing until it has.
  const terms = termsList(event?.termsAndConditions);

  const dialog = terms.length ? (
    <Dialog open={open} onClose={() => setOpen(false)} title={t('termsHeading')}>
      <p className="text-brand-meta text-brand-ink-3">
        {t('termsSetBy', { organizer: event?.organizer.name ?? '' })}
      </p>
      <ol className="mt-3 list-decimal space-y-2 pl-5 text-brand-ui text-brand-ink-2">
        {terms.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ol>
      <div className="mt-5 flex justify-end">
        <BrandActionButton variant="secondary" onClick={() => setOpen(false)}>
          {tx('action.close')}
        </BrandActionButton>
      </div>
    </Dialog>
  ) : null;

  return { hasTerms: terms.length > 0, open: () => setOpen(true), dialog };
}

/** The link that opens the terms, beside the other help links. */
export function TermsRow({ onOpen }: { onOpen: () => void }) {
  const t = useTranslations('storefront.event');
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`inline-flex min-h-11 items-center gap-1.5 ${BRAND_LINK}`}
    >
      <FileText className="h-4 w-4" aria-hidden />
      {t('termsHeading')}
    </button>
  );
}

/** The line under the pay button, so agreeing to the terms is never a surprise. */
export function TermsAgreeNote({ onOpen }: { onOpen: () => void }) {
  const t = useTranslations('storefront.event');
  return (
    <p className="mt-4 text-center text-brand-meta text-brand-ink-3">
      {t('termsAgree')}{' '}
      <button type="button" onClick={onOpen} className={BRAND_LINK}>
        {t('termsRead')}
      </button>
    </p>
  );
}
