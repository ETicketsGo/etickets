import { ApiRequestError } from '@eticketsgo/web-kit';
import { looksLikeTicketNumber } from './ticket-number';

/**
 * The door screen's two decisions that must never be guessed: what was just scanned or typed,
 * and what a failed check means.
 *
 * ── WHY THESE ARE THEIR OWN FUNCTIONS ──────────────────────────────────────────────────
 * The gate used to send everything to the scan endpoint and show "Not valid" for every error.
 * A printed ticket number (TKT-...) typed by hand can never pass as a signed QR code, and a
 * dropped connection is not a forged ticket. Both read as "turn this person away". These
 * functions keep "we could not check" apart from "this ticket is bad".
 */

export type GateInput =
  | { kind: 'empty' }
  /** A ticket serial or booking reference printed on the ticket: a lookup, not a scan. */
  | { kind: 'number'; value: string }
  /** What a QR code carries: a signed token the server verifies. */
  | { kind: 'token'; value: string };

export function classifyGateInput(raw: string): GateInput {
  const value = raw.trim();
  if (!value) return { kind: 'empty' };
  if (looksLikeTicketNumber(value)) return { kind: 'number', value: value.toUpperCase() };
  return { kind: 'token', value };
}

/**
 * Why a check produced no answer.
 *
 * NO_CONNECTION: the request never reached us (the fetch itself failed).
 * NOT_CHECKED: we answered with an error (signed out, no permission, server fault). The
 * ticket was not judged either way.
 *
 * Neither is ever INVALID: INVALID is a verdict the server gives about a ticket, in a
 * successful response.
 */
export type GateFailure = 'NO_CONNECTION' | 'NOT_CHECKED';

export function classifyGateFailure(err: unknown): GateFailure {
  return err instanceof ApiRequestError ? 'NOT_CHECKED' : 'NO_CONNECTION';
}

/**
 * Whether a key ends a hardware scanner's code. Enter is handled by the form; Tab is the other
 * common scanner suffix and must submit too, or the code sits in the field unchecked while
 * focus moves away. A Tab on an empty field is a person moving focus, and is left alone.
 */
export function isScanTerminator(key: string, value: string): boolean {
  return key === 'Tab' && value.trim().length > 0;
}
