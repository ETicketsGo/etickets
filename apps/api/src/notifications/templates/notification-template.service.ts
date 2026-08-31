import { Injectable } from '@nestjs/common';
import { NotificationType } from '@eticketsgo/shared-types';
import { DEFAULT_LOCALE, isLocale, t, type Locale } from '@eticketsgo/i18n';

/** The rendered pieces of a notification message. */
export interface RenderedTemplate {
  subject: string;
  body: string;
}

/**
 * Transactional email and in-app notifications, in the reader's language.
 *
 * ── WHY THE COPY MOVED OUT OF THIS FILE ────────────────────────────────────────────
 * It used to be a table of English string literals with `TEMPLATES: Record<string, …>` and a
 * comment reading "add locales here as they land". Adding French that way would have meant a
 * second table of literals maintained beside the first, diverging the first time somebody
 * fixed a wording in one — and the same problem again for receipts, which the Charter of the
 * French Language covers alongside email.
 *
 * The copy now lives in `@eticketsgo/i18n`, which the storefront also reads. One catalogue,
 * one place a wording is fixed, and a test that fails the build when a locale is missing a
 * key rather than letting it silently fall back to English in somebody's inbox.
 *
 * What stays here is the part that is logic rather than words: which payload fields a given
 * notification needs, how money and dates are formatted for a locale, and how to compose a
 * sentence out of pieces that may be absent.
 */
type Payload = Record<string, unknown>;

/**
 * Which regional conventions to format numbers and dates with.
 *
 * ── WHY THIS IS NOT JUST THE LOCALE ────────────────────────────────────────────────
 * `en` on its own resolves to US conventions in `Intl`, so switching the formatter from the
 * hardcoded `en-IN` to the message locale would quietly have turned "25 Aug 2026" into
 * "Aug 25, 2026" for every customer in the platform's actual market. Adding French must not
 * change what an English-reading customer in Chennai sees, so the mapping is written down
 * instead of falling out of a default nobody chose.
 *
 * `fr-CA` needs no mapping: Canadian French conventions are exactly what a Quebec reader
 * expects, down to `123,45 $` with the sign trailing.
 */
const FORMAT_LOCALE: Record<Locale, string> = {
  en: 'en-IN',
  'fr-CA': 'fr-CA',
};

/** Reads a payload field as a printable string, with a fallback. */
function str(p: Payload, key: string, fallback = ''): string {
  const v = p[key];
  return v === undefined || v === null ? fallback : String(v);
}

/**
 * A booking as a human refers to it.
 *
 * Prefers the public reference (`ETG-IND-2026-000123`) — the string printed on the receipt
 * and the one somebody can read down a phone to support. Falls back to the database id only
 * when no reference exists, which is a booking that was never confirmed.
 */
function bookingName(locale: Locale, p: Payload): string {
  const reference = str(p, 'reference').trim();
  return reference || str(p, 'bookingId', t(locale, 'emails.fragments.yourBooking'));
}

/**
 * Money, as money, in the reader's conventions.
 *
 * The refund notice used to read "A refund of 31600 (minor units)". Minor units are how the
 * platform stores money so it never rounds; they are not how anyone reads it. `Intl` also
 * knows which currencies have no decimal place, which a hand-rolled divide-by-100 does not —
 * and it knows that Canadian French writes `123,45 $` with the symbol trailing, which is the
 * kind of detail that makes a receipt look translated rather than written.
 */
function money(locale: Locale, p: Payload, key: string, currencyKey = 'currency'): string {
  const minor = Number(str(p, key, '0')) || 0;
  const currency = str(p, currencyKey, 'INR') || 'INR';
  try {
    const fmt = new Intl.NumberFormat(FORMAT_LOCALE[locale], { style: 'currency', currency });
    const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
    return fmt.format(minor / 10 ** digits);
  } catch {
    return `${currency} ${(minor / 100).toFixed(2)}`;
  }
}

/**
 * " on 25 Aug 2026, 9:28 pm (IST)" — empty when the payload carries no start time.
 *
 * ── WHICH CLOCK ────────────────────────────────────────────────────────────────────
 * Reported from QA: the ticket said 9:28 pm and the notification said 8:58 am the next
 * day. Both were rendering the same instant — the pages render in the READER'S browser
 * zone, and this template had `Asia/Kolkata` hardcoded. Eleven and a half hours apart, and
 * neither number was wrong on its own terms.
 *
 * A showtime is not a fact about the reader. "The film starts at 9:28 pm" means 9:28 pm at
 * the venue, whoever is reading and wherever they are. So the venue's own timezone is what
 * gets quoted, and it is NAMED — an unlabelled time is exactly the ambiguity that produced
 * this report.
 *
 * The LANGUAGE of the rendering follows the reader even though the CLOCK does not: a French
 * reader wants "25 août" for a show in Mumbai. Those are different questions and conflating
 * them is what caused the original bug.
 *
 * With no timezone on the payload it falls back to UTC and says so, rather than silently
 * picking the server's zone, which would make the output depend on where it happens to run.
 */
function whenClause(locale: Locale, p: Payload): string {
  const raw = str(p, 'startsAt').trim();
  if (!raw) return '';
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return '';
  const timeZone = str(p, 'timeZone').trim() || 'UTC';
  const opts: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  };
  let when: string;
  let zone: string;
  try {
    when = at.toLocaleString(FORMAT_LOCALE[locale], opts);
    zone =
      new Intl.DateTimeFormat(FORMAT_LOCALE[locale], { timeZone, timeZoneName: 'short' })
        .formatToParts(at)
        .find((part) => part.type === 'timeZoneName')?.value ?? timeZone;
  } catch {
    // An unresolvable zone must not cost the customer their confirmation.
    when = at.toLocaleString(FORMAT_LOCALE[locale], { ...opts, timeZone: 'UTC' });
    zone = 'UTC';
  }
  return t(locale, 'emails.fragments.when', { when: `${when} (${zone})` });
}

/** A fragment, or nothing at all when the payload has no value for it. */
function optional(locale: Locale, key: string, values: Record<string, unknown>): string {
  const only = Object.values(values)[0];
  return only === undefined || only === null || String(only).trim() === ''
    ? ''
    : t(locale, `emails.fragments.${key}`, values);
}

type Builder = (locale: Locale, p: Payload) => RenderedTemplate;

/**
 * How each notification composes itself from the catalogue.
 *
 * Every piece is omitted rather than printed empty when the payload lacks it, so an older
 * queued notification still renders as a sentence instead of one with holes in it.
 */
const BUILDERS: Partial<Record<NotificationType, Builder>> = {
  [NotificationType.BOOKING_CONFIRMED]: (l, p) => {
    const tickets = Number(str(p, 'tickets', '0')) || 0;
    const event = str(p, 'eventTitle').trim();
    const seats = str(p, 'seats').trim();
    return {
      subject: event
        ? t(l, 'emails.BOOKING_CONFIRMED.subjectWithEvent', { event })
        : t(l, 'emails.BOOKING_CONFIRMED.subject'),
      body: t(l, 'emails.BOOKING_CONFIRMED.body', {
        count: t(l, 'emails.fragments.ticketCount', { count: tickets }),
        forEvent: optional(l, 'forEvent', { event }),
        when: whenClause(l, p),
        seats: optional(l, 'seats', { seats }),
        reference: bookingName(l, p),
      }),
    };
  },

  /*
    Account security. The link is a live credential, so it appears in the BODY and nowhere
    else — not in the subject, which shows in notification previews on a locked screen.
  */
  [NotificationType.PASSWORD_RESET_REQUESTED]: (l, p) => ({
    subject: t(l, 'emails.PASSWORD_RESET_REQUESTED.subject'),
    body: t(l, 'emails.PASSWORD_RESET_REQUESTED.body', {
      link: str(p, 'link'),
      minutes: str(p, 'minutes'),
    }),
  }),

  [NotificationType.PASSWORD_CHANGED]: (l) => ({
    subject: t(l, 'emails.PASSWORD_CHANGED.subject'),
    body: t(l, 'emails.PASSWORD_CHANGED.body'),
  }),

  [NotificationType.PAYMENT_FAILED]: (l, p) => ({
    subject: t(l, 'emails.PAYMENT_FAILED.subject'),
    body: t(l, 'emails.PAYMENT_FAILED.body', { reference: bookingName(l, p) }),
  }),

  [NotificationType.EVENT_REMINDER]: (l, p) => ({
    subject: t(l, 'emails.EVENT_REMINDER.subject'),
    body: t(l, 'emails.EVENT_REMINDER.body', {
      event: str(p, 'eventName', t(l, 'emails.fragments.yourEvent')),
      startingAt: optional(l, 'startingAt', { startsAt: str(p, 'startsAt') }),
    }),
  }),

  [NotificationType.BOOKING_CANCELLED]: (l, p) => ({
    subject: t(l, 'emails.BOOKING_CANCELLED.subject'),
    body: t(l, 'emails.BOOKING_CANCELLED.body', { reference: bookingName(l, p) }),
  }),

  [NotificationType.REFUND_COMPLETED]: (l, p) => ({
    subject: t(l, 'emails.REFUND_COMPLETED.subject'),
    body: t(l, 'emails.REFUND_COMPLETED.body', {
      amount: money(l, p, 'amountMinor'),
      reference: bookingName(l, p),
    }),
  }),

  [NotificationType.TICKET_CHECKED_IN]: (l, p) => ({
    subject: t(l, 'emails.TICKET_CHECKED_IN.subject'),
    body: t(l, 'emails.TICKET_CHECKED_IN.body', {
      serial: str(p, 'serial', str(p, 'ticketId', '')),
    }),
  }),

  [NotificationType.ATTENDEE_INVITED]: (l, p) => ({
    subject: t(l, 'emails.ATTENDEE_INVITED.subject'),
    body: t(l, 'emails.ATTENDEE_INVITED.body', {
      ref: optional(l, 'ref', { ref: str(p, 'ref') }),
    }),
  }),

  [NotificationType.ATTENDEE_ACCEPTED]: (l, p) => ({
    subject: t(l, 'emails.ATTENDEE_ACCEPTED.subject'),
    body: t(l, 'emails.ATTENDEE_ACCEPTED.body', {
      attendee: str(p, 'attendee', t(l, 'emails.fragments.theAttendee')),
    }),
  }),

  [NotificationType.ATTENDEE_DECLINED]: (l, p) => ({
    subject: t(l, 'emails.ATTENDEE_DECLINED.subject'),
    body: t(l, 'emails.ATTENDEE_DECLINED.body', { ticketId: str(p, 'ticketId', '') }),
  }),

  [NotificationType.TICKET_TRANSFERRED]: (l, p) => ({
    subject: t(l, 'emails.TICKET_TRANSFERRED.subject'),
    body: t(l, 'emails.TICKET_TRANSFERRED.body', { ticketId: str(p, 'ticketId', '') }),
  }),

  [NotificationType.SHARE_CREATED]: (l, p) => ({
    subject: t(l, 'emails.SHARE_CREATED.subject'),
    body: t(l, 'emails.SHARE_CREATED.body', {
      permission: str(p, 'permission', 'view'),
      url: str(p, 'url', ''),
    }),
  }),

  [NotificationType.SHARE_VIEWED]: (l, p) => ({
    subject: t(l, 'emails.SHARE_VIEWED.subject'),
    body: t(l, 'emails.SHARE_VIEWED.body', { ticketId: str(p, 'ticketId', '') }),
  }),

  [NotificationType.SHARE_REVOKED]: (l, p) => ({
    subject: t(l, 'emails.SHARE_REVOKED.subject'),
    body: t(l, 'emails.SHARE_REVOKED.body', { ticketId: str(p, 'ticketId', '') }),
  }),

  /*
    Onboarding and approval.

    Every one of these names the thing waiting and who it is waiting on. Without a template
    the generic fallback renders the type alone — technically a notification, and useless as
    an email to a person deciding whether a business may sell tickets.
  */
  [NotificationType.ORGANIZATION_REGISTERED]: (l, p) => {
    const organization = str(p, 'organizationName', t(l, 'emails.fragments.anOrganization'));
    return {
      subject: t(l, 'emails.ORGANIZATION_REGISTERED.subject', { organization }),
      body: t(l, 'emails.ORGANIZATION_REGISTERED.body', {
        organization,
        contact: str(p, 'contactEmail', t(l, 'emails.fragments.notProvided')),
      }),
    };
  },

  [NotificationType.ORGANIZATION_APPROVED]: (l, p) => {
    const organization = str(p, 'organizationName', t(l, 'emails.fragments.yourOrganization'));
    return {
      subject: t(l, 'emails.ORGANIZATION_APPROVED.subject', { organization }),
      body: t(l, 'emails.ORGANIZATION_APPROVED.body', { organization }),
    };
  },

  [NotificationType.ORGANIZATION_REJECTED]: (l, p) => {
    const organization = str(p, 'organizationName', t(l, 'emails.fragments.yourOrganization'));
    return {
      subject: t(l, 'emails.ORGANIZATION_REJECTED.subject', { organization }),
      body: t(l, 'emails.ORGANIZATION_REJECTED.body', {
        organization,
        // The reason is the whole value of this message: "rejected" with no cause leaves
        // somebody unable to act, and support answering the same question every time.
        reason: optional(l, 'reason', { reason: str(p, 'reason') }),
      }),
    };
  },

  [NotificationType.EVENT_SUBMITTED]: (l, p) => ({
    subject: t(l, 'emails.EVENT_SUBMITTED.subject', {
      event: str(p, 'eventTitle', t(l, 'emails.fragments.anEvent')),
    }),
    body: t(l, 'emails.EVENT_SUBMITTED.body', {
      organization: str(p, 'organizationName', t(l, 'emails.fragments.anOrganizer')),
      event: str(p, 'eventTitle', t(l, 'emails.fragments.anEvent')),
    }),
  }),

  [NotificationType.EVENT_APPROVED]: (l, p) => {
    const event = str(p, 'eventTitle', t(l, 'emails.fragments.yourEvent'));
    return {
      subject: t(l, 'emails.EVENT_APPROVED.subject', { event }),
      body: t(l, 'emails.EVENT_APPROVED.body', { event }),
    };
  },

  [NotificationType.EVENT_REJECTED]: (l, p) => {
    const event = str(p, 'eventTitle', t(l, 'emails.fragments.yourEvent'));
    return {
      subject: t(l, 'emails.EVENT_REJECTED.subject', { event }),
      body: t(l, 'emails.EVENT_REJECTED.body', {
        event,
        reason: optional(l, 'reason', { reason: str(p, 'reason') }),
      }),
    };
  },
};

@Injectable()
export class NotificationTemplateService {
  render(type: NotificationType, locale: string, payload: Payload): RenderedTemplate {
    /*
      An unknown locale renders in the default rather than throwing.

      This is reached from the scheduled dispatcher reading rows written months earlier, and
      a locale that has since been retired must not stop somebody's booking confirmation.
    */
    const target: Locale = isLocale(locale) ? locale : DEFAULT_LOCALE;
    const build = BUILDERS[type];
    if (build) return build(target, payload);
    /*
      An unmapped type still delivers its data rather than an empty sentence.

      This fires only when a NotificationType has no builder, which is a developer error, not
      a customer situation — and a notification that says "you have a notification" and
      nothing else makes that error invisible in production. The payload is appended so
      whoever receives it, or reads it in the in-app list, can see what it was about.
    */
    return {
      subject: t(target, 'emails.generic.subject', { type }),
      body: `${t(target, 'emails.generic.body', { type })} ${JSON.stringify(payload)}`,
    };
  }
}
