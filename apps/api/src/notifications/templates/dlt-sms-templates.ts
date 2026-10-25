import { NotificationType } from '@eticketsgo/shared-types';

/**
 * The India DLT SMS templates: the exact wording registered on the DLT portal, its variables
 * in order, and the configuration keys that bind each one to an approval.
 *
 * ── WHY THE WORDING LIVES HERE AND NOT IN THE MESSAGE CATALOGUE ────────────────────
 * An Indian operator compares every transactional SMS against the template registered for
 * the sender header, character for character outside the `{#var#}` slots, and drops what does
 * not match. The MSG91 adapter used to send the catalogue's email-style body as ONE variable.
 * DLT does not approve a template that is nothing but a variable, so that shape could never
 * have been registered, and the catalogue body never matched any wording that could be. A
 * message would have been accepted by MSG91 and then dropped at the carrier, with nothing on
 * our side to say so.
 *
 * So this file is the single source of truth for the SMS text in India. The docs page
 * docs/notifications/INDIA-DLT-TEMPLATES.md is the copy the owner pastes into the portal, and
 * a unit test pins the two together. Changing a line here means registering a new template
 * first -- the old approval does not cover new wording.
 *
 * ── WHY TWO IDS PER TEMPLATE ───────────────────────────────────────────────────────
 * The DLT portal issues a 19-digit Content Template ID. MSG91 then issues its OWN template id
 * when that DLT template is added to the MSG91 account, and its flow API takes only MSG91's.
 * Both are required before a kind may send: the DLT id is the evidence that the wording was
 * approved, the MSG91 id is what actually goes on the wire. Neither has a default, and no id
 * appears in this repository: they are granted by an operator and can be revoked by one.
 *
 * ── WHY NOTHING ELSE CAN BE SENT ───────────────────────────────────────────────────
 * A notification type with no entry here is refused by the MSG91 transport, permanently.
 * There is no fallback template and no free-text path: a guess is a message that is accepted
 * by the API and silently dropped by the carrier.
 */

/** The sign-in code. Not a NotificationType: the OTP path sends through the channel directly. */
export const OTP_SMS_KIND = 'ACCOUNT_SECURITY';

export type DltSmsKind =
  | typeof OTP_SMS_KIND
  | typeof NotificationType.BOOKING_CONFIRMED
  | typeof NotificationType.BOOKING_CANCELLED
  | typeof NotificationType.REFUND_COMPLETED
  | typeof NotificationType.SHOW_CANCELLED;

/** TRAI's own limit on one `{#var#}`. A longer value is rejected or cut by the operator. */
export const DLT_VARIABLE_MAX_LENGTH = 30;

/** A DLT id (template, header or Principal Entity), as the portal issues it: 19 digits. */
export const DLT_ID_PATTERN = /^\d{19}$/;

/** The placeholder DLT uses in a registered template. */
export const DLT_VARIABLE = '{#var#}';

/**
 * The headers registered for DeepTrics Software Solutions Private Limited and APPROVED.
 *
 * ETKTGO: approved, with the PE-TM chain and eight templates (owner statement, 2026-10-25).
 * An earlier record said the portal had rejected it; the owner's statement supersedes that.
 * DPTRCS: approved earlier and still accepted.
 *
 * Recorded for the docs and the readiness report only. Neither is a default: the header that
 * goes on the wire comes from DLT_SENDER_HEADER / MSG91_SENDER_ID, so a change of header is a
 * configuration change and never a build. The templates must be linked to the SAME header
 * that is configured, or the operator drops every message.
 */
export const DOCUMENTED_APPROVED_SENDER_HEADERS: readonly string[] = ['ETKTGO', 'DPTRCS'];

/**
 * Headers the DLT portal REJECTED for this entity. Empty today.
 *
 * Kept as a mechanism: if the portal ever rejects or withdraws a header, add it here. The boot
 * check, the MSG91 transport and readiness then refuse it by name, so the mistake costs one
 * deploy log line instead of a launch day of messages the carrier silently drops.
 * (ETKTGO was listed here until the owner confirmed its approval on 2026-10-25.)
 */
export const REJECTED_SENDER_HEADERS: readonly string[] = [];

export interface DltSmsTemplate {
  kind: DltSmsKind;
  /** Human name, for the docs and the readiness report. */
  label: string;
  /** DLT content category. Every one of these is Service Implicit; none is promotional. */
  category: 'SERVICE_IMPLICIT';
  /** The exact registered wording, with `{#var#}` for each variable. ASCII only. */
  text: string;
  /**
   * The MSG91 variable names, in the order their `{#var#}` appears in `text`.
   *
   * In the MSG91 template the owner writes `##name##` where DLT has `{#var#}`, and the flow
   * API fills each `##name##` from the recipient object. Order matters only for the render
   * check below; the names are what MSG91 matches on.
   */
  variables: readonly string[];
  /** Env var holding MSG91's own template id for this kind. */
  msg91TemplateIdEnv: string;
  /** Env var holding the 19-digit DLT Content Template ID for this kind. */
  dltTemplateIdEnv: string;
}

export const DLT_SMS_TEMPLATES: Readonly<Record<DltSmsKind, DltSmsTemplate>> = {
  /*
    Word for word the default in PhoneOtpService, so a deployment that leaves OTP_SMS_TEMPLATE
    unset sends the registered text. The minutes are a variable because the lifetime is a
    constant in the auth code, and a number written into the approval would silently go stale
    the day somebody changed it.
  */
  [OTP_SMS_KIND]: {
    kind: OTP_SMS_KIND,
    label: 'Sign-in code (OTP)',
    category: 'SERVICE_IMPLICIT',
    text: '{#var#} is your ETicketsGo sign-in code. It expires in {#var#} minutes. Never share it with anyone.',
    variables: ['otp', 'minutes'],
    msg91TemplateIdEnv: 'MSG91_SMS_TEMPLATE_OTP',
    dltTemplateIdEnv: 'DLT_TEMPLATE_ID_OTP',
  },
  [NotificationType.BOOKING_CONFIRMED]: {
    kind: NotificationType.BOOKING_CONFIRMED,
    label: 'Booking confirmed',
    category: 'SERVICE_IMPLICIT',
    text: 'ETicketsGo: Booking {#var#} for {#var#} on {#var#} is confirmed. Your tickets are in your email and in your account. - DeepTrics',
    variables: ['reference', 'event', 'when'],
    msg91TemplateIdEnv: 'MSG91_SMS_TEMPLATE_BOOKING_CONFIRMED',
    dltTemplateIdEnv: 'DLT_TEMPLATE_ID_BOOKING_CONFIRMED',
  },
  [NotificationType.BOOKING_CANCELLED]: {
    kind: NotificationType.BOOKING_CANCELLED,
    label: 'Booking cancelled',
    category: 'SERVICE_IMPLICIT',
    text: 'ETicketsGo: Booking {#var#} is cancelled. Check your email for refund details. - DeepTrics',
    variables: ['reference'],
    msg91TemplateIdEnv: 'MSG91_SMS_TEMPLATE_BOOKING_CANCELLED',
    dltTemplateIdEnv: 'DLT_TEMPLATE_ID_BOOKING_CANCELLED',
  },
  [NotificationType.REFUND_COMPLETED]: {
    kind: NotificationType.REFUND_COMPLETED,
    label: 'Refund sent',
    category: 'SERVICE_IMPLICIT',
    text: 'ETicketsGo: We have refunded {#var#} for booking {#var#}. Your bank may take a few working days to show it. - DeepTrics',
    variables: ['amount', 'reference'],
    msg91TemplateIdEnv: 'MSG91_SMS_TEMPLATE_REFUND_COMPLETED',
    dltTemplateIdEnv: 'DLT_TEMPLATE_ID_REFUND_COMPLETED',
  },
  /*
    The one notification policy actually sends by SMS today (as the fallback when nothing else
    reached the buyer), so it is the one India cannot do without once SMS is on.
  */
  [NotificationType.SHOW_CANCELLED]: {
    kind: NotificationType.SHOW_CANCELLED,
    label: 'Show cancelled',
    category: 'SERVICE_IMPLICIT',
    text: 'ETicketsGo: {#var#} on {#var#} is cancelled. Booking {#var#}. Check your email for refund details. - DeepTrics',
    variables: ['event', 'when', 'reference'],
    msg91TemplateIdEnv: 'MSG91_SMS_TEMPLATE_SHOW_CANCELLED',
    dltTemplateIdEnv: 'DLT_TEMPLATE_ID_SHOW_CANCELLED',
  },
};

/** The registered template for a kind, or null when none is registered. */
export function dltTemplateFor(kind: string): DltSmsTemplate | null {
  return (DLT_SMS_TEMPLATES as Record<string, DltSmsTemplate | undefined>)[kind] ?? null;
}

/**
 * Who a show-cancelled message is for, as far as its SMS wording is concerned.
 *
 * ONLINE paid through a provider and gets a refund. CASH paid at the counter and gets the cash
 * back at the venue; no refund follows. ORGANIZER_COPY is the copy of a walk-up buyer's message
 * that goes to the organization, which is never a text to the buyer's phone.
 */
export type DltSmsAudience = 'ONLINE' | 'CASH' | 'ORGANIZER_COPY';

export interface DltSmsReplacement extends DltSmsTemplate {
  /** The registered template this one replaces for its audience, once approved. */
  replaces: DltSmsKind;
  audience: Exclude<DltSmsAudience, 'ORGANIZER_COPY'>;
}

/*
  ── REPLACEMENT WORDING, WAITING FOR DLT APPROVAL ───────────────────────────────────
  The registered SHOW_CANCELLED text ends "Check your email for refund details." That is false
  for a buyer who paid cash at the counter: no refund follows, the cash is given back at the
  venue, and a walk-up often gave no email at all. It is weak for an online buyer too, because
  this SMS is the FALLBACK, sent only when email, push and WhatsApp reached nobody, and a phone
  sign-in account has no real email address to check.

  DLT wording cannot be edited: new wording is a new template with a new id. So each
  replacement below is inert until its own DLT id is set, and until then the registered text
  above stays in use exactly as it is (the owner's rule: keep the approved template until the
  replacement is approved). The registration pack is
  docs/notifications/INDIA-DLT-SHOW-CANCELLED-REPLACEMENT.md, and a test pins it to this text.

  A replacement's MSG91 id is read from its own key only, never from a binding keyed by
  notification type: such a binding names the OLD template, and pairing it with the new
  variables would send wording nobody approved for this reader.
*/
export const DLT_SMS_REPLACEMENTS: readonly DltSmsReplacement[] = [
  {
    kind: NotificationType.SHOW_CANCELLED,
    replaces: NotificationType.SHOW_CANCELLED,
    audience: 'ONLINE',
    label: 'Show cancelled (paid online)',
    category: 'SERVICE_IMPLICIT',
    text: 'ETicketsGo: {#var#} on {#var#} is cancelled. Booking {#var#}. Your refund will go to the account you paid from. - DeepTrics',
    variables: ['event', 'when', 'reference'],
    msg91TemplateIdEnv: 'MSG91_SMS_TEMPLATE_SHOW_CANCELLED_ONLINE',
    dltTemplateIdEnv: 'DLT_TEMPLATE_ID_SHOW_CANCELLED_ONLINE',
  },
  {
    kind: NotificationType.SHOW_CANCELLED,
    replaces: NotificationType.SHOW_CANCELLED,
    audience: 'CASH',
    label: 'Show cancelled (paid in cash)',
    category: 'SERVICE_IMPLICIT',
    text: 'ETicketsGo: {#var#} on {#var#} is cancelled. Booking {#var#}. You paid {#var#} in cash. Show this booking at the venue box office to get your cash back. - DeepTrics',
    variables: ['event', 'when', 'reference', 'amount'],
    msg91TemplateIdEnv: 'MSG91_SMS_TEMPLATE_SHOW_CANCELLED_CASH',
    dltTemplateIdEnv: 'DLT_TEMPLATE_ID_SHOW_CANCELLED_CASH',
  },
];

/**
 * The audience of a message, read from the payload the show-cancellation fan-out builds.
 *
 * Only SHOW_CANCELLED has audiences today; every other kind is ONLINE and keeps its
 * registered template.
 */
export function dltSmsAudience(kind: string, payload: Record<string, unknown>): DltSmsAudience {
  if (kind !== NotificationType.SHOW_CANCELLED) return 'ONLINE';
  const p = payload ?? {};
  if (p['paidInCash'] !== true) return 'ONLINE';
  return p['cashRecipient'] === 'ORGANIZER' ? 'ORGANIZER_COPY' : 'CASH';
}

/** The result of choosing the wording for one SMS. */
export type DltSmsSelection =
  | { template: DltSmsTemplate; replacement: boolean }
  /** No registered wording is true for this reader, so nothing may be sent. */
  | { refused: string };

/**
 * The registered wording to send for one message, or why none may be sent.
 *
 * `setting(key)` reads configuration. A replacement is chosen only when its DLT id is set:
 * that id is the evidence the new wording was approved. Without it:
 *
 * - ONLINE keeps the registered template, unchanged. Its text is true for that reader.
 * - CASH gets NO SMS. The registered text tells a cash buyer to check their email for refund
 *   details, and there is no refund and often no email. A false statement about their money
 *   is worse than no text: the fan-out has already tried email, and a cash buyer who goes to
 *   the venue meets the box office that holds their cash. The refusal is permanent and names
 *   the keys, so it shows in the failure queue rather than as a silent skip.
 * - ORGANIZER_COPY is always refused. It is addressed to the organization, and no SMS wording
 *   is registered for it.
 *
 * Null when the kind has no registered wording at all (the caller already refuses that).
 */
export function selectDltTemplate(
  kind: string,
  payload: Record<string, unknown>,
  setting: (key: string) => string | undefined,
): DltSmsSelection | null {
  const registered = dltTemplateFor(kind);
  if (!registered) return null;
  const audience = dltSmsAudience(kind, payload);
  if (audience === 'ORGANIZER_COPY') {
    return {
      refused:
        `${kind} for a walk-up cash buyer is addressed to the organization. No SMS wording ` +
        `is registered for that copy, so it goes by email only.`,
    };
  }
  const replacement = DLT_SMS_REPLACEMENTS.find(
    (r) => r.replaces === kind && r.audience === audience,
  );
  if (replacement && setting(replacement.dltTemplateIdEnv)?.trim()) {
    return { template: replacement, replacement: true };
  }
  if (audience === 'CASH') {
    const keys = replacement
      ? `${replacement.dltTemplateIdEnv} and ${replacement.msg91TemplateIdEnv}`
      : 'a cash template id';
    return {
      refused:
        `${kind} for a cash buyer has no approved SMS wording yet: the registered text speaks ` +
        `of a refund, and a cash buyer gets the cash back at the venue. Set ${keys} once ` +
        `the cash wording is approved.`,
    };
  }
  return { template: registered, replacement: false };
}

/** Every env key the registry reads, for the config schema and the readiness report. */
export function dltTemplateEnvKeys(): { msg91: string[]; dlt: string[] } {
  const all = Object.values(DLT_SMS_TEMPLATES);
  return {
    msg91: all.map((t) => t.msg91TemplateIdEnv),
    dlt: all.map((t) => t.dltTemplateIdEnv),
  };
}

/**
 * Fit a value into one DLT variable.
 *
 * Shortened here, with a visible "...", rather than left for the operator to cut or refuse.
 * Only free text (an event title) is ever long enough to need it; a reference or an amount
 * never is.
 */
export function fitDltVariable(value: string): string {
  const v = value.replace(/\s+/g, ' ').trim();
  if (v.length <= DLT_VARIABLE_MAX_LENGTH) return v;
  return `${v.slice(0, DLT_VARIABLE_MAX_LENGTH - 3).trimEnd()}...`;
}

/**
 * The text a recipient will read: the registered wording with each `{#var#}` filled in order.
 *
 * This is what the operator sees too, so it is what the render test compares against the
 * registered wording. Throws on a count mismatch, because a template with a variable left
 * unfilled is not the approved template.
 */
export function renderDltSms(template: DltSmsTemplate, values: readonly string[]): string {
  const parts = template.text.split(DLT_VARIABLE);
  if (parts.length - 1 !== values.length || values.length !== template.variables.length) {
    throw new Error(
      `${template.kind}: ${values.length} value(s) for ${parts.length - 1} {#var#} slot(s).`,
    );
  }
  return parts.reduce((out, part, i) => (i === 0 ? part : `${out}${values[i - 1]}${part}`), '');
}

/**
 * Whether `text` is an instance of the registered wording, and if so, its variable values.
 *
 * The operator's own check, run before the request is made: fixed text identical, each
 * variable present and no longer than DLT allows. Null means the carrier would drop it.
 */
export function matchDltSms(template: DltSmsTemplate, text: string): string[] | null {
  const parts = template.text.split(DLT_VARIABLE).map(escapeRegExp);
  const pattern = new RegExp(`^${parts.join(`(.{1,${DLT_VARIABLE_MAX_LENGTH}}?)`)}$`, 's');
  const m = pattern.exec(text);
  return m ? m.slice(1) : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The variable values for a notification, from its payload, in template order.
 *
 * Returns the names of anything missing instead of rendering a hole: a blank variable is not
 * the approved message. Money is integer minor units in the payload and is shown as rupees
 * with two decimals and an ASCII "Rs", never a float.
 */
export function dltVariablesFromPayload(
  template: DltSmsTemplate,
  payload: Record<string, unknown>,
): { values: string[] } | { missing: string[] } {
  const p = payload ?? {};
  const text = (key: string): string => {
    const v = p[key];
    return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
  };
  const zone = text('timeZone') || text('timezone') || 'Asia/Kolkata';
  const source: Record<string, () => string> = {
    reference: () => text('reference'),
    event: () => fitDltVariable(text('eventTitle') || text('eventName')),
    when: () => formatShowTime(text('startsAt'), zone),
    amount: () => formatMinor(p['amountMinor'], text('currency')),
  };
  const values: string[] = [];
  const missing: string[] = [];
  for (const name of template.variables) {
    const value = source[name]?.() ?? '';
    if (!value) missing.push(name);
    values.push(value);
  }
  return missing.length > 0 ? { missing } : { values };
}

/** `12 Oct 2026, 07:30 PM` in the venue's zone. Empty when the time is missing or unreadable. */
export function formatShowTime(iso: string, timeZone: string): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const fmt = (zone: string) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    })
      .format(at)
      .replace(/\s+/g, ' ')
      .replace(/\b(am|pm)\b/i, (s) => s.toUpperCase());
  try {
    return fmt(timeZone);
  } catch {
    // An unrecognised zone name must not cost the buyer the message.
    return fmt('Asia/Kolkata');
  }
}

/** Integer minor units to `Rs 1250.00` (INR) or `USD 12.50`. Empty when not an integer. */
export function formatMinor(minor: unknown, currency: string): string {
  const n = typeof minor === 'string' && /^-?\d+$/.test(minor) ? Number(minor) : minor;
  if (typeof n !== 'number' || !Number.isInteger(n) || !currency) return '';
  const abs = Math.abs(n);
  const major = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  const symbol = currency.toUpperCase() === 'INR' ? 'Rs' : currency.toUpperCase();
  return `${n < 0 ? '-' : ''}${symbol} ${major}`;
}
