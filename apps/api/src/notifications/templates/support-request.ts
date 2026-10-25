import { t, type Locale } from '@eticketsgo/i18n';

/**
 * How a support-form message reads in the support mailbox, as text and as facts.
 *
 * Shared by the template service (the plain-text part, which also feeds the in-app list and
 * the logs) and the email view (the HTML part), so the two cannot disagree about what the
 * support team is told. Pure functions of the stored payload: what the sender wrote was
 * copied into the payload when the message was queued, and nothing here reads the database.
 */
type Payload = Record<string, unknown>;

/**
 * The most of a message the mailbox copy carries.
 *
 * The form takes 4000 characters. A mail is not where a long message is best read, and a cap
 * means the size of what we send in our own name is ours to decide, not a stranger's. The full
 * text is always in the admin console, and the mail says so when it was shortened.
 */
export const SUPPORT_MESSAGE_EMAIL_MAX = 3000;

function text(p: Payload, key: string): string {
  const v = p[key];
  return typeof v === 'string' ? v.trim() : '';
}

function capitalised(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** "contact", "complaint", "bug report" - the kind in words, never the enum. */
export function supportKindWord(locale: Locale, p: Payload): string {
  const kind = text(p, 'kind');
  const word = t(locale, `emails.SUPPORT_REQUEST_RECEIVED.kinds.${kind}`);
  // An unknown kind reads as "contact" rather than as a catalogue path.
  return word.startsWith('emails.')
    ? t(locale, 'emails.SUPPORT_REQUEST_RECEIVED.kinds.CONTACT')
    : word;
}

/** Who wrote: their name, else their address, else "someone". */
export function supportSender(locale: Locale, p: Payload): string {
  return (
    text(p, 'senderName') ||
    text(p, 'replyTo') ||
    t(locale, 'emails.SUPPORT_REQUEST_RECEIVED.unnamed')
  );
}

/** The message as the mailbox shows it: capped, and whether it had to be. */
export function supportMessage(p: Payload): { message: string; truncated: boolean } {
  const raw = text(p, 'message');
  const cut = raw.length > SUPPORT_MESSAGE_EMAIL_MAX;
  return {
    message: cut ? `${raw.slice(0, SUPPORT_MESSAGE_EMAIL_MAX).trimEnd()} [...]` : raw,
    truncated: cut || p['truncated'] === true,
  };
}

/** The facts the support team needs to triage and answer, in the order they read them. */
export function supportRequestRows(locale: Locale, p: Payload): { label: string; value: string }[] {
  const label = (key: string) => t(locale, `emails.SUPPORT_REQUEST_RECEIVED.labels.${key}`);
  const account = text(p, 'accountEmail');
  const rows = [
    { label: label('kind'), value: capitalised(supportKindWord(locale, p)) },
    { label: label('from'), value: text(p, 'senderName') },
    { label: label('email'), value: text(p, 'replyTo') },
    {
      label: label('account'),
      value: account || t(locale, 'emails.SUPPORT_REQUEST_RECEIVED.notSignedIn'),
    },
    { label: label('organization'), value: text(p, 'organizationName') },
    { label: label('booking'), value: text(p, 'bookingReference') },
    { label: label('subject'), value: text(p, 'topic') },
    { label: label('reference'), value: text(p, 'reference') },
  ];
  return rows.filter((row) => row.value !== '');
}

/** The sentence under the heading: how to answer, or that a reply cannot reach them. */
export function supportReplyLine(locale: Locale, p: Payload): string {
  const replyTo = text(p, 'replyTo');
  return replyTo
    ? t(locale, 'emails.SUPPORT_REQUEST_RECEIVED.replyHint', { email: replyTo })
    : t(locale, 'emails.SUPPORT_REQUEST_RECEIVED.noReplyAddress');
}

/** Subject and plain-text body of the mailbox copy. */
export function supportRequestText(locale: Locale, p: Payload): { subject: string; body: string } {
  const kind = supportKindWord(locale, p);
  const sender = supportSender(locale, p);
  const topic = text(p, 'topic');
  const { message, truncated } = supportMessage(p);
  const link = text(p, 'link');
  // The readable reference (ETG-SUP-...), in the subject so the mailbox can be searched by it.
  const reference = text(p, 'reference');

  const facts = supportRequestRows(locale, p)
    .map((row) => `${row.label}: ${row.value}`)
    .join('\n');
  const body = [
    t(locale, 'emails.SUPPORT_REQUEST_RECEIVED.intro', { kind, sender }),
    supportReplyLine(locale, p),
    facts,
    message,
    truncated ? t(locale, 'emails.SUPPORT_REQUEST_RECEIVED.truncated') : '',
    link ? t(locale, 'emails.SUPPORT_REQUEST_RECEIVED.adminLink', { link }) : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  /*
    A subject is one line. The topic is the sender's own words, and a line break in it would
    be the only way a stranger could shape a header, so every run of whitespace becomes one
    space before it is used.
  */
  const subject = (
    topic
      ? t(locale, 'emails.SUPPORT_REQUEST_RECEIVED.subject', { kind, topic, reference })
      : t(locale, 'emails.SUPPORT_REQUEST_RECEIVED.subjectNoTopic', { kind, sender, reference })
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return { subject, body };
}
