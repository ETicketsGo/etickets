import { createHash } from 'node:crypto';
import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { BookingStatus } from '@eticketsgo/shared-types';
import { AppException, ErrorCodes } from '../common/errors';

/**
 * How much one buyer may hold at once, and how big one order may be.
 *
 * ── THE ABUSE THIS CLOSES ──────────────────────────────────────────────────────────
 * A hold takes seats off sale before anybody pays. Nothing bounded how many a caller could
 * open: `POST /bookings/guest` is public, so a script could open checkout after checkout and
 * never pay, and a sold-out show would read sold out to every real buyer for as long as the
 * holds lasted. With "pay at the venue" switched on that is until SHOWTIME, for free. The
 * per-owner limits in the Redis lock layer would have caught it, but that layer runs in shadow
 * mode and decides nothing.
 *
 * ── WHY POSTGRES AND NOT REDIS ─────────────────────────────────────────────────────
 * The count is read from the bookings themselves (PENDING_PAYMENT, deadline in the future), in
 * the same transaction that inserts the new hold, under an advisory lock per buyer. So:
 *   * a hold that is paid, cancelled, expired or released stops counting the instant its row
 *     changes - there is no counter to decrement, so no counter can drift or leak;
 *   * a hold extended by the buyer keeps counting for exactly as long as it really lasts;
 *   * a refusal, or any later failure, rolls the whole booking back with the count;
 *   * Redis being down neither blocks every booking nor silently removes the limit.
 * A Redis Lua counter with a TTL would have had to guess the hold's lifetime at creation and be
 * told about every way a hold can end, which is five code paths that do not know it exists.
 *
 * The lock is `pg_advisory_xact_lock`, released by the commit, so two requests from one buyer
 * at the same instant are counted one after the other and cannot both see "two of three".
 * Locks are taken in sorted order, so two transactions that share keys cannot deadlock.
 *
 * ── THE CLIENT IP NEEDS ONE ROW ────────────────────────────────────────────────────
 * A booking does not record the address it came from, and adding a column for a rate limit
 * would put a client IP on a financial record forever. Instead each hold leaves one
 * `IdempotencyRecord` row - scope `booking:hold-ip:<sha256 of the IP>`, key the booking id -
 * written in the same transaction, so it exists exactly when the booking does. The count joins
 * it back to the booking, so liveness is still decided by the booking row, and rows whose
 * booking is no longer holding anything are deleted the next time that address books.
 *
 * ── WHY THE DEFAULTS ARE WHERE THEY ARE ────────────────────────────────────────────
 * Three open checkouts per account or guest email: a real buyer has one, sometimes a second
 * after going back to change seats, rarely a third. The cap counts ONLINE holds only, so a
 * customer with pay-at-venue reservations for next week can still buy online today.
 * Twenty per IP address, online and pay-at-venue together: a cinema lobby, a campus or a mobile
 * carrier puts many real buyers behind one address, so this is set as a backstop against a
 * script that changes its email every request, not as the everyday limit.
 * One pay-at-venue reservation per show and two overall, of at most six tickets: a family
 * booking the evening out. A larger group pays online, which holds for minutes, not days.
 */

export interface HoldLimits {
  seatsPerOrder: number;
  perUser: number;
  perEmail: number;
  perIp: number;
  cashPerShow: number;
  cashTotal: number;
  cashSeats: number;
}

/** The defaults, which are also what `configuration.ts` defaults to. 0 switches a cap off. */
export const DEFAULT_HOLD_LIMITS: HoldLimits = {
  seatsPerOrder: 20,
  perUser: 3,
  perEmail: 3,
  perIp: 20,
  cashPerShow: 1,
  cashTotal: 2,
  cashSeats: 6,
};

const CONFIG_KEYS: Record<keyof HoldLimits, string> = {
  seatsPerOrder: 'BOOKING_MAX_SEATS_PER_ORDER',
  perUser: 'BOOKING_MAX_ACTIVE_HOLDS_PER_USER',
  perEmail: 'BOOKING_MAX_ACTIVE_HOLDS_PER_EMAIL',
  perIp: 'BOOKING_MAX_ACTIVE_HOLDS_PER_IP',
  cashPerShow: 'BOOKING_MAX_CASH_RESERVATIONS_PER_SHOW',
  cashTotal: 'BOOKING_MAX_CASH_RESERVATIONS_TOTAL',
  cashSeats: 'BOOKING_MAX_SEATS_PER_CASH_RESERVATION',
};

/**
 * The limits for this process. A value that is missing or not a whole number falls back to the
 * default rather than to "no limit": a typo in an environment variable must not be the thing
 * that switches a protection off.
 */
export function holdLimitsFrom(config?: Pick<ConfigService, 'get'> | null): HoldLimits {
  const out = { ...DEFAULT_HOLD_LIMITS };
  for (const field of Object.keys(CONFIG_KEYS) as (keyof HoldLimits)[]) {
    const raw = config?.get<unknown>(CONFIG_KEYS[field]);
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 0) out[field] = n;
  }
  return out;
}

/** One way to compare addresses: trimmed and lower-cased, as `guestEmailMatches` does. */
export function normaliseEmail(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase();
}

/** A stable, non-reversible handle for a lock key or a ledger scope. */
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The quantity of each ticket type across the WHOLE order.
 *
 * ── WHY THE LINES ARE ADDED UP AND NOT REFUSED OR MERGED ───────────────────────────
 * `maxPerOrder` was checked line by line, so the same ticket type sent as five lines of 10
 * bought 50 against a limit of 10. The limit is about the order, so it is now checked against
 * the order's total for that type.
 *
 * Repeated lines are not refused, because a seat map can legitimately send one ticket type as
 * two lines (two blocks of seats picked separately), and they are not merged, because each
 * line carries its own seats and merging would be rewriting what the buyer chose. Counting them
 * together is the one change that closes the bypass and alters nothing a real buyer sends.
 */
export function aggregateTicketQuantities(
  items: ReadonlyArray<{ ticketTypeId: string; quantity: number }>,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const item of items) {
    totals.set(item.ticketTypeId, (totals.get(item.ticketTypeId) ?? 0) + item.quantity);
  }
  return totals;
}

/**
 * The order's size against the ceilings that do not need the database.
 *
 * `ticketCount` includes the tickets inside bundles, because a bundle's tickets hold seats
 * exactly as a ticket line does. A counter sale is not limited: staff selling to a coach party
 * at the door are the organizer selling their own seats, in person, for cash in hand.
 */
export function assertOrderSize(
  ticketCount: number,
  limits: HoldLimits,
  opts: { counterSale?: boolean; wantsCash: boolean },
): void {
  if (opts.counterSale) return;
  if (opts.wantsCash && limits.cashSeats > 0 && ticketCount > limits.cashSeats) {
    throw new AppException(
      ErrorCodes.VALIDATION_FAILED,
      `You can reserve at most ${limits.cashSeats} tickets to pay at the venue. Pay online to book more.`,
      HttpStatus.BAD_REQUEST,
      { maxSeats: limits.cashSeats },
    );
  }
  if (limits.seatsPerOrder > 0 && ticketCount > limits.seatsPerOrder) {
    throw new AppException(
      ErrorCodes.VALIDATION_FAILED,
      `You can book at most ${limits.seatsPerOrder} tickets in one order.`,
      HttpStatus.BAD_REQUEST,
      { maxSeats: limits.seatsPerOrder },
    );
  }
}

export interface HoldLimitContext {
  /** The signed-in buyer, or null for a guest. */
  userId: string | null;
  /** The address on the order. Counted for guests only: an account is counted by its id. */
  buyerEmail: string;
  /** The client address, when the request came over HTTP. Absent (a worker, a test) skips it. */
  clientIp?: string | null;
  eventSessionId: string;
  wantsCash: boolean;
  now: Date;
}

/** Recorded once the booking row exists, inside the same transaction. */
export interface HoldLimitReceipt {
  record(bookingId: string, holdExpiresAt: Date): Promise<void>;
}

const NOTHING_TO_RECORD: HoldLimitReceipt = { record: async () => undefined };

/** The live-hold condition, spelled once. */
function activeHold(now: Date) {
  return { status: BookingStatus.PENDING_PAYMENT, holdExpiresAt: { gt: now } } as const;
}

@Injectable()
export class BookingHoldLimitsService {
  constructor(@Optional() private readonly config?: ConfigService) {}

  limits(): HoldLimits {
    return holdLimitsFrom(this.config);
  }

  /**
   * Refuse a hold that would take this buyer over a limit. Runs INSIDE the booking transaction,
   * before any stock is touched, and returns the one write to make once the booking exists.
   */
  async enforce(tx: Prisma.TransactionClient, ctx: HoldLimitContext): Promise<HoldLimitReceipt> {
    const limits = this.limits();
    const email = normaliseEmail(ctx.buyerEmail);
    const guestEmail = ctx.userId ? null : email || null;
    const ipScope =
      ctx.clientIp && ctx.clientIp !== 'unknown' && limits.perIp > 0
        ? `booking:hold-ip:${digest(ctx.clientIp)}`
        : null;

    /*
      The buyer is the account when there is one and the address otherwise, for both online and
      pay-at-venue holds - one key per buyer, so the two kinds of hold are counted under the same
      lock and cannot be raced against each other.
    */
    const keys = [
      ctx.userId ? `booking-holds:user:${ctx.userId}` : null,
      guestEmail ? `booking-holds:email:${digest(guestEmail)}` : null,
      ipScope ? `booking-holds:${ipScope}` : null,
    ]
      .filter((k): k is string => Boolean(k))
      .sort();
    for (const key of keys) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    }

    const owner: Prisma.BookingWhereInput = ctx.userId
      ? { userId: ctx.userId }
      : { userId: null, buyerEmail: { equals: guestEmail ?? '', mode: 'insensitive' } };
    const live = activeHold(ctx.now);

    if (ctx.wantsCash) {
      if (limits.cashPerShow > 0) {
        const forShow = await tx.booking.count({
          where: { ...owner, ...live, paymentMethod: 'CASH', eventSessionId: ctx.eventSessionId },
        });
        if (forShow >= limits.cashPerShow) {
          throw tooMany(
            limits.cashPerShow === 1
              ? 'You already have a pay-at-venue reservation for this show. Cancel it or pay for it before you reserve again.'
              : `You already have ${forShow} pay-at-venue reservations for this show. Cancel one or pay for it before you reserve again.`,
            'CASH_PER_SHOW',
            limits.cashPerShow,
          );
        }
      }
      if (limits.cashTotal > 0) {
        const total = await tx.booking.count({
          where: { ...owner, ...live, paymentMethod: 'CASH' },
        });
        if (total >= limits.cashTotal) {
          throw tooMany(
            `You already have ${total} pay-at-venue reservations. Cancel one, or pay online for this booking.`,
            'CASH_TOTAL',
            limits.cashTotal,
          );
        }
      }
    } else {
      const cap = ctx.userId ? limits.perUser : limits.perEmail;
      if (cap > 0 && (ctx.userId || guestEmail)) {
        const open = await tx.booking.count({
          where: { ...owner, ...live, paymentMethod: 'ONLINE' },
        });
        if (open >= cap) {
          throw tooMany(
            `You already have ${open} bookings waiting for payment. Finish or cancel one of them, or wait a few minutes for it to expire, then try again.`,
            ctx.userId ? 'USER' : 'EMAIL',
            cap,
          );
        }
      }
    }

    if (!ipScope) return NOTHING_TO_RECORD;

    /*
      Rows whose booking is no longer holding anything are deleted first, so the ledger for one
      address stays as small as its live holds. Liveness is the booking's, not the row's.
    */
    await tx.$executeRaw`
      DELETE FROM "IdempotencyRecord" r
      WHERE r."scope" = ${ipScope}
        AND NOT EXISTS (
          SELECT 1 FROM "Booking" b
          WHERE b."id" = r."key"
            AND b."status" = 'PENDING_PAYMENT'
            AND b."holdExpiresAt" > ${ctx.now}
        )`;
    const rows = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "IdempotencyRecord" r
      JOIN "Booking" b ON b."id" = r."key"
      WHERE r."scope" = ${ipScope}
        AND b."status" = 'PENDING_PAYMENT'
        AND b."holdExpiresAt" > ${ctx.now}`;
    const fromIp = Number(rows?.[0]?.n ?? 0);
    if (fromIp >= limits.perIp) {
      throw tooMany(
        'Too many bookings are waiting for payment from your network. Finish or cancel one, or try again in a few minutes.',
        'IP',
        limits.perIp,
      );
    }

    return {
      record: async (bookingId, holdExpiresAt) => {
        await tx.idempotencyRecord.create({
          data: { scope: ipScope, key: bookingId, status: 'HOLD', expiresAt: holdExpiresAt },
        });
      },
    };
  }
}

function tooMany(message: string, limit: string, max: number): AppException {
  return new AppException(ErrorCodes.RATE_LIMITED, message, HttpStatus.TOO_MANY_REQUESTS, {
    limit,
    max,
  });
}
