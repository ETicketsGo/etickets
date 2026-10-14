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
 * The header registered for DeepTrics Software Solutions Private Limited and APPROVED.
 *
 * Recorded for the docs and the readiness report only. It is NOT a default: the header that
 * goes on the wire comes from DLT_SENDER_HEADER / MSG91_SENDER_ID, so a change of header is a
 * configuration change and never a build.
 */
export const DOCUMENTED_APPROVED_SENDER_HEADER = 'DPTRCS';

/**
 * Headers the DLT portal REJECTED for this entity.
 *
 * ETKTGO was applied for and refused. Configuring it would send every message under a header
 * the operator does not recognise, which is dropped exactly like unregistered wording. The
 * boot check refuses it by name so the mistake costs one deploy log line, not a launch day.
 */
export const REJECTED_SENDER_HEADERS: readonly string[] = ['ETKTGO'];

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
