import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma, type Settlement } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import {
  NotificationType,
  PaymentStatus,
  SettlementStatus,
  canTransitionSettlement,
  computeSettlementPayable,
  isReleasableSettlementStatus,
} from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { NotificationService } from '../../notifications/notification.service';
import { AppException, ErrorCodes } from '../../common/errors';
import type { RequestUser } from '../../common/decorators';
import type { PaymentProvider } from '../provider/payment-provider.interface';
import { PaymentProviderResolver } from '../provider/payment-provider.resolver';

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

  async list(filter: {
    status?: SettlementStatus;
    organizationId?: string;
    eventId?: string;
    page?: number;
    pageSize?: number;
  }) {
    const page = filter.page ?? 1;
    const pageSize = Math.min(filter.pageSize ?? 25, 100);
    const where = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.organizationId ? { organizationId: filter.organizationId } : {}),
      ...(filter.eventId ? { eventId: filter.eventId } : {}),
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
    return { data: rows, meta: { total, page, pageSize } };
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

    try {
      const transfer = await adapter.createTransfer!({
        amountMinor: payable.payableMinor,
        currency: settlement.currency,
        destinationAccountId: settlement.connectedAccountId,
        transferGroup: `etg_event_${settlement.eventId}`,
        // Deterministic key: a re-run of the same settlement release never double-pays.
        idempotencyKey: `settlement_${settlement.id}_${settlement.transferredMinor}`,
        metadata: { settlementId: settlement.id, eventId: settlement.eventId },
      });
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
            transferredMinor: settlement.transferredMinor + payable.payableMinor,
            releasedAt: new Date(),
            failureMessage: null,
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
  private async reverseIfTransferred(
    settlement: Settlement,
    amountMinor: number,
    reason: 'refund' | 'dispute',
    idempotencyKey: string,
  ): Promise<void> {
    const adapter = this.adapterFor(settlement.provider);
    if (
      settlement.status === 'TRANSFERRED' &&
      settlement.providerTransferId &&
      adapter.reverseTransfer
    ) {
      const reverseMinor = Math.min(amountMinor, settlement.transferredMinor);
      if (reverseMinor > 0) {
        try {
          await adapter.reverseTransfer({
            transferId: settlement.providerTransferId,
            amountMinor: reverseMinor,
            idempotencyKey,
          });
          const fullyReversed = reverseMinor >= settlement.transferredMinor;
          await this.prisma.settlement.update({
            where: { id: settlement.id },
            data: {
              status: fullyReversed ? 'REVERSED' : 'PARTIALLY_REFUNDED',
              transferredMinor: { decrement: reverseMinor },
            },
          });
          await this.audit.record({
            organizationId: settlement.organizationId,
            action: 'SETTLEMENT_TRANSFER_REVERSED',
            entityType: 'Settlement',
            entityId: settlement.id,
            metadata: { reverseMinor, reason },
          });
        } catch (err) {
          this.logger.error(
            `Transfer reversal failed for settlement ${settlement.id}: ${err instanceof Error ? err.message : err}`,
          );
          await this.notifyAdmins({
            type: NotificationType.TRANSFER_FAILED,
            settlementId: settlement.id,
            error: 'reversal-failed',
          });
        }
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

  /** A transfer.reversed webhook confirms/records a reversal (we usually initiate it). */
  async onTransferReversed(providerTransferId: string): Promise<void> {
    const settlement = await this.prisma.settlement.findFirst({ where: { providerTransferId } });
    if (!settlement || settlement.status === 'REVERSED') return;
    await this.prisma.settlement.update({
      where: { id: settlement.id },
      data: { status: 'REVERSED' },
    });
    await this.audit.record({
      organizationId: settlement.organizationId,
      action: 'SETTLEMENT_TRANSFER_REVERSED',
      entityType: 'Settlement',
      entityId: settlement.id,
      metadata: { source: 'webhook' },
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
