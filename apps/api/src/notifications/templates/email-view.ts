import { NotificationType } from '@eticketsgo/shared-types';
import { DEFAULT_LOCALE, isLocale, t, type Locale } from '@eticketsgo/i18n';
import { messageClassOf } from '../message-class';
import { moneyValue, whenValue } from './notification-template.service';
import { safeHref, type EmailRow, type EmailView } from './email-html';

/**
 * What each email SHOWS, as opposed to what it says.
 *
 * ── WHY THE COPY IS NOT REWRITTEN HERE ─────────────────────────────────────────────
 * The sentence a message makes is already written once, in the shared catalogue, and it has
 * to keep working for SMS, push and the in-app list where there is no layout at all. So this
 * does not write new wording per channel. It takes the sentence the catalogue produced and
 * decides how an EMAIL presents it: which facts deserve their own row, what the one button
 * says, and why the reader is being told they got this.
 *
 * ── THE LINK MOVES OUT OF THE SENTENCE ─────────────────────────────────────────────
 * A plain-text message has to carry its link inline ("Open your tickets: https://..."), and
 * in an HTML mail that reads as a wall of URL in the middle of a paragraph. The URL is lifted
 * out into the button, and the paragraph keeps the words. The address is still printed under
 * the button, so nothing is hidden from a reader who wants to see where it goes.
 */
type Payload = Record<string, unknown>;

/** A payload field as trimmed text, or '' when it is absent. */
function field(p: Payload, key: string): string {
  const value = p[key];
  return value === undefined || value === null ? '' : String(value).trim();
}

/**
 * A message shows EITHER a sentence OR a lead and a panel of facts. Never both.
 *
 * The catalogue sentence is written for SMS and the in-app list, where there is no panel, so
 * it names every fact itself. Printing it above a panel that repeats those facts is how the
 * first draft of this layout read: "2 tickets confirmed for X on 29 Sept, 9:00 pm. Seats A1,
 * A2. Booking reference ETG-..." followed immediately by Event / When / Seats / Booking
 * reference.
 *
 * So the panel is for the messages that are mostly FACTS - a confirmation, a reminder - and
 * their sentence is replaced by a short lead. Every other message keeps its sentence, because
 * it carries something no panel can: why a payment failed, that a refund is coming, that the
 * organizer has not decided yet. Repeating a fact is untidy; dropping one of those is a worse
 * mail.
 *
 * Two of them must also show LESS than they know:
 *
 *  - GUEST_BOOKING_ACCESS goes to an address somebody typed at a "find my booking" form.
 *    Nothing has proved they are the buyer yet, so naming the show would tell whoever reads
 *    that inbox what was bought. The catalogue copy already refuses to; so does this.
 *  - The password messages carry no booking facts at all. A row of unrelated detail in a
 *    security mail is noise where somebody is deciding whether the mail is genuine.
 */
const ROW_FIELDS: Partial<Record<NotificationType, readonly string[]>> = {
  [NotificationType.BOOKING_CONFIRMED]: ['eventTitle', 'when', 'seats', 'reference'],
  [NotificationType.EVENT_REMINDER]: ['eventTitle', 'when', 'seats', 'reference'],
};

/**
 * What the one button says.
 *
 * One button, never two. A message with two equal actions has no primary action, and the
 * reader has to work out which one they came for.
 */
const CTA_KEY: Partial<Record<NotificationType, string>> = {
  [NotificationType.BOOKING_CONFIRMED]: 'viewTickets',
  [NotificationType.GUEST_BOOKING_ACCESS]: 'viewTickets',
  [NotificationType.EVENT_REMINDER]: 'viewTickets',
  [NotificationType.TICKET_TRANSFERRED]: 'viewTickets',
  [NotificationType.PASSWORD_RESET_REQUESTED]: 'resetPassword',
  [NotificationType.PAYMENT_FAILED]: 'completePayment',
  [NotificationType.SHOW_CHANGED]: 'viewBooking',
  [NotificationType.SHOW_CANCELLED]: 'viewBooking',
  [NotificationType.BOOKING_CANCELLED]: 'viewBooking',
  [NotificationType.REFUND_REQUESTED]: 'viewBooking',
  [NotificationType.REFUND_COMPLETED]: 'viewBooking',
  [NotificationType.TICKET_CHECKED_IN]: 'viewBooking',
  [NotificationType.ORGANIZATION_REGISTERED]: 'openConsole',
  [NotificationType.ORGANIZATION_APPROVED]: 'openConsole',
  [NotificationType.ORGANIZATION_REJECTED]: 'openConsole',
  [NotificationType.EVENT_SUBMITTED]: 'openConsole',
  [NotificationType.EVENT_APPROVED]: 'openConsole',
  [NotificationType.EVENT_REJECTED]: 'openConsole',
  [NotificationType.EVENT_NOT_SELLABLE]: 'openConsole',
  [NotificationType.ATTENDEE_INVITED]: 'openInvitation',
};

/** Any http(s) URL in the sentence. The first is the one the message is about. */
const URL_PATTERN = /https?:\/\/[^\s<>"')]+/g;

/**
 * The sentence with its URLs taken out, tidied back into something that reads.
 *
 * Removing a URL leaves the punctuation around it: "Open your tickets: " with nothing after
 * the colon, or a double space where it sat mid-sentence. Both look like a broken template
 * to a reader, which is exactly the impression a transactional mail cannot afford.
 */
function withoutUrls(body: string): string {
  return body
    .replace(URL_PATTERN, '')
    .replace(/[ \t]*[:\-–—][ \t]*(?=(\.|$|\n))/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,!?])/g, '$1')
    .trim();
}

/** The row values a payload can actually supply, already formatted for the reader. */
function rowValue(locale: Locale, p: Payload, key: string): string {
  switch (key) {
    case 'when':
      return whenValue(locale, p);
    case 'amount':
      return p.amountMinor === undefined || p.amountMinor === null
        ? ''
        : moneyValue(locale, p, 'amountMinor');
    default:
      return field(p, key);
  }
}

/**
 * One message, ready to render.
 *
 * `siteUrl` is where "need help" points. It is passed in rather than read from config here so
 * that this stays a pure function - the thing that has to be true of every template renderer
 * if its output is to be testable without standing up an application.
 */
export function buildEmailView(input: {
  type: NotificationType;
  locale: string;
  subject: string;
  body: string;
  payload: Payload;
  /** The storefront's origin, for the help link in the footer. Null leaves it out. */
  helpUrl?: string | null;
}): EmailView {
  const locale: Locale = isLocale(input.locale) ? input.locale : DEFAULT_LOCALE;
  const payload = input.payload ?? {};
  const text = withoutUrls(input.body);

  /*
    The link the message is about. `payload.link` is what producers set, and the sentence is
    the fallback for a row queued before a producer started setting it. Both go through the
    same http(s) check: by this point `link-safety` has already dropped anything that is not
    on a host this deployment owns, and this is the second lock on that door.
  */
  const linkFromBody = input.body.match(URL_PATTERN)?.[0] ?? '';
  const href = safeHref(field(payload, 'link') || field(payload, 'url') || linkFromBody);
  const ctaKey = CTA_KEY[input.type] ?? 'openLink';
  // A panel type is a lead type: the panel is what replaces the sentence.
  const lead = ROW_FIELDS[input.type] ? t(locale, `emails.leads.${input.type}`) : null;

  const rows: EmailRow[] = (ROW_FIELDS[input.type] ?? [])
    .map((key) => ({
      label: t(locale, `emails.labels.${key}`),
      value: rowValue(locale, payload, key),
    }))
    .filter((row) => row.value !== '');

  return {
    locale,
    subject: input.subject,
    /*
      The inbox preview: the one line somebody reads before deciding whether to open anything.
      Never the subject again - the subject is already on the line above it. For a panel
      message it is the lead plus the facts that identify the booking, which is how somebody
      finds the right mail in a list of five confirmations.
    */
    preheader: [lead ?? text, ...rows.slice(0, 2).map((row) => row.value)]
      .filter(Boolean)
      .join(' - ')
      .slice(0, 160),
    heading: input.subject,
    paragraphs: lead ? [lead] : text ? [text] : [],
    rows,
    cta: href ? { label: t(locale, `emails.cta.${ctaKey}`), url: href } : null,
    footerNote: t(
      locale,
      messageClassOf(input.type) === 'MARKETING'
        ? 'emails.layout.whyMarketing'
        : 'emails.layout.whyTransactional',
    ),
    help: input.helpUrl
      ? {
          prompt: t(locale, 'emails.layout.helpPrompt'),
          label: t(locale, 'emails.layout.helpLabel'),
          url: input.helpUrl,
        }
      : null,
    legal: t(locale, 'emails.layout.legal', { year: new Date().getFullYear() }),
  };
}
