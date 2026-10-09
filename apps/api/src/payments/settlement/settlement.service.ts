import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma, type Settlement } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import {
  NotificationType,
  PaymentStatus,
  SettlementStatus,
  canTransitionSettlement,
  computeSettlementPayable,
  confirmedTotalMinor,
  isReleasableSettlementStatus,
  reversibleMinor,
} from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { NotificationService } from '../../notifications/notification.service';
import { AppException, ErrorCodes } from '../../common/errors';
import type { ReversalOutcome, TransferOutcome } from '../provider/payment-provider.interface';
import { redactProviderError } from '../provider/reversal-outcome';
import {
  reconcileTransferEvidence,
  type TransferEvidence,
  type ReconciliationOutcome,
} from './transfer-evidence';
import type { RequestUser } from '../../common/decorators';
import type { PaymentProvider } from '../provider/payment-provider.interface';
import { PaymentProviderResolver } from '../provider/payment-provider.resolver';
import { groupScopeWhere, type GroupScope } from '../../admin/group-scope';
import { countryWhere } from '../../admin/country-filter';
import { allOf, dayRangeWhere } from '../../admin/list-filters';

const DEFAULT_CURRENCY = 'usd';

/** Payments whose money was captured, whatever has been refunded from them since. */
const CAPTURED_PAYMENT_STATUSES = [
  PaymentStatus.SUCCEEDED,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
];

/**
 * Settlement lifecycle (Separate Charges & Transfers). Organizer proceeds are HELD until
 * the event completes and are only moved by an authorised, idempotent release that
 * recomputes the payable amount immediately before the Stripe transfer. Refund/dispute
 * deductions are applied by the refund/dispute flows (M6) which adjust refundsMinor/
 * disputesMinor and, when funds already moved, reverse the transfer.
 */
@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly config: ConfigService,
    private readonly resolver: PaymentProviderResolver,
  ) {}

  /** The transfer-capable adapter for a settlement's provider (Stripe or Razorpay). */
  private adapterFor(provider: string): PaymentProvider {
    return this.resolver.get(provider);
  }

  /** Reserve basis points, per provider (Stripe uses its own key; Razorpay reuses it). */
  private reserveBps(): number {
    return this.config.get<number>('STRIPE_SETTLEMENT_RESERVE_BPS') ?? 0;
  }

  /**
   * Ensure the event's settlement exists and its gross ledger reflects the current
   * successful payments. Called on payment success (ledger accrual) and on event
   * completion (HELD → ELIGIBLE). Links each successful payment to the settlement.
   */
  async syncForEvent(eventId: string): Promise<{ id: string } | null> {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true, organizationId: true, status: true },
    });
    if (!event) return null;

    /*
      Aggregate the organizer's eligible proceeds + platform fees from every CAPTURED payment,
      including those since refunded in part or in full.

      Gross is what was sold; refunds are deducted separately through `refundsMinor`. Reading
      SUCCEEDED only dropped a refunded payment out of gross while its refund was still in
      `refundsMinor`, so the same refund was deducted twice.
    */
    const paid = await this.prisma.payment.findMany({
      where: { status: { in: CAPTURED_PAYMENT_STATUSES }, booking: { eventId } },
      select: {
        id: true,
        organizerNetMinor: true,
        platformFeeMinor: true,
        currency: true,
        provider: true,
      },
    });
    const grossSalesMinor = paid.reduce((s, p) => s + p.organizerNetMinor, 0);
    const platformFeesMinor = paid.reduce((s, p) => s + p.platformFeeMinor, 0);
    const currency = (paid[0]?.currency ?? DEFAULT_CURRENCY).toLowerCase();
    // Provider is derived from the actual payments (INR→razorpay, USD→stripe).
    const providerName = paid[0]?.provider ?? 'stripe';

    const account = await this.prisma.organizerPaymentAccount.findUnique({
      where: {
        organizationId_provider: { organizationId: event.organizationId, provider: providerName },
      },
      select: { id: true, providerAccountId: true },
    });

    const existing = await this.prisma.settlement.findUnique({
      where: { eventId_currency: { eventId, currency } },
    });

    // Event completed → at least ELIGIBLE (unless already further along or blocked).
    const eventComplete = event.status === 'COMPLETED';
    const nextStatus: SettlementStatus =
      existing && !['PENDING', 'HELD'].includes(existing.status)
        ? (existing.status as SettlementStatus)
        : eventComplete
          ? 'ELIGIBLE'
          : 'HELD';

    const settlement = await this.prisma.settlement.upsert({
      where: { eventId_currency: { eventId, currency } },
      create: {
        organizationId: event.organizationId,
        eventId,
        provider: providerName,
        currency,
        accountId: account?.id ?? null,
        connectedAccountId: account?.providerAccountId ?? null,
        grossSalesMinor,
        platformFeesMinor,
        status: nextStatus,
      },
      update: {
        provider: providerName,
        grossSalesMinor,
        platformFeesMinor,
        accountId: account?.id ?? null,
        connectedAccountId: account?.providerAccountId ?? null,
        status: nextStatus,
      },
    });

    // Link the event's captured payments to this settlement batch (idempotent).
    await this.prisma.payment.updateMany({
      where: {
        status: { in: CAPTURED_PAYMENT_STATUSES },
        booking: { eventId },
        settlementId: null,
      },
      data: { settlementId: settlement.id },
    });
    return { id: settlement.id };
  }

  /** Called (best-effort) when a payment succeeds so the ledger accrues immediately. */
  async onPaymentSucceeded(eventId: string): Promise<void> {
    try {
      await this.syncForEvent(eventId);
    } catch (err) {
      // Never block ticket issuance on settlement bookkeeping; the event-completion
      // sweep and admin view both re-sync.
      this.logger.warn(
        `Settlement accrual failed for event ${eventId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /** Sweep: mark settlements ELIGIBLE once their event has completed. */
  async promoteCompletedEvents(limit = 100): Promise<{ promoted: number }> {
    const held = await this.prisma.settlement.findMany({
      where: { status: { in: ['PENDING', 'HELD'] }, event: { status: 'COMPLETED' } },
      select: { eventId: true },
      take: limit,
    });
    for (const s of held) await this.syncForEvent(s.eventId);
    return { promoted: held.length };
  }

  // ─── Admin actions ───

  async list(
    filter: {
      status?: SettlementStatus;
      organizationId?: string;
      eventId?: string;
      page?: number;
      pageSize?: number;
      country?: string;
      from?: string;
      to?: string;
    } & GroupScope,
  ) {
    const page = filter.page ?? 1;
    const pageSize = Math.min(filter.pageSize ?? 25, 100);
    const created = dayRangeWhere(filter.from, filter.to);
    const where = {
      /*
        Spread first so an explicit `organizationId`/`eventId` filter, which this queue already
        had, WINS over a grouping that names the same column. The two are the same question asked
        twice and the narrower answer is the one already on screen.
      */
      ...groupScopeWhere('settlements', filter),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.organizationId ? { organizationId: filter.organizationId } : {}),
      ...(filter.eventId ? { eventId: filter.eventId } : {}),
      /*
        The console's market and day window, in `AND` because the group scope can also name
        `event` and a spread would erase it. A read filter only: it decides which rows are listed,
        never anything about a settlement's money or state.
      */
      AND: allOf(
        countryWhere('settlements', filter.country),
        created ? { createdAt: created } : null,
      ),
    };
    const [rows, total] = await Promise.all([
      this.prisma.settlement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { event: { select: { title: true } }, organization: { select: { name: true } } },
      }),
      this.prisma.settlement.count({ where }),
    ]);
    // `totalPages` too: the console pages with it, and without it the pager had nothing to show.
    return {
      data: rows,
      meta: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
    };
  }

  async get(id: string) {
    const settlement = await this.prisma.settlement.findUnique({
      where: { id },
      include: {
        event: { select: { title: true, status: true } },
        organization: { select: { name: true } },
        payments: {
          select: { id: true, amountMinor: true, organizerNetMinor: true, status: true },
        },
      },
    });
    if (!settlement)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Settlement not found.', HttpStatus.NOT_FOUND);
    return settlement;
  }

  private async transition(
    id: string,
    to: SettlementStatus,
    actor: RequestUser,
    extra: Record<string, unknown> = {},
  ) {
    const settlement = await this.prisma.settlement.findUnique({ where: { id } });
    if (!settlement)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Settlement not found.', HttpStatus.NOT_FOUND);
    if (!canTransitionSettlement(settlement.status as SettlementStatus, to)) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `Settlement cannot move from ${settlement.status} to ${to}.`,
        HttpStatus.CONFLICT,
      );
    }
    const updated = await this.prisma.settlement.update({
      where: { id },
      data: { status: to, ...extra },
    });
    await this.audit.record({
      actorUserId: actor.id,
      organizationId: settlement.organizationId,
      action: `SETTLEMENT_${to}`,
      entityType: 'Settlement',
      entityId: id,
      metadata: { from: settlement.status, to },
    });
    return updated;
  }

  /**
   * Revert a release that was claimed (TRANSFER_PROCESSING) but cannot proceed (e.g.
   * Razorpay Route disabled / no linked account) → BLOCKED with a clear reason. No fake
   * transfer, no FAILED (this is a policy hold, not a transfer failure).
   */
  /**
   * Whether this platform may send money to organizers at all.
   *
   * Default OFF, and deliberately separate from everything about selling tickets. A controlled
   * launch wants customers buying while payouts stay manual, and that separation has to be one
   * explicit switch rather than an emergent property of which provider happens to be configured.
   */
  private get payoutExecutionEnabled(): boolean {
    const raw = this.config.get<string | boolean>('PAYOUT_EXECUTION_ENABLED');
    return raw === true || raw === 'true';
  }

  private async blockClaimed(
    actor: RequestUser,
    settlement: { id: string; organizationId: string },
    reason: string,
  ): Promise<never> {
    await this.prisma.settlement.update({
      where: { id: settlement.id },
      data: { status: 'BLOCKED', blockedReason: reason },
    });
    await this.audit.record({
      actorUserId: actor.id,
      organizationId: settlement.organizationId,
      action: 'SETTLEMENT_BLOCKED',
      entityType: 'Settlement',
      entityId: settlement.id,
      metadata: { reason },
    });
    throw new AppException(ErrorCodes.CONFLICT, reason, HttpStatus.CONFLICT);
  }

  approve(actor: RequestUser, id: string) {
    return this.transition(id, 'APPROVED', actor, { approvedByUserId: actor.id });
  }

  block(actor: RequestUser, id: string, reason: string) {
    return this.transition(id, 'BLOCKED', actor, { blockedReason: reason });
  }

  /**
   * Release an approved settlement: recompute the payable amount immediately before the
   * transfer, then move funds to the connected account. Idempotent — an atomic
   * APPROVED/FAILED → TRANSFER_PROCESSING claim ensures a single release, and the Stripe
   * idempotency key prevents a duplicate transfer even under a double call.
   */
  async release(actor: RequestUser, id: string, note?: string) {
    const settlement = await this.prisma.settlement.findUnique({ where: { id } });
    if (!settlement)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Settlement not found.', HttpStatus.NOT_FOUND);
    if (settlement.status === 'TRANSFERRED') {
      return settlement; // already released — idempotent no-op
    }
    if (!isReleasableSettlementStatus(settlement.status as SettlementStatus)) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `Settlement must be APPROVED before release (is ${settlement.status}).`,
        HttpStatus.CONFLICT,
      );
    }

    /*
      PAYOUT EXECUTION KILL SWITCH
      ----------------------------
      One switch that stops money leaving for organizers, whatever the provider, and WITHOUT
      touching ticket sales. Customers can keep buying, entitlement keeps accruing, Finance keeps
      showing what is owed - only the outbound transfer is refused.

      The gate that existed before this was `RAZORPAY_ROUTE_ENABLED`, which is provider-specific:
      a Stripe settlement had no payout-level switch at all, so an admin with PAYOUT_MANAGE could
      move real money with nothing but their own judgement in the way. For a controlled launch
      that is the wrong default.

      Refused BEFORE the atomic claim, and without changing the settlement, because "payouts are
      switched off" is a fact about the platform rather than something wrong with this
      settlement. Marking the row BLOCKED would conflate the two and leave a trail of blocked
      payouts that are not actually in trouble.
    */
    if (!this.payoutExecutionEnabled) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'Automatic payout execution is switched off on this platform, so no transfer was ' +
          'attempted. What the organizer is owed is unaffected and remains visible in Finance.',
        HttpStatus.CONFLICT,
      );
    }

    /*
      ── THE OTHER WAY AN ORGANIZER CAN ALREADY HAVE BEEN PAID ──────────────────────────
      This platform pays two ways: a provider transfer (here) and the `Payout` ledger, which
      records what is owed and is settled by a bank transfer somebody makes by hand. Nothing
      connected them, so an event's revenue could be transferred here AND recorded as owed
      there - and the second payment looks exactly like the first.

      A standing payout is a claim on this event's money: PENDING means somebody is about to
      transfer it by hand, PAID means they already have. Either way it is not ours to move
      again, so the release is refused with the payout named rather than blocked silently or
      transferred on top. An org-wide payout (`eventId: null`) covers every event the
      organization has, so it blocks this one too.

      Checked BEFORE the atomic claim below: a refusal must leave the settlement exactly as
      it was, not parked in TRANSFER_PROCESSING for an operator to unpick.
    */
    const claimedByLedger = await this.prisma.payout.findMany({
      where: {
        organizationId: settlement.organizationId,
        currency: settlement.currency,
        OR: [{ eventId: settlement.eventId }, { eventId: null }],
        status: { in: ['PENDING', 'SCHEDULED', 'PAID'] },
      },
      select: { id: true, status: true, eventId: true, netMinor: true },
    });
    if (claimedByLedger.length > 0) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'A payout already covers this revenue on the ledger. Settle or cancel it before releasing a transfer, or the organizer is paid twice.',
        HttpStatus.CONFLICT,
        { payoutIds: claimedByLedger.map((payout) => payout.id) },
      );
    }

    // Atomic claim so concurrent releases cannot both transfer.
    const claim = await this.prisma.settlement.updateMany({
      where: { id, status: { in: ['APPROVED', 'FAILED'] } },
      data: { status: 'TRANSFER_PROCESSING' },
    });
    if (claim.count !== 1) {
      const current = await this.prisma.settlement.findUnique({ where: { id } });
      return current!;
    }

    // Provider-specific pre-checks. For Razorpay, Route must be enabled AND a linked
    // account must exist — otherwise the settlement is BLOCKED with a clear reason
    // (never a fake transfer). Stripe has no such gate here.
    if (settlement.provider === 'razorpay') {
      const routeEnabled = this.config.get<boolean>('RAZORPAY_ROUTE_ENABLED') ?? false;
      if (!routeEnabled) {
        return this.blockClaimed(
          actor,
          settlement,
          'Razorpay Route is not enabled; organizer payout is on hold.',
        );
      }
      if (!settlement.connectedAccountId) {
        return this.blockClaimed(
          actor,
          settlement,
          'No active Razorpay linked account for this organizer.',
        );
      }
    }
    const adapter = this.adapterFor(settlement.provider);

    /*
      ── RETRYING A TRANSFER WHOSE OUTCOME WE DO NOT KNOW ──────────────────────────────
      `FAILED` is releasable so a lost write can be recovered. But `release()` writes FAILED for
      EVERY error - an authoritative refusal, a timeout, a connection reset - so a settlement in
      FAILED without a `providerTransferId` is not a settlement we know did not pay. It is one
      whose outcome we never learned, and the organizer may already have the money.

      Retrying that is safe only if a replayed request would be deduplicated by the provider.
      This codebase already decided how to express that: ADR-043 gates automatic void and refund
      execution on `supportsIdempotentVoid` / `supportsIdempotentRefund`. The same rule had never
      been applied to transfers - the operation that moves the largest amount.

      `supportsIdempotentTransfer` describes OUR adapter. The Razorpay adapter accepts
      `idempotencyKey` and sends `account`, `amount`, `currency` and `notes` - the identity is
      discarded, so a replay is a second transfer. It declares false for that reason, which is a
      fact about our code and not a claim about Razorpay's API.

      A first attempt is unaffected. Only a replay is gated, and the settlement is left BLOCKED
      with a reason rather than silently stuck, because resolving it needs a person to establish
      what the provider actually did. See docs/guides/PROVIDER-EXECUTION-AND-RECONCILIATION.md.
    */
    /*
      What makes a release a REPLAY is an earlier attempt whose outcome is still unknown - not
      merely a settlement sitting in FAILED. Those were the same thing until the adapter could
      report a refusal: every failure, authoritative or not, produced FAILED with no transfer id.

      Now a FAILED attempt means the provider declined WITHOUT acting, so the question is
      settled and a later release is an ordinary first attempt. Gating it would strand a payout
      the provider simply refused - a closed destination account, say - behind manual review
      forever, on every provider that cannot deduplicate.

      Settlements released before the attempt table existed have no rows at all. For those the
      old, coarser test is still the only evidence available, and it stays conservative.
    */
    const unresolvedAttempts = await this.prisma.settlementTransferAttempt.count({
      where: { settlementId: settlement.id, status: { in: ['UNKNOWN', 'REQUESTED'] } },
    });
    const anyAttempts = await this.prisma.settlementTransferAttempt.count({
      where: { settlementId: settlement.id },
    });
    const isReplay =
      unresolvedAttempts > 0 ||
      (anyAttempts === 0 && settlement.status === 'FAILED' && !settlement.providerTransferId);

    if (isReplay && !adapter.capabilities.supportsIdempotentTransfer) {
      return this.blockClaimed(
        actor,
        settlement,
        'A previous transfer attempt did not complete and its outcome is unknown. This provider ' +
          'cannot prove a repeated request would not pay twice, so the payout needs a person to ' +
          'confirm with the provider what happened.',
      );
    }

    // Recompute payable immediately before transfer (deduct refunds/disputes/prior/reserve).
    const payable = computeSettlementPayable({
      grossOrganizerNetMinor: settlement.grossSalesMinor,
      refundsMinor: settlement.refundsMinor,
      disputesMinor: settlement.disputesMinor,
      priorTransferredMinor: settlement.transferredMinor,
      reserveBps: this.reserveBps(),
    });

    // Nothing to move (fully refunded / already transferred): close it out cleanly.
    if (payable.payableMinor <= 0) {
      const done = await this.prisma.settlement.update({
        where: { id },
        data: {
          status: 'TRANSFERRED',
          reserveMinor: payable.reserveMinor,
          payableMinor: 0,
          releasedAt: new Date(),
        },
      });
      await this.audit.record({
        actorUserId: actor.id,
        organizationId: settlement.organizationId,
        action: 'SETTLEMENT_RELEASED_ZERO',
        entityType: 'Settlement',
        entityId: id,
        metadata: { note, reserveMinor: payable.reserveMinor },
      });
      return done;
    }

    if (!settlement.connectedAccountId || !adapter.createTransfer) {
      // Cannot transfer without a destination — revert to FAILED for ops.
      await this.prisma.settlement.update({
        where: { id },
        data: {
          status: 'FAILED',
          failureMessage: 'No connected account / provider transfer support.',
        },
      });
      throw new AppException(
        ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE,
        'This settlement has no connected account to receive the transfer.',
        HttpStatus.CONFLICT,
      );
    }

    const idempotencyKey = `settlement_${settlement.id}_${settlement.transferredMinor}`;

    /*
      ── THE SAME IDENTITY MUST MEAN THE SAME REQUEST ──────────────────────────────────
      The key is derived from the settlement and its prior transferred amount, so a replay
      presents the SAME identity - that is what makes recovery possible. But the AMOUNT is
      computed from `refundsMinor` and `disputesMinor` too, and those can move while a crashed
      attempt is being recovered. A refund landing in that window produces the same identity
      carrying a different amount.

      Nobody should have to know what a given provider does with that. Stripe rejects it;
      Razorpay's behaviour is unverified and is not guessed at here. So ETicketsGo refuses it
      itself: a changed amount is a DIFFERENT operation, and reusing the old identity for it
      would make the two indistinguishable to the provider and to us.
    */
    const priorAttempts = await this.prisma.settlementTransferAttempt.findMany({
      where: { settlementId: settlement.id, idempotencyKey },
      select: { id: true, requestedMinor: true, status: true },
    });
    const incompatible = priorAttempts.find((a) => a.requestedMinor !== payable.payableMinor);
    if (incompatible) {
      return this.blockClaimed(
        actor,
        settlement,
        `A previous attempt to pay out this settlement asked for a different amount ` +
          `(${incompatible.requestedMinor} vs ${payable.payableMinor}). Retrying would reuse one ` +
          `payment identity for two different requests, so this needs a person to confirm with ` +
          `the provider what was actually sent.`,
      );
    }

    /*
      Durable intent, COMMITTED before anything leaves this process - the same order the reversal
      path has used since it was built. If this process dies during the provider call, this row
      is the only thing that says ETicketsGo asked for money to move at all.
    */
    const attempt = await this.prisma.settlementTransferAttempt.create({
      data: {
        settlementId: settlement.id,
        requestedMinor: payable.payableMinor,
        currency: settlement.currency,
        provider: settlement.provider,
        destinationAccountId: settlement.connectedAccountId,
        idempotencyKey,
        status: 'REQUESTED',
      },
    });

    /*
      The provider call, with NO transaction open, in exactly the shape the reversal path uses.
      An adapter that throws rather than returning an outcome tells us nothing about whether it
      acted, so a throw becomes INDETERMINATE rather than a failure - a failure invites a retry
      of an operation that may have succeeded.
    */
    let outcome: TransferOutcome;
    try {
      outcome = await adapter.createTransfer!({
        amountMinor: payable.payableMinor,
        currency: settlement.currency,
        destinationAccountId: settlement.connectedAccountId,
        transferGroup: `etg_event_${settlement.eventId}`,
        // Deterministic key: a re-run of the same settlement release never double-pays.
        idempotencyKey,
        metadata: { settlementId: settlement.id, eventId: settlement.eventId },
      });
    } catch (err) {
      outcome = { kind: 'INDETERMINATE', raw: redactProviderError(err) };
    }

    /*
      WHAT THE ANSWER PROVED
      ----------------------
      A refusal the provider made BEFORE acting is now distinguishable from a timeout where it
      may have acted anyway. Those two must not share a record: one is safely retryable, the
      other is a question only the provider can answer.

      Exhausted deliberately. The compiler refuses a new outcome kind that nothing handles,
      which is what stops an answer being quietly discarded the way the old status field was.
    */
    if (outcome.kind === 'REFUSED' || outcome.kind === 'INDETERMINATE') {
      /*
        The discriminant has to be the condition itself, or TypeScript cannot narrow the union.

        An INDETERMINATE outcome still carries the cause in its redacted `raw`, and an operator
        reading this row needs it - "no usable answer" alone does not say whether to look at the
        network or at the provider. The redaction is what keeps keys and customer detail out.
      */
      const cause =
        outcome.kind === 'INDETERMINATE'
          ? ((outcome.raw as { message?: unknown } | null)?.message ?? '')
          : '';
      const message =
        outcome.kind === 'INDETERMINATE'
          ? `No usable answer from the provider; it may or may not have sent the money${
              typeof cause === 'string' && cause ? `: ${cause}` : '.'
            }`
          : `${outcome.code}: ${outcome.message}`;
      const indeterminate = outcome.kind === 'INDETERMINATE';

      await this.prisma.settlementTransferAttempt.update({
        where: { id: attempt.id },
        data: {
          /*
            REFUSED is authoritative - the provider declined without acting - so the attempt is
            FAILED and there is nothing for a reconciliation worker to resolve. INDETERMINATE
            keeps UNKNOWN, because the money may already be with the organizer and only the
            provider can settle the question.
          */
          status: indeterminate ? 'UNKNOWN' : 'FAILED',
          lastError: message.slice(0, 500),
          syncResponse: outcome.raw as never,
          respondedAt: new Date(),
        },
      });
      return this.failClaimed(actor, settlement, id, message);
    }

    try {
      const transfer = outcome;
      /*
        The release and the organizer being told about it, in one transaction.

        This was a bare `settlement.update` followed by a notification, and a payout is the
        one message an organizer definitely goes looking for: the money has left this
        platform, and if the notice is lost in the window between the two statements, nothing
        records that it was owed and nothing retries it. Wrapping it is the smallest change
        that makes the two facts inseparable.

        The transfer itself is NOT in here and cannot be -- it already happened, at the
        provider, above. What this transaction covers is the platform's own record of it and
        the notice about it, which is exactly the pair that must not come apart.
      */
      const released = await this.prisma.$transaction(async (tx) => {
        const row = await tx.settlement.update({
          where: { id },
          data: {
            status: 'TRANSFERRED',
            providerTransferId: transfer.transferId,
            reserveMinor: payable.reserveMinor,
            payableMinor: payable.payableMinor,
            /*
              An INCREMENT, not `snapshot + payable`. The atomic claim stops a second release
              racing this one, but it does not stop a REVERSAL: `reverseIfTransferred` gates on
              `providerTransferId`, not on status, so a refund arriving during an incremental
              release decrements `transferredMinor` while this transaction is in flight. An
              absolute write computed from the pre-transfer snapshot silently undid that
              decrement - money that had been clawed back reappeared as still held, breaking the
              very invariant below.
            */
            transferredMinor: { increment: payable.payableMinor },
            /*
              The other half of the schema invariant
              `transferredMinor == releasedMinor - Sum(confirmed reversals)`. Only the decrement
              was ever implemented, so this field sat at 0 for every row ever written, and the
              two readers that consume it fell through `releasedMinor || transferredMinor` on
              every call - not just for the pre-ledger rows that fallback was written for.

              That is not only a reporting gap. `reversibleMinor` clamps a claw-back to
              `released - Sum(confirmed)`, so with the fallback supplying a `transferredMinor`
              that confirmed reversals have ALREADY decremented, the confirmed total was
              subtracted twice and the second reversal of any settlement was silently refused.
              See docs/guides/SETTLEMENT-RELEASE-LIFECYCLE.md.

              It increments rather than assigns because a settlement can be released more than
              once - step 6 computes an incremental payable from `priorTransferredMinor`, and
              what went out cumulatively is the question this field answers.
            */
            releasedMinor: { increment: payable.payableMinor },
            releasedAt: new Date(),
            failureMessage: null,
          },
        });
        /*
          In the SAME transaction as the money. An attempt that says SUCCEEDED while the
          settlement does not, or the reverse, would be a disagreement invented by our own
          write ordering rather than by anything the provider did.
        */
        await tx.settlementTransferAttempt.update({
          where: { id: attempt.id },
          data: {
            status: 'SUCCEEDED',
            providerTransferId: transfer.transferId,
            respondedAt: new Date(),
          },
        });
        await this.notifyOrganizerInTransaction(tx, settlement.organizationId, {
          type: NotificationType.SETTLEMENT_RELEASED,
          settlementId: id,
          amountMinor: payable.payableMinor,
        });
        return row;
      });
      await this.audit.record({
        actorUserId: actor.id,
        organizationId: settlement.organizationId,
        action: 'SETTLEMENT_TRANSFERRED',
        entityType: 'Settlement',
        entityId: id,
        metadata: { transferId: transfer.transferId, amountMinor: payable.payableMinor, note },
      });
      return released;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Transfer failed.';
      /*
        THE PROVIDER ACCEPTED; OUR OWN PERSISTENCE DID NOT
        --------------------------------------------------
        Only reachable after an ACCEPTED outcome, so this is not the provider failing - it is us
        failing to record that it agreed. The money may well be moving.

        UNKNOWN therefore, and never FAILED. The SETTLEMENT keeps its coarse FAILED status,
        which is a true statement about this release not completing and whose meaning other code
        depends on; the attempt row is where the uncertainty lives.
      */
      await this.prisma.settlementTransferAttempt.update({
        where: { id: attempt.id },
        data: {
          status: 'UNKNOWN',
          lastError: message.slice(0, 500),
          respondedAt: new Date(),
        },
      });
      return this.failClaimed(actor, settlement, id, message);
    }
  }

  /**
   * Record that a release did not complete, and say so loudly.
   *
   * Shared by both ways that can happen - the provider declining or not answering, and our own
   * persistence failing after it agreed - so the audit trail and the admin notice cannot drift
   * apart between them. The ATTEMPT row is written by the caller, because only the caller knows
   * what the answer actually proved.
   */
  private async failClaimed(
    actor: RequestUser,
    settlement: { organizationId: string },
    id: string,
    message: string,
  ): Promise<never> {
    await this.prisma.settlement.update({
      where: { id },
      data: { status: 'FAILED', failureMessage: message.slice(0, 500) },
    });
    await this.audit.record({
      actorUserId: actor.id,
      organizationId: settlement.organizationId,
      action: 'SETTLEMENT_TRANSFER_FAILED',
      entityType: 'Settlement',
      entityId: id,
      metadata: { error: message },
    });
    await this.notifyAdmins({
      type: NotificationType.TRANSFER_FAILED,
      settlementId: id,
      error: message,
    });
    throw new AppException(
      ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE,
      `Settlement transfer failed: ${message}`,
      HttpStatus.BAD_GATEWAY,
    );
  }

  // ─── Refund / dispute deductions (driven by webhooks, M6) ───

  /**
   * Deduct an organizer's share of a refund from their settlement. If the settlement
   * has already been transferred, claw the amount back with a transfer reversal.
   * Idempotent per (settlement, providerRefundId) via the metadata guard in the caller.
   */
  async applyRefund(eventId: string, currency: string, organizerShareMinor: number): Promise<void> {
    if (organizerShareMinor <= 0) return;
    const settlement = await this.prisma.settlement.findUnique({
      where: { eventId_currency: { eventId, currency: currency.toLowerCase() } },
    });
    if (!settlement) return;

    await this.prisma.settlement.update({
      where: { id: settlement.id },
      data: { refundsMinor: { increment: organizerShareMinor } },
    });

    await this.reverseIfTransferred(
      settlement,
      organizerShareMinor,
      'refund',
      `reverse_${settlement.id}_${settlement.refundsMinor}`,
    );
  }

  /**
   * Funds already with the organizer → reverse the amount via the settlement's own provider
   * (Stripe or Razorpay Route). Moves money only; the caller has already recorded WHY in
   * `refundsMinor` or `disputesMinor`, and recording it in both would deduct it twice.
   */
  /**
   * Claw money back, recording what we asked for and what the provider proved.
   *
   * ── THE ORDER, AND WHY IT CANNOT BE ONE TRANSACTION ─────────────────────────
   * A database write and a provider HTTP call cannot be made atomic, and any design claiming
   * otherwise is wrong. What IS achievable is that every outcome - including a crash - leaves a
   * row somebody can find:
   *
   *   1. write the attempt as REQUESTED and COMMIT, before the provider is called
   *   2. call the provider, with no transaction open
   *   3. record what the answer proves
   *   4. move money ONLY on confirmed evidence
   *
   * This replaced a method that called the provider inside a try and, on failure, logged a line,
   * notified admins and returned normally - while `refundsMinor` had already been incremented.
   * The ledger said the money was deducted, the money was still with the organizer, and nothing
   * in the database recorded that an attempt had been made.
   *
   * ── CRASH WINDOWS ───────────────────────────────────────────────────
   *   before (1) commits  - nothing written; the refund webhook is not marked processed, so it
   *                         is redelivered.
   *   after (1), before (2) - a REQUESTED row the sweeper finds.
   *   DURING (2)          - a REQUESTED row, and the provider MAY have acted. The dangerous one,
   *                         and the reason such a row is never blindly retried: reconciliation
   *                         asks the provider what it did first.
   *   after (2), before (3) - the same, and why UNKNOWN has to exist as a state.
   *   after (3), before (4) - the attempt is COMPLETED and the settlement has not moved yet. The
   *                         money mutation is guarded on the attempt status, so completing it
   *                         later cannot double-count.
   */
  private async reverseIfTransferred(
    settlement: Settlement,
    amountMinor: number,
    reason: 'refund' | 'dispute',
    idempotencyKey: string,
    causeId?: string,
  ): Promise<void> {
    const adapter = this.adapterFor(settlement.provider);
    if (!adapter.reverseTransfer || !settlement.providerTransferId) return;

    /*
      Only money the organizer still holds may be asked for. `reversibleMinor` clamps against
      released minus what reversals have already CONFIRMED, so an attempt cannot be created for
      more than is outstanding - the invariant is enforced where the number is produced rather
      than checked afterwards.

      `releasedMinor` needs a fallback for settlements released before anything wrote it. The
      old one was a bare `|| transferredMinor`, and it was WRONG rather than merely approximate:
      `transferredMinor` is already net of confirmed reversals, so the clamp subtracted the
      confirmed total a second time and silently refused the second reversal of any settlement.

      Reconstructing it is exact arithmetic, not a guess from status. `transferredMinor` is
      whatever went out minus what has come back, so what went out is `transferredMinor` plus
      the confirmed total - both durable, both read right here.
      See docs/guides/SETTLEMENT-RELEASE-LIFECYCLE.md.
    */
    const prior = await this.prisma.settlementReversalAttempt.findMany({
      where: { settlementId: settlement.id },
      select: { status: true, requestedMinor: true, confirmedMinor: true },
    });
    const released =
      settlement.releasedMinor || settlement.transferredMinor + confirmedTotalMinor(prior as never);
    const reverseMinor = reversibleMinor(amountMinor, released, prior as never);
    if (reverseMinor <= 0) return;

    // 1. durable intent, committed before anything leaves this process.
    const attempt = await this.prisma.settlementReversalAttempt.create({
      data: {
        settlementId: settlement.id,
        reason: reason === 'refund' ? 'REFUND' : 'DISPUTE',
        refundId: reason === 'refund' ? (causeId ?? null) : null,
        disputeId: reason === 'dispute' ? (causeId ?? null) : null,
        requestedMinor: reverseMinor,
        currency: settlement.currency,
        provider: settlement.provider,
        idempotencyKey,
        status: 'REQUESTED',
      },
    });

    // 2. the provider call, with NO transaction open.
    let outcome: ReversalOutcome;
    try {
      outcome = await adapter.reverseTransfer({
        transferId: settlement.providerTransferId,
        amountMinor: reverseMinor,
        idempotencyKey,
      });
    } catch (err) {
      /*
        An adapter that throws rather than returning an outcome tells us nothing about whether
        the provider acted. INDETERMINATE, never FAILED: a failure invites a retry of an
        operation that may have succeeded.
      */
      outcome = { kind: 'INDETERMINATE', raw: redactProviderError(err) };
    }

    // 3 and 4.
    await this.recordReversalOutcome(settlement, attempt.id, outcome, reason);
  }

  /**
   * Write what the provider proved, and move money only when that is "it came back".
   *
   * The union is exhausted deliberately. The compiler refuses a new outcome kind that nothing
   * handles, which is what stops a result being quietly discarded the way the old `status` field
   * was - it was never read at all.
   */
  private async recordReversalOutcome(
    settlement: Settlement,
    attemptId: string,
    outcome: ReversalOutcome,
    reason: 'refund' | 'dispute',
  ): Promise<void> {
    const now = new Date();
    switch (outcome.kind) {
      case 'CONFIRMED': {
        /*
          The only path that moves money, and it moves it in the SAME transaction that marks the
          attempt COMPLETED, guarded on the attempt still being REQUESTED. So evidence arriving
          twice cannot decrement twice.
        */
        await this.prisma.$transaction(async (tx) => {
          const claimed = await tx.settlementReversalAttempt.updateMany({
            where: { id: attemptId, status: 'REQUESTED' },
            data: {
              status: 'COMPLETED',
              confirmedMinor: outcome.confirmedMinor,
              providerReversalId: outcome.reversalId,
              syncResponse: outcome.raw as never,
              respondedAt: now,
              settledAt: now,
            },
          });
          if (claimed.count === 0) return;
          await tx.settlement.update({
            where: { id: settlement.id },
            data: { transferredMinor: { decrement: outcome.confirmedMinor } },
          });
        });
        await this.audit.record({
          organizationId: settlement.organizationId,
          action: 'SETTLEMENT_TRANSFER_REVERSED',
          entityType: 'Settlement',
          entityId: settlement.id,
          metadata: { attemptId, confirmedMinor: outcome.confirmedMinor, reason },
        });
        return;
      }
      case 'ACCEPTED': {
        // The provider has it and gave us a reference. Completion is not proven; no money moves.
        await this.prisma.settlementReversalAttempt.update({
          where: { id: attemptId },
          data: {
            status: 'PROCESSING',
            providerReversalId: outcome.reversalId,
            syncResponse: outcome.raw as never,
            respondedAt: now,
          },
        });
        return;
      }
      case 'REFUSED': {
        // Authoritative: the provider did not act. Queryable, and no money moves.
        await this.prisma.settlementReversalAttempt.update({
          where: { id: attemptId },
          data: {
            status: 'FAILED',
            providerStatusRaw: outcome.code,
            lastError: outcome.message,
            syncResponse: outcome.raw as never,
            respondedAt: now,
            settledAt: now,
          },
        });
        await this.notifyAdmins({
          type: NotificationType.TRANSFER_FAILED,
          settlementId: settlement.id,
          error: 'reversal-refused',
        });
        return;
      }
      case 'INDETERMINATE': {
        /*
          We cannot say what happened. The row stays UNKNOWN and NON-terminal so reconciliation
          asks the provider what it did. It is not a failure, and it must not invite a retry.
        */
        await this.prisma.settlementReversalAttempt.update({
          where: { id: attemptId },
          data: { status: 'UNKNOWN', syncResponse: outcome.raw as never, respondedAt: now },
        });
        await this.notifyAdmins({
          type: NotificationType.TRANSFER_FAILED,
          settlementId: settlement.id,
          error: 'reversal-outcome-unknown',
        });
        return;
      }
    }
  }

  /** Block a settlement while a dispute is open (funds not yet moved), or record the loss. */
  async applyDispute(
    eventId: string,
    currency: string,
    opts: { amountMinor: number; open: boolean; lost: boolean },
  ): Promise<void> {
    const settlement = await this.prisma.settlement.findUnique({
      where: { eventId_currency: { eventId, currency: currency.toLowerCase() } },
    });
    if (!settlement) return;

    if (opts.open && canTransitionSettlement(settlement.status as SettlementStatus, 'BLOCKED')) {
      await this.prisma.settlement.update({
        where: { id: settlement.id },
        data: { status: 'BLOCKED', blockedReason: 'Open payment dispute' },
      });
      await this.audit.record({
        organizationId: settlement.organizationId,
        action: 'SETTLEMENT_BLOCKED',
        entityType: 'Settlement',
        entityId: settlement.id,
        metadata: { reason: 'dispute' },
      });
    }
    /*
      A lost dispute is a real loss: record it once, and reverse if already transferred.

      It used to be recorded in `disputesMinor` and then, through `applyRefund`, in
      `refundsMinor` as well — the payable subtracts both, so the loss came off twice. The
      reversal is the only thing the refund path added that a dispute also needs. `opts.lost`
      is set only on the dispute's first transition to LOST (see DisputeService), so a
      redelivered "lost" webhook does not deduct again either.
    */
    if (opts.lost) {
      await this.prisma.settlement.update({
        where: { id: settlement.id },
        data: { disputesMinor: { increment: opts.amountMinor } },
      });
      await this.reverseIfTransferred(
        settlement,
        opts.amountMinor,
        'dispute',
        `reverse_dispute_${settlement.id}_${settlement.disputesMinor}`,
      );
    }
  }

  /** Backstop: a transfer.failed webhook marks the settlement FAILED for ops retry. */
  async onTransferFailed(providerTransferId: string): Promise<void> {
    const settlement = await this.prisma.settlement.findFirst({ where: { providerTransferId } });
    if (!settlement || settlement.status === 'FAILED') return;
    await this.prisma.settlement.update({
      where: { id: settlement.id },
      data: { status: 'FAILED', failureMessage: 'Stripe reported transfer.failed' },
    });
    await this.audit.record({
      organizationId: settlement.organizationId,
      action: 'SETTLEMENT_TRANSFER_FAILED',
      entityType: 'Settlement',
      entityId: settlement.id,
      metadata: { source: 'webhook' },
    });
    await this.notifyAdmins({
      type: NotificationType.TRANSFER_FAILED,
      settlementId: settlement.id,
    });
  }

  /**
   * Apply authoritative provider evidence about a transfer, from whatever saw it.
   *
   * ── WHAT THIS REPLACED (R4) ───────────────────────────────────────────
   * `onTransferReversed(providerTransferId)` took a transfer id and NOTHING ELSE. It set the
   * settlement to REVERSED whatever amount had come back, never touched the money, and threw
   * away the cumulative figure the webhook payload was already carrying. So the webhook path and
   * the orchestration path described the same provider movement two different ways.
   *
   * Now every path - synchronous response, webhook, provider lookup - normalizes to
   * `TransferEvidence` and runs through `reconcileTransferEvidence`. There is one place where a
   * provider fact becomes an internal money fact, and the source cannot change the arithmetic.
   */
  async applyTransferEvidence(evidence: TransferEvidence): Promise<ReconciliationOutcome> {
    const settlement = await this.prisma.settlement.findFirst({
      where: { providerTransferId: evidence.providerTransferId },
    });
    if (!settlement) {
      /*
        Evidence about a transfer we do not hold. Recorded as a mismatch rather than ignored: a
        reversal raised in a provider dashboard against an unknown transfer is exactly the kind
        of thing somebody needs to see.
      */
      return {
        kind: 'MISMATCH',
        reason: 'no settlement holds this provider transfer',
        detail: { providerTransferId: evidence.providerTransferId },
      };
    }

    const attempts = await this.prisma.settlementReversalAttempt.findMany({
      where: { settlementId: settlement.id },
      select: { id: true, status: true, requestedMinor: true, confirmedMinor: true },
    });
    const confirmedReversedMinor = attempts
      .filter((a) => a.status === 'COMPLETED')
      .reduce((total, a) => total + a.confirmedMinor, 0);
    const unresolvedAttempts = attempts.filter(
      (a) => a.status === 'REQUESTED' || a.status === 'PROCESSING' || a.status === 'UNKNOWN',
    ).length;

    const outcome = reconcileTransferEvidence(
      {
        settlementId: settlement.id,
        providerTransferId: settlement.providerTransferId,
        currency: settlement.currency,
        /*
          Settlements released before anything wrote `releasedMinor` have no stored figure, so it
          is reconstructed the same exact way as the reversal clamp: what went out is what is
          still held plus what has been confirmed back. The old `|| transferredMinor` understated
          it by the confirmed total, which is the figure this reconciliation compares against the
          provider's own ORIGINAL transfer amount - so a correctly reversed settlement reported a
          mismatch against the provider.
        */
        releasedMinor:
          settlement.releasedMinor || settlement.transferredMinor + confirmedReversedMinor,
        confirmedReversedMinor,
        unresolvedAttempts,
      },
      evidence,
    );

    await this.recordEvidenceOutcome(settlement, attempts, evidence, outcome);
    return outcome;
  }

  /**
   * Persist what the evidence proved.
   *
   * Only NEWLY_CONFIRMED moves money, and it moves exactly the delta - never the provider's
   * cumulative figure, which already includes what we hold.
   */
  private async recordEvidenceOutcome(
    settlement: Settlement,
    attempts: Array<{ id: string; status: string; requestedMinor: number; confirmedMinor: number }>,
    evidence: TransferEvidence,
    outcome: ReconciliationOutcome,
  ): Promise<void> {
    const now = evidence.observedAt;

    if (outcome.kind === 'MISMATCH') {
      this.logger.error(
        `transfer evidence mismatch for ${evidence.providerTransferId}: ${outcome.reason}`,
      );
      await this.audit.record({
        organizationId: settlement.organizationId,
        action: 'SETTLEMENT_EVIDENCE_MISMATCH',
        entityType: 'Settlement',
        entityId: settlement.id,
        metadata: { reason: outcome.reason, ...outcome.detail, source: evidence.source },
      });
      await this.notifyAdmins({
        type: NotificationType.TRANSFER_FAILED,
        settlementId: settlement.id,
        error: 'reversal-evidence-mismatch',
      });
      return;
    }

    if (outcome.kind === 'STALE' || outcome.kind === 'AGREES') {
      // Nothing to change. Recorded only so a duplicate delivery is visibly a no-op.
      return;
    }

    /*
      Money came back that we had not confirmed. Attribute it to the oldest unresolved attempt
      when one is waiting - that is the attempt this evidence is almost certainly about - and
      otherwise record an ADJUSTMENT: a reversal somebody raised outside this system, which
      previously had no representation at all.
    */
    const waiting = attempts.find(
      (a) => a.status === 'REQUESTED' || a.status === 'PROCESSING' || a.status === 'UNKNOWN',
    );

    await this.prisma.$transaction(async (tx) => {
      if (waiting && outcome.deltaMinor <= waiting.requestedMinor) {
        const claimed = await tx.settlementReversalAttempt.updateMany({
          where: { id: waiting.id, status: { in: ['REQUESTED', 'PROCESSING', 'UNKNOWN'] } },
          data: {
            status: 'COMPLETED',
            confirmedMinor: outcome.deltaMinor,
            providerStatusRaw: evidence.providerStatusRaw,
            evidence: {
              source: evidence.source,
              cumulative: outcome.cumulativeReversedMinor,
            } as never,
            respondedAt: now,
            settledAt: now,
            lastReconciledAt: now,
          },
        });
        if (claimed.count === 0) return;
      } else {
        await tx.settlementReversalAttempt.create({
          data: {
            settlementId: settlement.id,
            reason: 'ADJUSTMENT',
            requestedMinor: outcome.deltaMinor,
            currency: settlement.currency,
            provider: settlement.provider,
            status: 'COMPLETED',
            confirmedMinor: outcome.deltaMinor,
            providerStatusRaw: evidence.providerStatusRaw,
            evidence: {
              source: evidence.source,
              cumulative: outcome.cumulativeReversedMinor,
            } as never,
            // Not ours, so it carries no idempotency key of ours - the cumulative figure is the
            // dedupe, because re-observing it yields AGREES rather than a second delta.
            idempotencyKey: `evidence:${settlement.id}:${outcome.cumulativeReversedMinor}`,
            respondedAt: now,
            settledAt: now,
            lastReconciledAt: now,
          },
        });
      }

      await tx.settlement.update({
        where: { id: settlement.id },
        data: { transferredMinor: { decrement: outcome.deltaMinor } },
      });
    });

    await this.audit.record({
      organizationId: settlement.organizationId,
      action: 'SETTLEMENT_TRANSFER_REVERSED',
      entityType: 'Settlement',
      entityId: settlement.id,
      metadata: {
        deltaMinor: outcome.deltaMinor,
        cumulativeReversedMinor: outcome.cumulativeReversedMinor,
        source: evidence.source,
      },
    });
  }

  // ─── Notifications (best-effort) ───

  /**
   * The transactional variant, for a payout release.
   *
   * The owners are read and written in the caller's transaction, so the notice cannot
   * survive a rollback or be lost by a crash after one. It is a fan-out over the
   * organization's owners -- a handful of people, not an audience -- so it stays a loop
   * rather than reaching for the bulk path, and it does no provider I/O either way.
   */
  private async notifyOrganizerInTransaction(
    tx: Prisma.TransactionClient,
    organizationId: string,
    payload: Record<string, unknown> & { type: NotificationType },
  ) {
    const owners = await tx.organizationMember.findMany({
      where: { organizationId, role: 'ORGANIZER_OWNER', status: 'ACTIVE' },
      select: { userId: true },
    });
    for (const o of owners) {
      await this.notifications.sendCritical(tx, {
        type: payload.type,
        userId: o.userId,
        payload,
      });
    }
  }

  private async notifyAdmins(payload: Record<string, unknown> & { type: NotificationType }) {
    const admins = await this.prisma.user.findMany({
      where: { roles: { has: 'ADMIN' } },
      select: { id: true },
      take: 50,
    });
    for (const a of admins) {
      await this.notifications
        .send({ type: payload.type, userId: a.id, payload, channels: ['in_app', 'email'] })
        .catch(() => undefined);
    }
  }
}
