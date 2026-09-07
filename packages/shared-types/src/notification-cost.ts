/**
 * What a notification attempt cost, and why some of them cost nothing knowable.
 *
 * ── WHY MONEY HERE IS NOT IN MINOR UNITS ───────────────────────────────────────────
 * Every other price on this platform is an integer number of cents or paise, because every
 * other price is something a customer pays. Notification costs are not: SES is $0.10 per
 * THOUSAND emails, which is $0.0001 each — a hundredth of a cent. In minor units that is
 * 0.01, and an integer cannot hold it, so a platform storing notification costs in cents
 * either rounds every email to zero or every email to one cent. Both are wrong by orders of
 * magnitude, and the second is wrong in the direction that makes the platform look ruinous.
 *
 * So the unit here is the MICRO: one millionth of a currency unit. SES is 100 micro-USD per
 * email, a Twilio segment is around 7,900, an MSG91 SMS around 150,000 micro-INR. All
 * integers, all exact, and the name says what it is so nobody adds it to a `feeMinor`.
 *
 * Floating point appears nowhere. `0.1 + 0.2` is famously not `0.3`, and a cost report is
 * summed over millions of rows.
 */

/** One millionth of a currency unit. Integer, exact, never a float. */
export const MICROS_PER_UNIT = 1_000_000;

/**
 * How a provider counts what it charges for. They do not agree, and assuming they do is how
 * a cost model ends up out by a factor of three on Unicode SMS.
 */
export const BillingUnit = {
  /** One charge per message, whatever its length. */
  PER_MESSAGE: 'PER_MESSAGE',
  /** One charge per 160-character GSM-7 segment (70 for Unicode). Most SMS providers. */
  PER_SEGMENT: 'PER_SEGMENT',
  /** WhatsApp's 24-hour conversation window, not the individual message. */
  PER_CONVERSATION: 'PER_CONVERSATION',
  /** One charge per business-initiated template message. */
  PER_TEMPLATE_MESSAGE: 'PER_TEMPLATE_MESSAGE',
  /** A price quoted per thousand — SES, and most bulk email. */
  PER_1000: 'PER_1000',
  /** One charge per API call, whatever it contained. */
  PER_REQUEST: 'PER_REQUEST',
} as const;
export type BillingUnit = (typeof BillingUnit)[keyof typeof BillingUnit];

/**
 * Where a cost figure came from, which decides how much to trust it.
 *
 * ── WHY UNKNOWN IS A VALUE AND NOT A NULL WITH A SHRUG ─────────────────────────────
 * "We have no rate configured for MSG91 WhatsApp in India" and "MSG91 WhatsApp in India is
 * free" are different facts, and a report that shows both as 0 is lying about one of them.
 * The first means the number on the screen is missing a component; the second means it is
 * complete. Every cost report here carries an unknown COUNT alongside its total, so a reader
 * can tell whether the total is the answer or a floor.
 */
export const CostSource = {
  /** The provider told us, on the send response or a webhook. The best kind. */
  PROVIDER_REPORTED: 'PROVIDER_REPORTED',
  /** Computed from a configured rate. An estimate, and labelled as one. */
  RATE_CARD: 'RATE_CARD',
  /** Corrected against a provider invoice. Overrides an estimate. */
  RECONCILED: 'RECONCILED',
  /** No rate applied. NOT zero. */
  UNKNOWN: 'UNKNOWN',
  /** A rate of zero was explicitly configured. Deliberately distinct from UNKNOWN. */
  CONFIGURED_FREE: 'CONFIGURED_FREE',
} as const;
export type CostSource = (typeof CostSource)[keyof typeof CostSource];

/** Whether this attempt cost money that anybody should be counting. */
export function isBillable(source: CostSource): boolean {
  return (
    source === CostSource.PROVIDER_REPORTED ||
    source === CostSource.RATE_CARD ||
    source === CostSource.RECONCILED
  );
}

/**
 * Why an attempt happened, which is the difference between a cost we chose and one we did not.
 *
 * A retry of a failed send and an operator resending on request both produce a provider
 * charge, and lumping them together hides the only interesting question about the second:
 * how much is support spending. A fallback SMS is the most expensive thing this platform
 * does per message and has to be separable from every ordinary send.
 */
export const SendKind = {
  /** The first attempt on a channel policy chose. */
  PRIMARY: 'PRIMARY',
  /** An automatic re-attempt after a send that never reached a provider. */
  RETRY: 'RETRY',
  /** A different channel, opened because the preferred ones produced nothing. */
  FALLBACK: 'FALLBACK',
  /** An operator deliberately sending it again, on a customer's behalf. */
  MANUAL_RESEND: 'MANUAL_RESEND',
  /**
   * Operator certification traffic. Not a customer message at all.
   *
   * ── WHY THIS IS NOT MANUAL_RESEND ──────────────────────────────────────────────────
   * A resend is support acting for a real customer about a real booking, and "how much is
   * support spending on people's behalf" is a question somebody will ask of that number. A
   * test send is an engineer proving a provider works, addressed to a destination they own.
   *
   * Filed together, every certification run inflates the support figure and every quiet
   * month of testing looks like a support incident. The cost is real either way and stays
   * visible — it is the attribution that would be wrong.
   */
  TEST: 'TEST',
} as const;
export type SendKind = (typeof SendKind)[keyof typeof SendKind];

/**
 * Whether an attempt was a real customer message or operator traffic.
 *
 * Business counts — notifications sent, cost per booking, support resend volume — are about
 * customers. A certification send is neither, so it is excluded from those and reported on
 * its own. Its COST is still counted: a WhatsApp test in India is real money.
 */
export function isCustomerTraffic(kind: SendKind): boolean {
  return kind !== SendKind.TEST;
}

/**
 * Why an attempt ended as it did, in terms that separate OUR failures from THEIRS.
 *
 * ── THE DENOMINATOR PROBLEM THIS SOLVES ────────────────────────────────────────────
 * A provider-health report is only meaningful if its failures are the provider's. Counting a
 * suppressed address, somebody with no phone number, or a channel a customer switched off as
 * "Twilio failed" makes Twilio look broken because our customers have preferences — and,
 * worse, hides a real Twilio outage inside a number that is always high.
 *
 * These five are the honest split, and only the first two are the provider's fault.
 */
export const OutcomeClass = {
  /** The provider carried it, or says it did. */
  PROVIDER_ACCEPTED: 'PROVIDER_ACCEPTED',
  /** The provider refused it: bad template, blocked number, bad credential. Theirs. */
  PROVIDER_REJECTED: 'PROVIDER_REJECTED',
  /** The provider could not be reached, or timed out. Theirs. */
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  /** The provider carried it and it did not arrive. Usually the destination, not them. */
  UNDELIVERABLE_DESTINATION: 'UNDELIVERABLE_DESTINATION',
  /** We refused to send: the destination is suppressed. Ours, and deliberate. */
  POLICY_SUPPRESSED: 'POLICY_SUPPRESSED',
  /** Nowhere to send to: no phone on file, no registered device, no address. Ours. */
  NO_DESTINATION: 'NO_DESTINATION',
  /**
   * We could not even try: a credential, template or route this platform was supposed to
   * hold is not configured. Ours, and fixable only by a human.
   *
   * -- WHY THIS IS NOT PROVIDER_UNAVAILABLE ------------------------------------------
   * It was, for three phases, and it made every health report wrong in the same direction.
   * A market with no MSG91 account yet produced an unbroken run of "MSG91 unavailable",
   * which is the exact signal that is supposed to mean MSG91 is down. The number meant to
   * detect an outage was pinned at 100% before the account existed.
   *
   * Kept outside `isProviderOutcome` and `reachedProvider` so it counts against nobody's
   * reliability and is never priced -- no call was made, so no charge is possible.
   */
  CONFIGURATION_BLOCKED: 'CONFIGURATION_BLOCKED',
} as const;
export type OutcomeClass = (typeof OutcomeClass)[keyof typeof OutcomeClass];

/** Whether this outcome says anything at all about the provider's reliability. */
export function isProviderOutcome(outcome: OutcomeClass | null | undefined): boolean {
  return (
    outcome === OutcomeClass.PROVIDER_ACCEPTED ||
    outcome === OutcomeClass.PROVIDER_REJECTED ||
    outcome === OutcomeClass.PROVIDER_UNAVAILABLE ||
    outcome === OutcomeClass.UNDELIVERABLE_DESTINATION
  );
}

/** Whether the provider was called at all — and therefore whether a charge is possible. */
export function reachedProvider(outcome: OutcomeClass | null | undefined): boolean {
  return (
    outcome === OutcomeClass.PROVIDER_ACCEPTED ||
    outcome === OutcomeClass.UNDELIVERABLE_DESTINATION ||
    // A rejection is a call that was made and answered. Some providers bill for it; most do
    // not, which is a question for the rate card rather than an assumption made here.
    outcome === OutcomeClass.PROVIDER_REJECTED
  );
}

/**
 * How many segments a GSM-7 or Unicode SMS costs.
 *
 * ── WHY THIS IS COUNTED AND NOT ESTIMATED ──────────────────────────────────────────
 * One logical SMS is not one billed SMS. A 200-character message is two segments and costs
 * twice; the same message with one emoji in it is Unicode, drops to 70 characters per
 * segment, and costs three. A platform that assumes one message equals one charge is out by
 * a factor of three on exactly the messages people notice — and Indian transactional
 * templates with a rupee sign are Unicode.
 *
 * The GSM-7 alphabet and its extension table are a published standard, not a guess, so this
 * is exact for any message composed of them. A character outside the alphabet forces UCS-2
 * for the WHOLE message, which is the rule that surprises people.
 */
const GSM7 =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
/** These cost TWO GSM-7 characters each: an escape, then the character. */
const GSM7_EXTENDED = '^{}\\[~]|€';

export interface SmsSegments {
  segments: number;
  encoding: 'GSM7' | 'UCS2';
  /** Billed characters, after extension characters are counted twice. */
  units: number;
}

export function countSmsSegments(body: string): SmsSegments {
  let units = 0;
  let gsm = true;
  for (const char of body) {
    if (GSM7.includes(char)) {
      units += 1;
    } else if (GSM7_EXTENDED.includes(char)) {
      units += 2;
    } else {
      gsm = false;
      break;
    }
  }

  if (!gsm) {
    /*
      One character outside the alphabet moves the WHOLE message to UCS-2, and surrogate
      pairs (an emoji) count as two units, not one. Counting code points instead of code
      units here would under-count every message containing one.
    */
    const ucs2Units = body.length;
    const perSegment = ucs2Units <= 70 ? 70 : 67;
    return {
      encoding: 'UCS2',
      units: ucs2Units,
      segments: Math.max(1, Math.ceil(ucs2Units / perSegment)),
    };
  }

  // A concatenated message spends 7 characters per segment on the header that reassembles it.
  const perSegment = units <= 160 ? 160 : 153;
  return { encoding: 'GSM7', units, segments: Math.max(1, Math.ceil(units / perSegment)) };
}

/**
 * The cost of `quantity` billing units at `unitPriceMicro`, in micros.
 *
 * Integer arithmetic throughout. `PER_1000` divides at the end and rounds half-up, so a
 * hundred emails at $0.10/1000 is 10,000 micros exactly rather than a hundred roundings of
 * 100.0000001.
 */
export function costMicrosFor(unitPriceMicro: number, unit: BillingUnit, quantity: number): number {
  const q = Math.max(1, Math.trunc(quantity));
  if (unit === BillingUnit.PER_1000) {
    return Math.round((unitPriceMicro * q) / 1000);
  }
  return unitPriceMicro * q;
}

/** Micros back to a decimal string, for display only. Never used for arithmetic. */
export function microsToDecimalString(micros: number, fractionDigits = 6): string {
  const negative = micros < 0;
  const abs = Math.abs(micros);
  const whole = Math.trunc(abs / MICROS_PER_UNIT);
  const frac = String(abs % MICROS_PER_UNIT)
    .padStart(6, '0')
    .slice(0, fractionDigits);
  return `${negative ? '-' : ''}${whole}${fractionDigits > 0 ? `.${frac}` : ''}`;
}
