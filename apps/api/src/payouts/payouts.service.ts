import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EventStatus, PayoutStatus, RefundStatus, Role } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';
import { PayoutSettingsService } from './payout-settings.service';
import { derivePayoutAccountState, type PayoutAccountState } from './payout-account-state';
import {
  calculateCurrencySettlement,
  type CurrencySettlement,
} from './currency-settlement.calculator';
import {
  allocateCurrencySettlement,
  allocatedNet,
  type AllocationDraft,
} from './payout-allocation';

/*
  Re-exported from here because this is where it has always been imported from. The definition
  moved to the calculator so the arithmetic and its result shape live together.
*/
export type { CurrencySettlement } from './currency-settlement.calculator';

/**
 * Payouts that still stand, and so mark revenue as settled.
 *
 * A FAILED payout paid nothing, so the revenue it covered is still owed and must be picked up
 * by the next one. Counting it here would move the cursor past money nobody received.
 */
const STANDING_PAYOUT_STATUSES = [
  PayoutStatus.PENDING,
  PayoutStatus.SCHEDULED,
  PayoutStatus.PAID,
] as const;

/** Where an event's own payouts stopped, for one currency — revenue an org-wide payout skips. */
interface EventSettled {
  eventId: string;
  currency: string;
  until: Date;
}

/**
 * An event whose revenue is finished but not yet releasable, and when it will be.
 *
 * Reported rather than silently dropped: "there is no new revenue to settle" is a lie when
 * the organizer can see the sales on their dashboard, and an organizer who is not told why
 * opens a support ticket instead.
 */
export interface HeldRevenue {
  eventId: string;
  eventTitle: string;
  currency: string;
  grossMinor: number;
  /** When the hold expires: the last session's end plus PAYOUT_HOLD_DAYS. */
  payableFrom: Date;
}

/** One currency's finance picture. Currencies never combine. */
export interface PayoutSummaryCurrency {
  currency: string;
  gross: number;
  discount: number;
  bookingFee: number;
  paymentFee: number;
  organizerFee: number;
  refund: number;
  /** What a payout raised right now would come to. May be negative. */
  net: number;
  /** Already paid out, from Payout rows in PAID. */
  paid: number;
  /** Committed but not yet paid, from Payout rows in PENDING or SCHEDULED. */
  pending: number;
  /** Revenue that exists and is not yet eligible. */
  held: number;
}

/** The organizer's money, read only. See `PayoutsService.summary`. */
export interface PayoutSummary {
  organizationId: string;
  eventId: string | null;
  asOf: string;
  holdDays: number;
  currencies: PayoutSummaryCurrency[];
  /**
   * Money this summary deliberately does NOT account for.
   *
   * ── WHY A FINANCE SCREEN HAS TO SAY THIS ───────────────────────────────────────
   * Events whose money a provider transfer has already claimed are excluded from every figure
   * here, which is correct - counting them would pay the same revenue twice. But for an
   * organization settled mainly through a connected provider, the honest consequence is that
   * these totals understate what they have earned, possibly to zero.
   *
   * A finance page showing a confident zero to somebody who has been paid thousands is worse
   * than showing nothing. So the exclusion is reported rather than left to be inferred, and the
   * console says so in words.
   */
  excluded: {
    /** Events settled on the provider-transfer path and therefore absent from the figures. */
    providerSettledEvents: number;
  };
  heldRevenue: {
    eventId: string;
    eventTitle: string;
    currency: string;
    grossMinor: number;
    payableFrom: string;
  }[];
}

/**
 * Settlement statuses that have CLAIMED an event's money on the provider-transfer path.
 *
 * ── WHY THE TWO SYSTEMS HAVE TO KNOW ABOUT EACH OTHER ──────────────────────────────
 * This platform can pay an organizer two ways: this ledger, which records what is owed and
 * is settled by a bank transfer somebody makes by hand, and `Settlement`, which moves money
 * through Stripe or Razorpay Route. Nothing connected them. With both live, an event's
 * revenue could be transferred by the provider AND recorded as owed here, and the second
 * payment would look exactly like the first.
 *
 * Route is off by default, so today only this ledger runs — which is precisely when the
 * guard is cheap to add. Once money has moved through a provider, it is off the table here.
 *
 * ── WHY `REVERSED` IS HERE, WHICH LOOKS WRONG ──────────────────────────────────────
 * A reversed transfer means money went to the organizer and came back. The tempting reading is
 * that the organizer is now unpaid, so this ledger should pay them — and that reading is how an
 * ordinary partial refund could pay the same revenue twice.
 *
 * `REVERSED` says money came back. It does NOT say WHY. An administrative correction leaves the
 * organizer genuinely unpaid; a customer refund means the revenue no longer exists and nobody
 * should pay it again. The status cannot tell those apart, and the difference decides whether a
 * payment is owed or duplicated.
 *
 * So the default is the conservative one: a reversed event stays claimed, this ledger will not
 * pay it, and nobody is paid twice. The cost is that a genuinely unpaid organizer waits for a
 * person to say so — which is the right way round when the alternative is paying twice by
 * accident. Releasing it will require an explicit recorded disposition, never an inference from
 * provider status.
 */
export const SETTLEMENT_CLAIMED_STATUSES = [
  'TRANSFER_PROCESSING',
  'TRANSFERRED',
  'PARTIALLY_REFUNDED',
  'REVERSED',
];

/**
 * What one settlement pass produced: the money, and which bookings it is made of.
 *
 * Returned together deliberately. If a caller could obtain the totals without the allocations it
 * would be able to write a payout with no explanation, which is the state this work exists to
 * end.
 */
interface SettleResult {
  settlements: CurrencySettlement[];
  /** Keyed by the payout currency, case already folded as the calculator folds it. */
  allocations: Map<string, AllocationDraft[]>;
}

/** Everything `payableBookingWhere` needs, so the predicate has one definition. */
export interface PayableBookingScope {
  organizationId: string;
  eventId: string | undefined;
  eventFilter: Prisma.EventWhereInput;
  /** Events whose money a provider transfer has already claimed. */
  transferredEventIds: string[];
  /** Per-currency confirmation windows, already built by the caller. */
  bookingWindows: Prisma.BookingWhereInput[];
  eventSettled: EventSettled[];
}

/**
 * Which bookings a payout may settle.
 *
 * ── WHY THIS IS A FUNCTION AND NOT AN INLINE OBJECT ────────────────────────────────
 * It was written once, inline, inside the aggregate query - which was fine while only one query
 * needed it. Allocations need the SAME population read booking by booking, and the obvious way
 * to get there is a second query with the predicate written out again.
 *
 * That is the bug this project keeps finding: two expressions of one rule, edited in one place.
 * An eligibility predicate that drifts does not fail loudly; it quietly pays somebody for a
 * booking the aggregate never counted, or omits one it did.
 *
 * So there is one definition, and every reader of "which bookings settle" goes through it.
 * Extracting it changes no behaviour - the object produced is identical - and that is exactly
 * what makes a differential proof against the old path meaningful rather than circular.
 */
export function payableBookingWhere(scope: PayableBookingScope): Prisma.BookingWhereInput {
  return {
    organizationId: scope.organizationId,
    paymentMethod: 'ONLINE',
    ...(scope.eventId ? { eventId: scope.eventId } : {}),
    // The show has happened and the hold has expired, and no provider transfer has claimed this
    // event's money. Both rules are on the BOOKING's event, so an org-wide payout leaves out the
    // events that are not ready and settles the ones that are.
    event: scope.eventFilter,
    ...(scope.transferredEventIds.length > 0
      ? { eventId: { notIn: scope.transferredEventIds } }
      : {}),
    OR: scope.bookingWindows,
    ...(scope.eventSettled.length > 0
      ? {
          NOT: scope.eventSettled.map((s) => ({
            eventId: s.eventId,
            currency: s.currency,
            confirmedAt: { lte: s.until },
          })),
        }
      : {}),
  };
}

@Injectable()
export class PayoutsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    private readonly audit: AuditService,
    private readonly settings: PayoutSettingsService,
  ) {}

  /**
   * Which events' revenue may be paid out at `until`, as a Prisma filter.
   *
   * ── WHY MONEY WAITS FOR THE SHOW ───────────────────────────────────────────────────
   * The ledger had no time rule of any kind: revenue was settleable the moment a booking
   * was confirmed. An organizer could take the gate money for a festival three months out
   * and then not hold it, and a customer refunded after a payout is money the platform has
   * to chase back from somebody who already spent it. The provider-transfer path has always
   * held funds until the event completed; this makes the ledger agree with it, plus a few
   * days for refunds and disputes to surface.
   *
   * CANCELLED is excluded on purpose, and not because it is unfinished: that money is owed
   * back to customers, and paying it to the organizer is the one outcome nobody can undo.
   */
  private payableEventFilter(until: Date, holdDays: number): Prisma.EventWhereInput {
    const cutoff = new Date(until.getTime() - holdDays * 24 * 60 * 60 * 1000);
    return {
      status: { in: [EventStatus.COMPLETED, EventStatus.ARCHIVED] },
      // No session ending after the cutoff: the run is over AND the hold has expired. Written
      // as `none` rather than comparing a stored "last session" so an added date extends the
      // hold by itself.
      sessions: { none: { endsAt: { gt: cutoff } } },
    };
  }

  /**
   * Settlement figures for an org (optionally a single event), per currency, for the period
   * each currency has not yet been paid out for.
   *
   * ── WHY PER CURRENCY ───────────────────────────────────────────────────────────────
   * This summed every booking the organization ever took, whatever it was sold in, and the
   * payout it produced was stored in the schema's default currency. An organizer selling in
   * India and the US was shown — and would have been paid — rupees plus dollars as one number
   * of rupees. Money in different currencies cannot be added; each is settled on its own.
   *
   * ── WHY ONLINE ONLY, AND WHY THE DISCOUNT ─────────────────────────────────────────
   * A cash booking was paid across the venue's counter: the organizer already holds that money,
   * and paying it out again would pay them twice. And `subtotalMinor` is the price BEFORE any
   * coupon — the customer paid subtotal − discount for the tickets, so the discount has to come
   * off, exactly as `computeMarketplaceSplit` takes it off the organizer's net on each payment.
   *
   * ── WHY A PERIOD ──────────────────────────────────────────────────────────────────
   * This used to sum every confirmed booking ever, so once a payout was marked PAID the next
   * one paid the same revenue again. `settledUntil` says, per currency, where the last standing
   * payout stopped: bookings count if they were confirmed after that and up to `until`, and a
   * currency never paid out before counts from the beginning.
   *
   * Refunds count in the period they COMPLETED in, not the period of the booking they return.
   * A refund of revenue already paid out therefore comes off the next payout — which is the only
   * place left to recover it from. The Refund row has no completion timestamp of its own, so
   * `updatedAt` stands in for one: nothing writes to a refund after it becomes COMPLETED except
   * to move it to FAILED, which takes it out of this sum anyway. A later change that edits
   * completed refunds in place would silently move them between periods, and must add a
   * `completedAt` column instead.
   *
   * `eventSettled` is only non-empty for an org-wide payout: each event's revenue up to where
   * that event's own payouts stopped has been paid already, and is left out. See `generate`.
   *
   * Both queries go through Prisma's query API rather than raw SQL so that each currency's
   * window is one plain `where`, and the unit tests can hold the service to it.
   */
  /**
   * Which revenue is eligible to settle right now, and on what terms.
   *
   * ── WHY THIS IS SHARED ─────────────────────────────────────────────────────────────
   * Eligibility is four separate rules: where each currency's last payout stopped, where each
   * EVENT's own payouts stopped, which events a provider transfer has already claimed, and the
   * organization's hold terms. A read model that re-derived them would agree with the payout
   * ledger only until one of the four changed in one place and not the other - and the first
   * anybody would know is an organizer being told two different numbers by two screens.
   *
   * So the payout writer and the read-only summary both call this. It READS ONLY: no lock, no
   * writes, nothing claimed. The advisory lock stays in `raise`, because serialising generates is
   * a property of writing, not of asking.
   */
  private async settlementScope(
    client: Prisma.TransactionClient,
    organizationId: string,
    eventId: string | undefined,
  ): Promise<{
    /** Kept because `raise` needs it again for its duplicate-payout guard. */
    standing: {
      id: string;
      currency: string;
      status: PayoutStatus;
      eventId: string | null;
      periodEnd: Date | null;
      createdAt: Date;
    }[];
    settledUntil: Map<string, Date>;
    eventSettled: EventSettled[];
    transferredEventIds: string[];
    terms: Awaited<ReturnType<PayoutSettingsService['effectiveFor']>>;
  }> {
    const standing = await client.payout.findMany({
      where: {
        organizationId,
        status: { in: [...STANDING_PAYOUT_STATUSES] },
        // An event's revenue is covered by its own payouts and by org-wide ones; org-wide
        // revenue by every payout the organization has.
        ...(eventId ? { OR: [{ eventId }, { eventId: null }] } : {}),
      },
      select: {
        id: true,
        currency: true,
        status: true,
        eventId: true,
        periodEnd: true,
        createdAt: true,
      },
    });

    // Where each currency's settled revenue ends: the latest standing payout's period end.
    // A payout from before periods were recorded summed everything up to the moment it was
    // created, so its creation time is where it stopped.
    const settledUntil = new Map<string, Date>();
    const byEvent = new Map<string, EventSettled>();
    for (const payout of standing) {
      const end = payout.periodEnd ?? payout.createdAt;
      if (!end) continue;
      const currency = payout.currency.toUpperCase();
      if (eventId || payout.eventId === null) {
        const previous = settledUntil.get(currency);
        if (!previous || end > previous) settledUntil.set(currency, end);
      } else {
        const key = `${payout.eventId}|${currency}`;
        const previous = byEvent.get(key);
        if (!previous || end > previous.until) {
          byEvent.set(key, { eventId: payout.eventId, currency, until: end });
        }
      }
    }
    // An event payout that stopped before the last org-wide one is already inside its window.
    const eventSettled = [...byEvent.values()].filter((s) => {
      const orgWide = settledUntil.get(s.currency);
      return !orgWide || s.until > orgWide;
    });

    /*
      A period with neither revenue nor refunds produces no payout — a row of zeros is noise an
      admin has to open to discover it means nothing. A period whose refunds exceed its revenue
      DOES produce one, with a negative net: that is money to claw back from the organizer, and
      dropping it would quietly forgive the deduction rather than recover it.
    */
    /*
      Events whose money a provider transfer has already claimed. Read inside the same
      transaction as the sums, so a release that lands mid-generate cannot slip past it.
    */
    const transferred = await client.settlement.findMany({
      where: {
        organizationId,
        ...(eventId ? { eventId } : {}),
        status: { in: SETTLEMENT_CLAIMED_STATUSES as never[] },
      },
      select: { eventId: true },
    });
    const transferredEventIds = [...new Set(transferred.map((row) => row.eventId))];

    // The terms this organization settles on, read inside the transaction so a change made
    // while a generate is in flight cannot apply to half of it.
    const terms = await this.settings.effectiveFor(organizationId, client);

    return { standing, settledUntil, eventSettled, transferredEventIds, terms };
  }

  private async settle(
    client: Prisma.TransactionClient,
    organizationId: string,
    eventId: string | undefined,
    settledUntil: Map<string, Date>,
    eventSettled: EventSettled[],
    until: Date,
    /** Events whose money a provider transfer has already claimed. See the constant. */
    transferredEventIds: string[],
    holdDays: number,
  ): Promise<SettleResult> {
    const settledCurrencies = [...settledUntil.keys()];
    const bookingWindows: Prisma.BookingWhereInput[] = [
      ...[...settledUntil].map(([currency, after]) => ({
        currency,
        confirmedAt: { gt: after, lte: until },
      })),
      {
        ...(settledCurrencies.length > 0 ? { currency: { notIn: settledCurrencies } } : {}),
        confirmedAt: { lte: until },
      },
    ];
    const refundWindows: Prisma.RefundWhereInput[] = [
      ...[...settledUntil].map(([currency, after]) => ({
        booking: { currency },
        updatedAt: { gt: after, lte: until },
      })),
      {
        ...(settledCurrencies.length > 0
          ? { booking: { currency: { notIn: settledCurrencies } } }
          : {}),
        updatedAt: { lte: until },
      },
    ];

    const [paid, refunds] = await Promise.all([
      /*
        Read booking by booking, NOT as a database aggregate.

        The sums used to come back from `groupBy`, which was cheaper and told us nothing about
        WHICH bookings produced them - so a payout could not be explained afterwards. Allocations
        need those rows, and the tempting way to get them is a second query. That would be two
        expressions of one eligibility rule, and two expressions of one rule eventually disagree:
        somebody is paid for a booking the totals never counted.

        So there is one query, `payableBookingWhere`, and both the totals and the allocations are
        derived from its result. Proven equivalent to the aggregate it replaces in
        `booking-level-equivalence.integration-postgres.spec.ts` before this change was made.
      */
      client.booking.findMany({
        where: payableBookingWhere({
          organizationId,
          eventId,
          eventFilter: this.payableEventFilter(until, holdDays),
          transferredEventIds,
          bookingWindows,
          eventSettled,
        }),
        select: {
          id: true,
          eventId: true,
          currency: true,
          subtotalMinor: true,
          discountMinor: true,
          bookingFeeMinor: true,
          paymentFeeMinor: true,
          organizerFeeMinor: true,
        },
      }),
      // A refund has no currency of its own; it is in the currency of the booking it returns.
      client.refund.findMany({
        where: {
          organizationId,
          status: RefundStatus.COMPLETED,
          /*
            The same population as the revenue above. Deducting a refund for an event whose
            money is still held would claw back revenue this payout never included, leaving
            the organizer short by the refund and the ledger unable to explain why.
          */
          booking: {
            paymentMethod: 'ONLINE',
            ...(eventId ? { eventId } : {}),
            event: this.payableEventFilter(until, holdDays),
            ...(transferredEventIds.length > 0 ? { eventId: { notIn: transferredEventIds } } : {}),
          },
          OR: refundWindows,
          ...(eventSettled.length > 0
            ? {
                NOT: eventSettled.map((s) => ({
                  booking: { eventId: s.eventId, currency: s.currency },
                  updatedAt: { lte: s.until },
                })),
              }
            : {}),
        },
        /*
          ── WHOSE MONEY A REFUND RETURNS ──────────────────────────────────────────────
          The ledger used to deduct the WHOLE refund from the organizer. A refund returns
          the ticket money - which was the organizer's revenue - plus any tax that was ADDED
          on top of the price, which the platform collected and kept to remit. Charging that
          tax back to the organizer takes money they never received.

          Zero for an inclusive-tax market like India, where tax sits inside the ticket price
          and the whole refund really is the organizer's. That is why the old sum was right
          here and wrong everywhere the platform adds tax on top.
        */
        select: {
          amountMinor: true,
          taxAddedMinor: true,
          /*
            The booking's id and event, not only its currency: a refund has to be attributable to
            the booking it returns, or the allocation sum cannot account for it. Note the refund
            window is NOT the booking window - refunds are selected on `updatedAt` and revenue on
            `confirmedAt` - so this booking may legitimately be absent from `paid` above, and is
            then allocated as a pure clawback.
          */
          booking: { select: { id: true, eventId: true, currency: true } },
        },
      }),
    ]);

    /*
      The queries above decided WHICH rows settle; the arithmetic is `calculateCurrencySettlement`
      and the split is `allocateCurrencySettlement`. Both are given THE SAME rows, which is the
      only reason the allocation sum can be trusted to equal the payout - it is not a second
      derivation that happens to agree, it is the same numbers added up two ways.
    */
    // A refund has no currency of its own; it is in the currency of the booking it returns.
    const refundRows = refunds.map((row) => ({
      bookingId: row.booking.id,
      eventId: row.booking.eventId,
      currency: row.booking.currency,
      amountMinor: row.amountMinor,
      taxAddedMinor: row.taxAddedMinor ?? 0,
    }));

    return {
      settlements: calculateCurrencySettlement({ revenue: paid, refunds: refundRows }),
      allocations: allocateCurrencySettlement({ bookings: paid, refunds: refundRows }),
    };
  }

  /**
   * Revenue that exists, is not yet payable, and when it will be.
   *
   * Only reached when a generate found nothing, so it costs nothing on the normal path. It
   * answers the organizer's actual question - "where is my money" - with the event, the
   * amount and a date, rather than a refusal they have to ask somebody about.
   */
  private async heldRevenue(
    client: Prisma.TransactionClient,
    organizationId: string,
    eventId: string | undefined,
    until: Date,
    transferredEventIds: string[],
    holdDays: number,
  ): Promise<HeldRevenue[]> {
    const holdMs = holdDays * 24 * 60 * 60 * 1000;
    const rows = await client.booking.groupBy({
      by: ['eventId', 'currency'],
      where: {
        organizationId,
        paymentMethod: 'ONLINE',
        ...(eventId ? { eventId } : {}),
        confirmedAt: { lte: until },
        // Everything the payable filter above leaves out, minus the events that are simply
        // not going ahead: a cancelled show owes refunds, not a payout, and listing it as
        // "held" would promise money that is never coming.
        NOT: { event: this.payableEventFilter(until, holdDays) },
        event: { status: { not: EventStatus.CANCELLED } },
        ...(transferredEventIds.length > 0 ? { eventId: { notIn: transferredEventIds } } : {}),
      },
      _sum: { subtotalMinor: true },
    });
    if (rows.length === 0) return [];

    const events = await client.event.findMany({
      where: { id: { in: [...new Set(rows.map((row) => row.eventId))] } },
      select: {
        id: true,
        title: true,
        sessions: { select: { endsAt: true }, orderBy: { endsAt: 'desc' }, take: 1 },
      },
    });
    const byId = new Map(events.map((event) => [event.id, event]));

    return rows
      .map((row) => {
        const event = byId.get(row.eventId);
        const lastEnd = event?.sessions[0]?.endsAt;
        return {
          eventId: row.eventId,
          eventTitle: event?.title ?? row.eventId,
          currency: row.currency.toUpperCase(),
          grossMinor: row._sum.subtotalMinor ?? 0,
          // No session at all should not be possible for a booked event; treated as "not yet"
          // rather than "payable now", because the safe answer to an unknown end is to wait.
          payableFrom: new Date((lastEnd ? lastEnd.getTime() : until.getTime()) + holdMs),
        };
      })
      .filter((row) => row.grossMinor !== 0)
      .sort((a, b) => a.payableFrom.getTime() - b.payableFrom.getTime());
  }

  /**
   * One payout per currency the scope has unsettled money in.
   *
   * Returns the payouts created — none when there is nothing to settle, or when every
   * currency in scope already has an open payout. The duplicate guard is per currency: an
   * open rupee payout does not stop the dollar revenue from being settled.
   */
  async generate(user: RequestUser, organizationId: string, eventId?: string) {
    // The same people who may read payouts (see listForOrg). The route's @Roles only checks a
    // global role, so without this any member of the organization — check-in staff included —
    // could raise a payout and read the revenue figures it returns.
    await this.access.assertMember(user, organizationId, [
      Role.ORGANIZER_OWNER,
      Role.ORGANIZER_MANAGER,
    ]);
    return this.raise(organizationId, eventId, { actorUserId: user.id, scheduledFor: null });
  }

  /**
   * What this organization is owed, has been paid, and is still waiting on - read only.
   *
   * ── WHY THIS CANNOT JUST SUM BOOKINGS ──────────────────────────────────────────────
   * "What am I owed" is not a sum over bookings. It is a sum over the bookings that are ELIGIBLE,
   * and eligibility is four rules: where each currency's last payout stopped, where each event's
   * own payouts stopped, which events a provider transfer has already claimed, and the hold
   * terms. Re-deriving those for a read screen is how a finance page ends up disagreeing with the
   * payout ledger. This calls `settlementScope` and `settle` - the same two the payout writer
   * calls - and then `calculateCurrencySettlement`, which is the only settlement arithmetic there
   * is.
   *
   * ── IT IS OBSERVATIONAL, AND THAT IS A GUARANTEE ───────────────────────────────────
   * Opening a finance screen must not move money. Nothing here writes: no payout is created, no
   * status changes, no revenue is claimed, no provider is contacted, no hold is altered. It takes
   * no advisory lock either - serialising is a property of writing. The transaction is read-only
   * and exists so the four eligibility reads and the sums see one consistent snapshot.
   *
   * ── WHAT EACH NUMBER MEANS ─────────────────────────────────────────────────────────
   *   gross/discount/bookingFee/paymentFee/organizerFee/refund/net
   *       `calculateCurrencySettlement` over the eligible, not-yet-settled window. This is what a
   *       payout raised right now would contain.
   *   paid
   *       Payout rows already PAID. Historical fact, not a projection.
   *   pending
   *       Payout rows standing but not yet paid (PENDING/SCHEDULED): money committed to the
   *       organizer that has not left yet.
   *   held
   *       Revenue that exists and is not yet eligible, with the date it becomes so. Excludes
   *       cancelled events, which owe refunds rather than a payout.
   *
   * `net` can be negative when a period's refunds exceed its sales. That is a real balance owed
   * back and is reported as it stands rather than clamped.
   */
  async summary(
    user: RequestUser,
    organizationId: string,
    eventId?: string,
  ): Promise<PayoutSummary> {
    // The same membership rule as reading payouts and generating them. Check-in staff are not
    // shown an organization's money.
    await this.access.assertMember(user, organizationId, [
      Role.ORGANIZER_OWNER,
      Role.ORGANIZER_MANAGER,
    ]);

    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const scope = await this.settlementScope(tx, organizationId, eventId);
      const [eligible, held, payouts] = await Promise.all([
        // The summary reads money; allocations are only written when a payout is.
        this.settle(
          tx,
          organizationId,
          eventId,
          scope.settledUntil,
          scope.eventSettled,
          now,
          scope.transferredEventIds,
          scope.terms.holdDays,
        ).then((result) => result.settlements),
        this.heldRevenue(
          tx,
          organizationId,
          eventId,
          now,
          scope.transferredEventIds,
          scope.terms.holdDays,
        ),
        tx.payout.findMany({
          where: {
            organizationId,
            ...(eventId ? { OR: [{ eventId }, { eventId: null }] } : {}),
            status: { in: [...STANDING_PAYOUT_STATUSES] },
          },
          select: { currency: true, netMinor: true, status: true },
        }),
      ]);

      /*
        Every currency any of the three sources mentions, so a currency that is only paid, or only
        held, is not silently dropped from a finance screen.
      */
      const codes = new Set<string>([
        ...eligible.map((e) => e.currency),
        ...held.map((h) => h.currency.toUpperCase()),
        ...payouts.map((p) => p.currency.toUpperCase()),
      ]);

      const currencies = [...codes].sort().map((currency) => {
        const settlement = eligible.find((e) => e.currency === currency);
        const mine = payouts.filter((p) => p.currency.toUpperCase() === currency);
        const sumWhere = (match: (status: PayoutStatus) => boolean) =>
          mine.filter((p) => match(p.status)).reduce((total, p) => total + p.netMinor, 0);
        return {
          currency,
          gross: settlement?.gross ?? 0,
          discount: settlement?.discount ?? 0,
          bookingFee: settlement?.bookingFee ?? 0,
          paymentFee: settlement?.paymentFee ?? 0,
          organizerFee: settlement?.organizerFee ?? 0,
          refund: settlement?.refund ?? 0,
          net: settlement?.net ?? 0,
          paid: sumWhere((status) => status === PayoutStatus.PAID),
          pending: sumWhere(
            (status) => status === PayoutStatus.PENDING || status === PayoutStatus.SCHEDULED,
          ),
          held: held
            .filter((h) => h.currency.toUpperCase() === currency)
            .reduce((total, h) => total + h.grossMinor, 0),
        };
      });

      return {
        organizationId,
        eventId: eventId ?? null,
        asOf: now.toISOString(),
        holdDays: scope.terms.holdDays,
        currencies,
        // Counted, not described: "3 events are settled elsewhere" is something a person can go
        // and check, and "some activity is excluded" is not.
        excluded: { providerSettledEvents: scope.transferredEventIds.length },
        heldRevenue: held.map((h) => ({
          eventId: h.eventId,
          eventTitle: h.eventTitle,
          currency: h.currency.toUpperCase(),
          grossMinor: h.grossMinor,
          payableFrom: h.payableFrom.toISOString(),
        })),
      };
    });
  }

  /**
   * Where this organization's payout setup stands, as one state.
   *
   * The facts are read here and interpreted by `derivePayoutAccountState`, which is the only
   * place that decides what a combination MEANS. The connect row is read directly rather than
   * through the payments module: these are six raw columns, not a second derivation, and the
   * interpretation they feed lives in exactly one function.
   *
   * Read only. Nothing about asking changes an account.
   */
  async accountState(
    user: RequestUser,
    organizationId: string,
  ): Promise<PayoutAccountState & { organizationId: string }> {
    await this.access.assertMember(user, organizationId, [
      Role.ORGANIZER_OWNER,
      Role.ORGANIZER_MANAGER,
    ]);

    const [bankAccounts, connectRow] = await Promise.all([
      this.prisma.organizerPayoutAccount.findMany({
        where: { organizationId },
        select: { currency: true, verifiedAt: true },
      }),
      this.prisma.organizerPaymentAccount.findFirst({
        where: { organizationId },
        select: {
          providerAccountId: true,
          onboardingStatus: true,
          detailsSubmitted: true,
          chargesEnabled: true,
          payoutsEnabled: true,
          requirementsDue: true,
          disabledReason: true,
        },
      }),
    ]);

    const state = derivePayoutAccountState({
      bankAccounts,
      connect: connectRow
        ? {
            hasAccount: Boolean(connectRow.providerAccountId),
            onboardingStatus: connectRow.onboardingStatus,
            detailsSubmitted: connectRow.detailsSubmitted,
            chargesEnabled: connectRow.chargesEnabled,
            payoutsEnabled: connectRow.payoutsEnabled,
            requirementsDue: connectRow.requirementsDue,
            disabledReason: connectRow.disabledReason,
          }
        : null,
    });
    return { organizationId, ...state };
  }

  /**
   * The settlement run raising a payout with nobody at a keyboard.
   *
   * ── WHY IT SHARES EVERY LINE WITH THE MANUAL PATH ──────────────────────────────────
   * An automatic settlement that computed money differently from the one an organizer
   * raises by hand would be two ledgers wearing one name. The only differences are that
   * there is no member to check (the platform is acting, and it is audited as the platform)
   * and that what it writes is SCHEDULED with the date of the payment run it belongs to.
   *
   * PENDING means "somebody raised this and is dealing with it". SCHEDULED means "the
   * platform raised this and it is queued for the run on `scheduledAt`". Finance reads the
   * difference; the status has been in the schema since the beginning with nothing writing it.
   */
  async generateAutomatically(organizationId: string, scheduledFor: Date) {
    return this.raise(organizationId, undefined, { actorUserId: null, scheduledFor });
  }

  private async raise(
    organizationId: string,
    eventId: string | undefined,
    run: { actorUserId: string | null; scheduledFor: Date | null },
  ) {
    /*
      ── ONE GENERATE AT A TIME, AND BOTH SCOPES READ TOGETHER ──────────────────────────
      Two requests arriving together each read "no open payout" and each created one: the same
      revenue twice. The advisory lock serialises generates for the organization, whichever
      scope they are for, until the payouts are written.

      An org-wide payout and an event's own payout overlap — the org-wide one covers every event.
      Each scope's cursor used to ignore the other, so an org-wide payout followed by an event
      payout (or the reverse) paid that event's revenue twice. Now an event's cursor starts after
      whichever of the two stopped later; an org-wide payout leaves out each event's revenue up to
      where that event's own payouts stopped; and an open payout in either scope blocks the other,
      so a payout that fails is dealt with before an overlapping one can be raised on top of it.
    */
    const written = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payout-generate:${organizationId}`}))`;
      // Taken after the lock, so a generate that waited starts where the one before it stopped.
      const now = new Date();
      // Eligibility is four rules and both the writer and the read model must use the same four.
      const { standing, settledUntil, eventSettled, transferredEventIds, terms } =
        await this.settlementScope(tx, organizationId, eventId);
      const settled = await this.settle(
        tx,
        organizationId,
        eventId,
        settledUntil,
        eventSettled,
        now,
        transferredEventIds,
        terms.holdDays,
      );
      const { allocations } = settled;
      const settlements = settled.settlements.filter((s) => s.gross !== 0 || s.refund !== 0);
      if (settlements.length === 0) {
        /*
          "No new revenue" is the wrong answer when there IS revenue and it is simply not due
          yet. The organizer can see those sales on their dashboard, so a flat refusal reads
          as a bug and arrives as a support ticket. Name the events and the date instead.
        */
        const held = await this.heldRevenue(
          tx,
          organizationId,
          eventId,
          now,
          transferredEventIds,
          terms.holdDays,
        );
        if (held.length > 0) {
          const soonest = held.reduce((a, b) => (a.payableFrom <= b.payableFrom ? a : b));
          throw new AppException(
            ErrorCodes.CONFLICT,
            `This revenue is held until each event has finished. The next ${
              held.length === 1 ? 'event becomes' : 'of them becomes'
            } payable on ${soonest.payableFrom.toISOString().slice(0, 10)}.`,
            HttpStatus.CONFLICT,
            { held },
          );
        }
        throw new AppException(
          ErrorCodes.CONFLICT,
          'There is no new paid revenue to settle.',
          HttpStatus.CONFLICT,
        );
      }

      /*
        ── TOO SMALL TO BANK ──────────────────────────────────────────────────────────────
        A minimum stops the ledger raising a payout whose bank charge costs more than the
        money in it. It applies only to a POSITIVE net: a period that owes money back to the
        platform is recorded whatever its size, because a clawback nobody recorded is a
        clawback nobody collects.

        The revenue is not lost. Nothing marks it settled, so it rolls into the next payout.
      */
      const belowMinimum = settlements.filter((s) => {
        const minimum = terms.minPayoutMinor[s.currency] ?? 0;
        return s.net > 0 && s.net < minimum;
      });
      const overMinimum = settlements.filter((s) => !belowMinimum.includes(s));
      if (overMinimum.length === 0) {
        const smallest = belowMinimum[0];
        throw new AppException(
          ErrorCodes.CONFLICT,
          `This settlement is below the minimum payout for ${smallest.currency}. It stays with the next one.`,
          HttpStatus.CONFLICT,
          {
            belowMinimum: belowMinimum.map((s) => ({
              currency: s.currency,
              netMinor: s.net,
              minimumMinor: terms.minPayoutMinor[s.currency] ?? 0,
            })),
          },
        );
      }

      // Guard against duplicate payouts: only one open (PENDING/SCHEDULED) payout may cover a
      // currency's revenue at a time, in this scope or an overlapping one. Together with the
      // settled cursor above and the atomic markPaid guard below, the same revenue is never paid
      // out twice.
      const open = standing.filter(
        (payout) =>
          payout.status === PayoutStatus.PENDING || payout.status === PayoutStatus.SCHEDULED,
      );
      const openCurrencies = new Set(open.map((payout) => payout.currency.toUpperCase()));
      const due = overMinimum.filter((s) => !openCurrencies.has(s.currency));
      if (due.length === 0) {
        throw new AppException(
          ErrorCodes.CONFLICT,
          'An open payout already covers every currency in this scope; finalize it before generating another.',
          HttpStatus.CONFLICT,
          { payoutIds: open.map((payout) => payout.id) },
        );
      }

      const rows = [];
      for (const s of due) {
        const periodStart = settledUntil.get(s.currency) ?? null;

        /*
          ── THE GATE ────────────────────────────────────────────────────────────────────
          The allocations must account for the payout EXACTLY. Integer minor units on both
          sides, so there is nothing to round and no tolerance to justify.

          A mismatch means our own ledger disagreed with itself. The only safe response is to
          write nothing: a payout whose explanation does not add up is worse than one with no
          explanation, because it looks like evidence. The throw rolls the transaction back, so
          neither the payout nor its allocations survive.
        */
        const drafts = allocations.get(s.currency) ?? [];
        const allocated = allocatedNet(drafts);
        if (allocated !== s.net) {
          throw new AppException(
            ErrorCodes.PAYOUT_ALLOCATION_MISMATCH,
            'This payout could not be explained by the bookings it was built from, so it was not created.',
            HttpStatus.INTERNAL_SERVER_ERROR,
            {
              organizationId,
              currency: s.currency,
              netMinor: s.net,
              allocatedNetMinor: allocated,
              allocationCount: drafts.length,
            },
          );
        }

        const payout = await tx.payout.create({
          data: {
            organizationId,
            eventId,
            currency: s.currency,
            periodStart,
            periodEnd: now,
            grossMinor: s.gross,
            bookingFeeMinor: s.bookingFee,
            paymentFeeMinor: s.paymentFee,
            refundMinor: s.refund,
            netMinor: s.net,
            /*
              A settlement run writes SCHEDULED with the date of the payment run it belongs
              to; a person raising one by hand writes PENDING. That is the whole distinction
              the status was carrying, and until the run existed nothing ever wrote it.
            */
            status: run.scheduledFor ? PayoutStatus.SCHEDULED : PayoutStatus.PENDING,
            scheduledAt: run.scheduledFor,
            /*
              Stamped as this payout is written, which is what separates "no allocations because
              it predates them" from "no allocations because something went wrong". Never read the
              absence of allocations as proof that no payout covers an event.
            */
            allocatedFrom: now,
          },
        });

        // Same transaction as the payout: there is no state where one exists without the other.
        if (drafts.length > 0) {
          await tx.payoutAllocation.createMany({
            data: drafts.map((draft: AllocationDraft) => ({
              payoutId: payout.id,
              bookingId: draft.bookingId,
              eventId: draft.eventId,
              currency: draft.currency,
              allocatedNetMinor: draft.allocatedNetMinor,
              subtotalMinor: draft.subtotalMinor,
              discountMinor: draft.discountMinor,
              organizerFeeMinor: draft.organizerFeeMinor,
              refundShareMinor: draft.refundShareMinor,
              bookingFeeMinor: draft.bookingFeeMinor,
              paymentFeeMinor: draft.paymentFeeMinor,
            })),
          });
        }
        rows.push({ payout, settlement: s, periodStart, periodEnd: now });
      }
      return rows;
    });

    // Recorded once the payouts are committed, so the log never names a payout that rolled back.
    for (const { payout, settlement, periodStart, periodEnd } of written) {
      await this.audit.record({
        // Null for a settlement run: nobody pressed anything, and naming a person would be
        // a lie the next time somebody reads the log to find out who decided this.
        actorUserId: run.actorUserId,
        organizationId,
        action: 'PAYOUT_GENERATED',
        entityType: 'Payout',
        entityId: payout.id,
        metadata: {
          netMinor: settlement.net,
          currency: settlement.currency,
          periodStart: periodStart?.toISOString() ?? null,
          periodEnd: periodEnd.toISOString(),
        },
      });
    }
    return written.map(({ payout }) => payout);
  }

  async listForOrg(user: RequestUser, organizationId: string) {
    // Settlement figures are financial data: restrict to org owners/managers. CHECKIN_STAFF,
    // other members and platform staff who are not members must not read revenue/payout
    // amounts here; staff read payouts through /admin/payouts.
    await this.access.assertMember(user, organizationId, [
      Role.ORGANIZER_OWNER,
      Role.ORGANIZER_MANAGER,
    ]);
    return this.prisma.payout.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async adminList() {
    return this.prisma.payout.findMany({
      orderBy: { createdAt: 'desc' },
      include: { organization: { select: { name: true } } },
    });
  }

  async markPaid(
    admin: RequestUser,
    payoutId: string,
    evidence: { reference?: string | null; note?: string | null } = {},
  ) {
    const payout = await this.prisma.payout.findUnique({ where: { id: payoutId } });
    if (!payout)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Payout not found.', HttpStatus.NOT_FOUND);

    // Atomic finalize: only an un-paid payout can be marked PAID, so the same
    // payout can never be paid twice (idempotent under concurrent admins).
    const claim = await this.prisma.payout.updateMany({
      where: { id: payoutId, status: { in: [PayoutStatus.PENDING, PayoutStatus.SCHEDULED] } },
      data: {
        status: PayoutStatus.PAID,
        paidAt: new Date(),
        /*
          The bank's own reference for the transfer. A payout marked PAID with nothing to
          point at cannot be reconciled against a statement, which is the one thing anybody
          has to do with it afterwards. Optional, because a correction posted by hand may
          genuinely have none and refusing would leave money paid and the ledger disagreeing.
        */
        paidReference: trimmed(evidence.reference),
        note: trimmed(evidence.note),
        // A payout that failed and was retried successfully must not keep the old reason.
        failureReason: null,
      },
    });
    if (claim.count !== 1) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `Payout is already ${payout.status}.`,
        HttpStatus.CONFLICT,
      );
    }
    await this.audit.record({
      actorUserId: admin.id,
      organizationId: payout.organizationId,
      action: 'PAYOUT_PAID',
      entityType: 'Payout',
      entityId: payoutId,
      metadata: {
        netMinor: payout.netMinor,
        currency: payout.currency,
        paidReference: trimmed(evidence.reference),
      },
    });
    return this.prisma.payout.findUnique({ where: { id: payoutId } });
  }

  /**
   * Record that a payout did not reach the organizer.
   *
   * ── WHY THIS HAD TO EXIST ──────────────────────────────────────────────────────────
   * Nothing could write FAILED, so a returned bank transfer had no representation at all:
   * the ledger said the organizer had been paid while the money sat back in the platform's
   * account. The de-duplication cursor has always skipped FAILED payouts deliberately - the
   * revenue they cover is still owed - so that logic was unreachable, and marking a payout
   * failed is what makes the revenue roll into the next one by itself.
   *
   * A PAID payout can be failed too: that is exactly the case a bank return produces, and it
   * is the only honest way to record one. It is audited with the reason.
   */
  async markFailed(admin: RequestUser, payoutId: string, reason: string) {
    const trimmedReason = reason?.trim();
    if (!trimmedReason) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'Say why the payout failed. A failure with no reason cannot be acted on.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const payout = await this.prisma.payout.findUnique({ where: { id: payoutId } });
    if (!payout)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Payout not found.', HttpStatus.NOT_FOUND);

    const claim = await this.prisma.payout.updateMany({
      where: {
        id: payoutId,
        status: { in: [PayoutStatus.PENDING, PayoutStatus.SCHEDULED, PayoutStatus.PAID] },
      },
      data: { status: PayoutStatus.FAILED, failureReason: trimmedReason, paidAt: null },
    });
    if (claim.count !== 1) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `Payout is already ${payout.status}.`,
        HttpStatus.CONFLICT,
      );
    }
    await this.audit.record({
      actorUserId: admin.id,
      organizationId: payout.organizationId,
      action: 'PAYOUT_FAILED',
      entityType: 'Payout',
      entityId: payoutId,
      metadata: {
        netMinor: payout.netMinor,
        currency: payout.currency,
        previousStatus: payout.status,
        reason: trimmedReason,
      },
    });
    return this.prisma.payout.findUnique({ where: { id: payoutId } });
  }
}

/** Free text as it should be stored: trimmed, and absent rather than empty. */
function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}
