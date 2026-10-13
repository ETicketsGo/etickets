'use client';

import { useState } from 'react';
import {
  BadgeCheck,
  CalendarDays,
  ChevronRight,
  FileText,
  Globe,
  Hourglass,
  Instagram,
  MapPin,
  UserCheck,
} from 'lucide-react';
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
import { Button, Dialog } from '@/components/ui';
import { BRAND_EYEBROW, BRAND_LINK, BRAND_PANEL } from '@/components/booking-brand';

/**
 * The event details buyers check before they pay, asked for by the owner after a BookMyShow
 * event page: who is running it and who is on stage, the age limit, how long it runs, and the
 * organizer's terms. Each block renders nothing when the organizer has said nothing - an empty
 * "Artists" heading or "Age limit: none" would be a claim the organizer never made.
 */

/** "1 hour 30 minutes", in the reader's language. */
function useDurationText() {
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

/**
 * The key facts, as a row of labelled figures under the hero.
 *
 * Duration is the SELECTED show's, read from its own start and end - never a separate number
 * that could disagree with the ticket. The date is the venue's clock with its zone named, and a
 * short note says so once, here, rather than on every line that prints a time.
 */
export function EventFacts({
  event,
  when,
  minutes,
  note,
}: {
  event: PublicEvent;
  /** The shown date in the venue's clock, from `useVenueWhen`. */
  when: { day: string; time: string; zone: string } | null;
  minutes: number | null;
  /** "Times are at the venue, in its time zone." */
  note: string;
}) {
  const t = useTranslations('storefront.event');
  const duration = useDurationText();
  const facts = [
    when
      ? {
          icon: CalendarDays,
          label: t('dateLabel'),
          value: `${when.day}, ${when.time}${when.zone ? ` ${when.zone}` : ''}`,
        }
      : null,
    minutes ? { icon: Hourglass, label: t('durationLabel'), value: duration(minutes) } : null,
    event.ageLimit
      ? { icon: UserCheck, label: t('ageLabel'), value: t('ageLimit', { age: event.ageLimit }) }
      : null,
    { icon: MapPin, label: t('venueHeading'), value: `${event.venue.name}, ${event.venue.city}` },
  ].filter((fact): fact is { icon: typeof MapPin; label: string; value: string } => fact !== null);

  return (
    <div>
      <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
        {facts.map(({ icon: Icon, label, value }) => (
          // dt and dd are the group's only children (a valid definition list); the icon rides
          // inside the term, positioned into the gutter.
          <div key={label} className="relative min-w-0 pl-8">
            <dt className="text-brand-eyebrow uppercase text-brand-ink-3">
              <Icon className="absolute left-0 top-0.5 h-5 w-5 text-brand-ink-3" aria-hidden />
              {label}
            </dt>
            <dd className="mt-1 text-brand-ui font-medium text-brand-ink">{value}</dd>
          </div>
        ))}
      </dl>
      {when?.zone ? <p className="mt-4 text-brand-meta text-brand-ink-3">{note}</p> : null}
    </div>
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
    <section aria-labelledby="organizer-heading" className={`${BRAND_PANEL} p-6`}>
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
      <p className="text-caption text-text-muted">
        {t('termsSetBy', { organizer: event?.organizer.name ?? '' })}
      </p>
      <ol className="mt-3 list-decimal space-y-2 pl-5 text-[0.9375rem] text-text-secondary">
        {terms.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ol>
      <div className="mt-5 flex justify-end">
        <Button variant="secondary" onClick={() => setOpen(false)}>
          {tx('action.close')}
        </Button>
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
