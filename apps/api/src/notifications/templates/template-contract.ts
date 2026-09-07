import { NotificationType } from '@eticketsgo/shared-types';

/**
 * What each notification type must be told before it can say anything useful.
 *
 * ── THE FAILURE THIS PREVENTS ──────────────────────────────────────────────────────
 * Every builder in `notification-template.service.ts` reads its payload through a helper
 * that substitutes a fallback for anything absent, and that forgiveness is deliberate: an
 * older queued notification still renders as a sentence rather than one with holes in it.
 *
 * It is the wrong default for a message being composed NOW. A `SHOW_CANCELLED` built from a
 * payload missing its event title renders as "Your event has been cancelled" — grammatical,
 * confident, and useless to somebody holding tickets for four different shows. Nothing
 * errors, nothing is logged, and the customer's reply to support is "which one?".
 *
 * On the templated channels it is worse than useless. A DLT template has a fixed number of
 * variables; supplying an empty one produces a message the operator's own approval no longer
 * matches, which is refused at the carrier or delivered with a blank in the middle of it.
 *
 * ── WHY REQUIRED AND OPTIONAL ARE BOTH DECLARED ────────────────────────────────────
 * A field being optional is a decision, and an undeclared field is not obviously either.
 * `seats` genuinely is optional — a general-admission booking has none, and printing
 * "seats: " would be worse than omitting the clause. Writing that down is what makes the
 * required list mean something.
 */
export interface TemplateContract {
  /** Absent or blank means the message cannot be composed truthfully. */
  required: readonly string[];
  /** Legitimately absent sometimes; the builder omits the clause rather than printing empty. */
  optional?: readonly string[];
}

/**
 * The contracts.
 *
 * Only for types a producer creates from live domain data. Types driven entirely by their own
 * flow — a password reset carrying its own link, an attendee invitation — are absent, and an
 * absent contract requires nothing rather than requiring everything.
 */
export const TEMPLATE_CONTRACTS: Partial<Record<NotificationType, TemplateContract>> = {
  /*
    The ticket. `reference` is what a customer reads down a phone to support, and the event
    and time are how they recognise which booking this is among several.
  */
  [NotificationType.BOOKING_CONFIRMED]: {
    required: ['reference', 'eventTitle', 'startsAt'],
    optional: ['seats', 'tickets', 'venue', 'timezone'],
  },

  /*
    Somebody may be about to travel to a venue for a show that is not happening. Every field
    here is what stops them: WHICH show, WHERE, and WHEN it was going to be.
  */
  [NotificationType.SHOW_CANCELLED]: {
    required: ['reference', 'eventTitle', 'startsAt'],
    optional: ['venue', 'timezone', 'refundStatus'],
  },

  /*
    The whole message is a time. A missing one renders as "your show has moved" with nothing
    after it, which tells the reader only that they now have a problem.
  */
  [NotificationType.SHOW_CHANGED]: {
    required: ['reference', 'eventTitle', 'startsAt'],
    optional: ['venue', 'timezone', 'previousStartsAt'],
  },

  /* Money going back. The amount and its currency, or the sentence is not about anything. */
  [NotificationType.REFUND_COMPLETED]: {
    required: ['reference', 'amountMinor', 'currency'],
    optional: ['refundId'],
  },

  /*
    A courtesy, and the only type here whose whole purpose is the time. `reference` is not
    required: a reminder is about the SHOW, not about the paperwork.
  */
  [NotificationType.EVENT_REMINDER]: {
    required: ['eventName', 'startsAt'],
    optional: ['venue', 'timezone', 'reference'],
  },

  [NotificationType.BOOKING_CANCELLED]: {
    required: ['reference'],
    optional: ['eventTitle', 'refundStatus'],
  },

  [NotificationType.PAYMENT_FAILED]: {
    required: ['reference'],
    optional: ['reason'],
  },
};

export interface ContractViolation {
  type: NotificationType;
  missing: string[];
}

/**
 * Check a payload against its contract.
 *
 * Blank counts as missing. A producer that sets `eventTitle: ''` has supplied the key and
 * none of the information, and the rendered sentence is identical either way — so treating
 * the two differently would only make the check easy to pass and pointless.
 */
export function validateTemplatePayload(
  type: NotificationType,
  payload: Record<string, unknown> | null | undefined,
): ContractViolation | null {
  const contract = TEMPLATE_CONTRACTS[type];
  if (!contract) return null;
  const p = payload ?? {};
  const missing = contract.required.filter((key) => {
    const value = p[key];
    if (value === undefined || value === null) return true;
    return typeof value === 'string' ? value.trim() === '' : false;
  });
  return missing.length > 0 ? { type, missing } : null;
}
