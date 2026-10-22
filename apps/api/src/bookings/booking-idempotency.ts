import { createHash } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import { AppException, ErrorCodes } from '../common/errors';
import { normaliseEmail } from './booking-hold-limits';

/**
 * What an `Idempotency-Key` on a booking create is bound to.
 *
 * ── THE TWO FAILURES THIS CLOSES ───────────────────────────────────────────────────
 * The key used to be looked up under one global scope, `booking:create`. So:
 *   1. A key reused by ANOTHER buyer returned the first buyer's cached booking response - their
 *      booking id, total and payment id - to a stranger who only had to send the same header.
 *      Keys are client-chosen, so "the same header" includes a guessed or a leaked one.
 *   2. Nothing marked a key as being worked on. Two requests with one key (a double tap, a
 *      mobile retry while the first is still running) both missed the cache, both built a
 *      booking, and the second died on `Booking.idempotencyKey @unique` as a 500.
 *
 * Now the key is scoped to the ACTOR - the account, or for a guest the address on the order -
 * and the record carries a hash of the request body, so a key replayed with a different cart is
 * refused instead of answered with a booking that does not match what was sent. The record is
 * claimed inside the booking transaction, before any stock is held, so a concurrent duplicate
 * waits on the unique index and then reads the winner's answer (see `BookingsService.create`).
 *
 * The scope name changed (`booking:create:v2`), so a key recorded by the old code is simply
 * not found: the worst case at deploy time is one retry in flight creating its booking again,
 * which is what that retry would have done anyway if it had arrived a second earlier.
 */
export const BOOKING_IDEMPOTENCY_SCOPE = 'booking:create:v2';

/** Longest header accepted. Long enough for any UUID or prefixed key, short enough to bound. */
const MAX_KEY_LENGTH = 200;

export interface BookingIdempotency {
  scope: string;
  /** sha256(actor, raw key): stored on the record AND on `Booking.idempotencyKey`. */
  key: string;
  requestHash: string;
}

/** JSON with object keys sorted, so the same cart always hashes the same however it was built. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function bookingIdempotency(input: {
  rawKey: string;
  userId: string | null;
  buyerEmail: string;
  body: unknown;
  counterSale?: boolean;
}): BookingIdempotency {
  if (input.rawKey.length > MAX_KEY_LENGTH) {
    throw new AppException(
      ErrorCodes.VALIDATION_FAILED,
      `The Idempotency-Key header can be at most ${MAX_KEY_LENGTH} characters.`,
      HttpStatus.BAD_REQUEST,
    );
  }
  const actor = input.userId
    ? `user:${input.userId}`
    : `guest:${sha256(normaliseEmail(input.buyerEmail))}`;
  return {
    scope: BOOKING_IDEMPOTENCY_SCOPE,
    key: sha256(`${actor}\n${input.rawKey}`),
    requestHash: sha256(stable({ body: input.body, counterSale: Boolean(input.counterSale) })),
  };
}

export const IDEMPOTENCY_KEY_REUSED =
  'This request key was already used for a different booking. Start the checkout again.';
export const IDEMPOTENCY_IN_PROGRESS =
  'This booking is still being created. Wait a moment, then check your bookings before trying again.';
