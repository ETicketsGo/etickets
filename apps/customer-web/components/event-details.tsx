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
  Tag,
  UserCheck,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  showDurationMinutes,
  splitMinutes,
  termsList,
  type EventArtist,
  type PublicEvent,
} from '@eticketsgo/web-kit';
import { Link } from '@/i18n/navigation';
import { useFormat } from '@/lib/format';
import { Button, Card, Dialog } from '@/components/ui';

/**
 * The event details buyers check before they pay, asked for by the owner after a BookMyShow
 * event page: who is running it and who is on stage, the age limit, how long it runs, and the
 * organizer's terms. Each block renders nothing when the organizer has said nothing - an empty
 * "Artists" heading or "Age limit: none" would be a claim the organizer never made.
 */

type Session = PublicEvent['sessions'][number];

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
 * The key facts, at the top of the booking card, where the decision is made.
 *
 * Duration is the SELECTED show's, read from its own start and end - never a separate number
 * that could disagree with the ticket. With several dates and none chosen yet, the date line is
 * the range the run covers.
 */
export function EventFacts({
  event,
  session,
  zone,
  standalone = false,
}: {
  event: PublicEvent;
  session: Session | undefined;
  zone: string | undefined;
  /** In a card of its own, with no rule underneath separating it from the tickets. */
  standalone?: boolean;
}) {
  const t = useTranslations('storefront.event');
  const { dateOnly, dateTime } = useFormat();
  const duration = useDurationText();
  const sessions = event.sessions;
  const minutes = session ? showDurationMinutes(session.startsAt, session.endsAt) : null;

  const when = session
    ? dateTime(session.startsAt, undefined, zone)
    : sessions.length > 1
      ? t('dateRange', {
          from: dateOnly(sessions[0].startsAt, undefined, zone),
          to: dateOnly(sessions[sessions.length - 1].startsAt, undefined, zone),
        })
      : sessions[0]
        ? dateTime(sessions[0].startsAt, undefined, zone)
        : null;

  const rows = [
    when ? { icon: CalendarDays, text: when } : null,
    minutes ? { icon: Hourglass, text: duration(minutes) } : null,
    event.ageLimit ? { icon: UserCheck, text: t('ageLimit', { age: event.ageLimit }) } : null,
    { icon: Tag, text: event.category },
    { icon: MapPin, text: `${event.venue.name}, ${event.venue.city}` },
  ].filter((row): row is { icon: typeof MapPin; text: string } => row !== null);

  return (
    <ul
      className={`space-y-2.5 text-[0.9375rem] text-text-secondary ${
        standalone ? '' : 'mb-5 border-b border-border pb-5'
      }`}
    >
      {rows.map(({ icon: Icon, text }) => (
        <li key={text} className="flex items-start gap-2.5">
          <Icon className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" aria-hidden />
          <span>{text}</span>
        </li>
      ))}
    </ul>
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
    <Card title={t('artistsHeading')}>
      <ul className="grid gap-4 sm:grid-cols-2">
        {artists.map((artist, index) => (
          <li key={`${artist.name}-${index}`} className="flex items-start gap-3">
            <span
              aria-hidden
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-tint-primary text-sm font-semibold text-action-primary"
            >
              {initials(artist.name)}
            </span>
            <div className="min-w-0">
              <p className="font-medium text-text-primary">{artist.name}</p>
              {artist.role ? <p className="text-caption text-text-muted">{artist.role}</p> : null}
              {artist.bio ? (
                <p className="mt-1 text-[0.9375rem] text-text-secondary">{artist.bio}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </Card>
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
  const logo = webLink(organizer.logoUrl);
  const website = webLink(organizer.website);
  const instagram = webLink(organizer.instagramUrl);
  return (
    <Card title={t('organizerHeading')}>
      <Link href={`/organizers/${organizer.id}`} className="group flex items-center gap-3">
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logo}
            alt=""
            className="h-10 w-10 shrink-0 rounded-full border border-border bg-white object-cover"
          />
        ) : (
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-tint-primary font-semibold text-action-primary">
            {organizer.name.charAt(0)}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1 font-medium text-text-primary group-hover:text-action-primary">
            <span className="truncate">{organizer.name}</span>
            {organizer.verified ? (
              <BadgeCheck
                className="h-4 w-4 shrink-0 text-action-primary"
                aria-label={t('organizerVerified')}
              />
            ) : null}
          </p>
          <p className="text-caption text-text-muted">
            {organizer.verified ? t('organizerVerified') : t('viewProfile')}
          </p>
        </div>
        <ChevronRight className="h-4 w-4 text-text-muted transition-transform group-hover:translate-x-0.5" />
      </Link>
      {organizer.description ? (
        <p className="mt-3 line-clamp-3 text-[0.9375rem] text-text-secondary">
          {organizer.description}
        </p>
      ) : null}
      {website || instagram ? (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[0.9375rem]">
          {website ? (
            <a
              href={website}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="inline-flex items-center gap-1.5 text-action-primary hover:underline"
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
              className="inline-flex items-center gap-1.5 text-action-primary hover:underline"
            >
              <Instagram className="h-4 w-4" aria-hidden /> {t('organizerInstagram')}
              <span className="sr-only">{t('opensInNewTab')}</span>
            </a>
          ) : null}
        </div>
      ) : null}
    </Card>
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

/** The row on the page that opens the terms. */
export function TermsRow({ onOpen }: { onOpen: () => void }) {
  const t = useTranslations('storefront.event');
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-lg border border-border bg-background-surface px-4 py-3.5 text-left shadow-sm transition-colors hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <FileText className="h-5 w-5 shrink-0 text-text-muted" aria-hidden />
      <span className="flex-1 font-semibold text-text-primary">{t('termsHeading')}</span>
      <ChevronRight className="h-4 w-4 text-text-muted" aria-hidden />
    </button>
  );
}

/** The line under the pay button, so agreeing to the terms is never a surprise. */
export function TermsAgreeNote({ onOpen }: { onOpen: () => void }) {
  const t = useTranslations('storefront.event');
  return (
    <p className="mt-3 text-center text-caption text-text-muted">
      {t('termsAgree')}{' '}
      <button
        type="button"
        onClick={onOpen}
        className="font-medium text-action-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {t('termsRead')}
      </button>
    </p>
  );
}
