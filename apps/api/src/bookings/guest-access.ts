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

/**
 * Whether somebody typed the address the booking was paid with.
 *
 * ── WHY THE LINK IS NOT ENOUGH ON ITS OWN ──────────────────────────────────────────
 * The emailed link is forwardable — to the friend who is coming, to a colleague claiming
 * expenses, into a support thread — and that is a feature: it shows somebody where to sit.
 * It deliberately does NOT show who bought the seat, which is why the view masks the buyer's
 * address. Money and personal documents are a different matter: an invoice names the buyer and
 * an amount, and a refund moves money out of their card. Those need one more thing that only
 * the buyer has, and the cheapest such thing is the address the platform already mailed the
 * link to. The real buyer types it in three seconds; the person holding a forwarded link cannot,
 * because all they were ever shown was two characters and a domain.
 *
 * ── WHY TRIMMED AND CASE-INSENSITIVE ───────────────────────────────────────────────
 * It is typed, by a person, into a form, on a phone that capitalises the first letter and a
 * clipboard that brings a trailing space. The local part of an address is case-sensitive by RFC
 * and by no mail provider on earth, and refusing `Bobby@example.com` to the person who owns
 * `bobby@example.com` would deny somebody a receipt for their own money. It is not a password
 * and must not be treated like one.
 *
 * ── AND WHY CONSTANT TIME ANYWAY ───────────────────────────────────────────────────
 * Because it is being used here as a proof of identity, and `a === b` on strings returns as
 * soon as two characters differ. Against a route somebody can call repeatedly that is a
 * character-at-a-time oracle for an address they were only ever shown two characters of.
 * Hashing first is what makes the comparison constant time over inputs of DIFFERENT lengths:
 * `timingSafeEqual` throws on a length mismatch, and returning early on length would leak how
 * long the buyer's address is.
 */
export function guestEmailMatches(
  presented: string | null | undefined,
  stored: string | null | undefined,
): boolean {
  const normalise = (value: string | null | undefined) => (value ?? '').trim().toLowerCase();
  const a = normalise(presented);
  const b = normalise(stored);
  // Nothing matches nothing: a booking with no recorded address must not be openable by
  // submitting an empty field, and an empty submission must never match anything.
  if (!a || !b) return false;
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
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
