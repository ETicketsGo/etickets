import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { redirectUrl } from '../common/console-urls';

/**
 * The credential that gets a buyer with no account back to their booking.
 *
 * ── WHY THESE ARE FUNCTIONS AND NOT A SERVICE ──────────────────────────────────────
 * Two callers need them and they sit on opposite sides of a module edge: the guest read routes
 * (bookings) and the confirmation that emails the first link (payments). PaymentsModule does
 * not import BookingOrchestrationModule and must not start to — that edge is one-way on
 * purpose, and reversing it for a token mint would introduce the DI cycle ADR-042 §2 was
 * arranged to avoid. Plain functions taking the transaction client cross it freely, which is
 * exactly how `BookingReferenceService`'s neighbours already work.
 *
 * Everything here takes a `Prisma.TransactionClient`, so the link can be minted inside the
 * transaction that confirms a booking: an email promising a link and a link that does not
 * exist must not be two separate facts.
 */

/** 256 bits. The same entropy the anonymous checkout session and a password reset use. */
const TOKEN_BYTES = 32;

/**
 * ── HOW LONG A GUEST LINK LIVES ────────────────────────────────────────────────────
 * A week, and never less than a day past the show it admits somebody to.
 *
 * The floor is the interesting half, and it is the SHOW's start, not the moment of purchase.
 * A guest's only other handle on their booking is the `x-anon-session` token in one browser's
 * memory, so a link that died first would leave a paid ticket unreachable while the show was
 * still to come — which is precisely the case for anybody who books three weeks ahead. The
 * extra day past the start covers a late arrival and a show that runs past midnight.
 *
 * A booking with no known start time keeps the plain week.
 */
const SHOW_GRACE_MS = 24 * 60 * 60 * 1000;
const LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function guestAccessExpiry(now: Date, showStartsAt: Date | null | undefined): Date {
  const showFloor = (showStartsAt ?? now).getTime() + SHOW_GRACE_MS;
  return new Date(Math.max(showFloor, now.getTime() + LINK_TTL_MS));
}

/** Stable at-rest identifier. The raw token is never stored, logged, or returned. */
export function hashGuestAccessToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time hash comparison.
 *
 * The lookup is by unique index, so this is not what finds the row — it is what stops the
 * comparison itself from being a timing oracle if the lookup ever becomes a scan. Cheap, and
 * the alternative is a security property that depends on a query plan.
 */
export function guestAccessTokenMatches(presented: string, storedHash: string): boolean {
  const a = Buffer.from(hashGuestAccessToken(presented), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface IssueGuestAccessInput {
  bookingId: string;
  /**
   * When the show starts, which sets the floor on expiry: a ticket stays reachable until the
   * thing it admits somebody to has happened.
   */
  showStartsAt?: Date | null;
  now?: Date;
}

/**
 * Mint a link for one booking and supersede every older live one.
 *
 * ── WHY THE OLD ROWS GO ────────────────────────────────────────────────────────────
 * The same reason a password reset spends the previous link: two live credentials for one
 * booking means an older one — already forwarded, or sitting in a mailbox somebody else now
 * reads — still opens it after the owner has asked for a fresh one. Re-issuing is how somebody
 * recovers from a leak, and it accomplishes nothing if the leaked link keeps working.
 *
 * Returns the RAW token. It is written nowhere: the only copy that survives this call is the
 * one the caller puts in an email body.
 */
export async function issueGuestAccessToken(
  tx: Prisma.TransactionClient,
  input: IssueGuestAccessInput,
): Promise<{ token: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const expiresAt = guestAccessExpiry(now, input.showStartsAt);

  await tx.guestBookingAccess.deleteMany({ where: { bookingId: input.bookingId } });
  await tx.guestBookingAccess.create({
    data: { bookingId: input.bookingId, tokenHash: hashGuestAccessToken(token), expiresAt },
  });

  return { token, expiresAt };
}

/**
 * The URL that goes in the email.
 *
 * Built from `redirectUrl`, which derives the customer site's origin from the one variable
 * that knows it and FAILS LOUDLY rather than sending somebody to localhost. Not from
 * CORS_ORIGINS: that is a list of who may call the API, it is ordered by nothing in
 * particular, and using its first entry as "the website" is how a customer ends up on a
 * preview deployment holding the only link to their tickets.
 */
export function guestAccessLink(config: ConfigService, token: string): string {
  return redirectUrl(config, {
    overrideVariable: 'GUEST_BOOKING_ACCESS_URL',
    site: 'customer',
    path: `/booking/access/${token}`,
    purpose: 'guest booking access',
  });
}
