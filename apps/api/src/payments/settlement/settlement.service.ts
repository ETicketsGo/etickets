import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
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
import { PAYMENT_PROVIDER, type PaymentProvider } from '../provider/payment-provider.interface';

const DEFAULT_CURRENCY = 'usd';

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
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

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

    // Aggregate the organizer's eligible proceeds + platform fees from paid payments.
    const paid = await this.prisma.payment.findMany({
      where: { status: PaymentStatus.SUCCEEDED, booking: { eventId } },
      select: { id: true, organizerNetMinor: true, platformFeeMinor: true, currency: true },
    });
    const grossSalesMinor = paid.reduce((s, p) => s + p.organizerNetMinor, 0);
    const platformFeesMinor = paid.reduce((s, p) => s + p.platformFeeMinor, 0);
    const currency = (paid[0]?.currency ?? DEFAULT_CURRENCY).toLowerCase();

    const account = await this.prisma.organizerPaymentAccount.findUnique({
      where: {
        organizationId_provider: { organizationId: event.organizationId, provider: 'stripe' },
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
        currency,
        accountId: account?.id ?? null,
        connectedAccountId: account?.providerAccountId ?? null,
        grossSalesMinor,
        platformFeesMinor,
        status: nextStatus,
      },
      update: {
        grossSalesMinor,
        platformFeesMinor,
        accountId: account?.id ?? null,
        connectedAccountId: account?.providerAccountId ?? null,
        status: nextStatus,
      },
    });

    // Link the event's successful payments to this settlement batch (idempotent).
    await this.prisma.payment.updateMany({
      where: { status: PaymentStatus.SUCCEEDED, booking: { eventId }, settlementId: null },
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

    if (!settlement.connectedAccountId || !this.provider.createTransfer) {
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
      const transfer = await this.provider.createTransfer({
        amountMinor: payable.payableMinor,
        currency: settlement.currency,
        destinationAccountId: settlement.connectedAccountId,
        transferGroup: `etg_event_${settlement.eventId}`,
        // Deterministic key: a re-run of the same settlement release never double-pays.
        idempotencyKey: `settlement_${settlement.id}_${settlement.transferredMinor}`,
        metadata: { settlementId: settlement.id, eventId: settlement.eventId },
      });
      const released = await this.prisma.settlement.update({
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
      await this.audit.record({
        actorUserId: actor.id,
        organizationId: settlement.organizationId,
        action: 'SETTLEMENT_TRANSFERRED',
        entityType: 'Settlement',
        entityId: id,
        metadata: { transferId: transfer.transferId, amountMinor: payable.payableMinor, note },
      });
      await this.notifyOrganizer(settlement.organizationId, {
        type: NotificationType.SETTLEMENT_RELEASED,
        settlementId: id,
        amountMinor: payable.payableMinor,
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

  // ─── Notifications (best-effort) ───

  private async notifyOrganizer(
    organizationId: string,
    payload: Record<string, unknown> & { type: NotificationType },
  ) {
    const owners = await this.prisma.organizationMember.findMany({
      where: { organizationId, role: 'ORGANIZER_OWNER', status: 'ACTIVE' },
      select: { userId: true },
    });
    for (const o of owners) {
      await this.notifications
        .send({ type: payload.type, userId: o.userId, payload })
        .catch(() => undefined);
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
