import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PaymentEnv, ReconciliationDiscrepancy } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { AppException, ErrorCodes } from '../../common/errors';
import { resolvePaymentEnv, type PaymentEnvName } from '../configuration/payment-environment';
import { PaymentProviderRegistry } from '../orchestration/provider-registry';
import {
  agingBuckets,
  detectDiscrepancies,
  discrepanciesToCsv,
  type DiscrepancyCandidate,
  type OurPayment,
  type OurRefund,
} from './discrepancy-detectors';

interface Actor {
  userId?: string;
  ip?: string | null;
}

/**
 * Finance reconciliation + discrepancy queue (ADR-029). Detects differences between
 * our records and provider truth (+ internal invariants), files them into a triage
 * queue, and supports assignment / resolution / CSV export / aging. Financial
 * records are NEVER auto-corrected — resolution is a human, audited decision.
 */
@Injectable()
export class FinanceReconciliationService {
  private readonly env: PaymentEnvName;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly registry: PaymentProviderRegistry,
    config: ConfigService,
  ) {
    this.env = resolvePaymentEnv(config.get<string>('APP_ENV'));
  }

  /** Detect discrepancies in a window and file new ones into the queue. */
  async detect(from: Date, to: Date): Promise<{ detected: number; created: number }> {
    const [payments, refunds] = await Promise.all([
      this.prisma.payment.findMany({
        where: {
          status: 'SUCCEEDED',
          createdAt: { gte: from, lte: to },
          providerRef: { not: null },
        },
        select: {
          bookingId: true,
          providerRef: true,
          provider: true,
          amountMinor: true,
          currency: true,
        },
      }),
      this.prisma.refund.findMany({
        where: { status: 'COMPLETED', createdAt: { gte: from, lte: to } },
        select: {
          bookingId: true,
          amountMinor: true,
          providerRef: true,
          booking: { select: { payment: { select: { amountMinor: true, provider: true } } } },
        },
      }),
    ]);

    const ourPayments: OurPayment[] = [];
    for (const p of payments) {
      const adapter = this.registry.get(p.provider);
      let providerStatus: OurPayment['providerStatus'] = undefined; // not looked up
      if (adapter?.getPayment && p.providerRef) {
        try {
          providerStatus = await adapter.getPayment(p.providerRef);
        } catch {
          providerStatus = null; // looked up + missing
        }
      }
      ourPayments.push({
        bookingId: p.bookingId,
        providerRef: p.providerRef ?? '',
        provider: p.provider,
        amountMinor: p.amountMinor,
        currency: p.currency,
        providerStatus,
      });
    }

    const ourRefunds: OurRefund[] = refunds.map((r) => ({
      bookingId: r.bookingId,
      provider: r.booking?.payment?.provider ?? 'unknown',
      providerRef: r.providerRef ?? '',
      amountMinor: r.amountMinor,
      paymentAmountMinor: r.booking?.payment?.amountMinor ?? 0,
    }));

    const candidates = detectDiscrepancies({ payments: ourPayments, refunds: ourRefunds });
    let created = 0;
    for (const c of candidates) {
      if (await this.fileDiscrepancy(c)) created += 1;
    }

    await this.audit.record({
      action: 'PAYMENT_DISCREPANCY_DETECTION',
      entityType: 'ReconciliationDiscrepancy',
      metadata: {
        env: this.env,
        detected: candidates.length,
        created,
        from: from.toISOString(),
        to: to.toISOString(),
      },
    });
    return { detected: candidates.length, created };
  }

  /** Daily run for the current environment (last 25h to overlap the boundary). */
  async runDailyDetection(): Promise<{ detected: number; created: number }> {
    const to = new Date();
    const from = new Date(to.getTime() - 25 * 3600 * 1000);
    return this.detect(from, to);
  }

  private async fileDiscrepancy(c: DiscrepancyCandidate): Promise<boolean> {
    // Dedupe: never file a second open discrepancy for the same (env,type,entityRef).
    const existing = await this.prisma.reconciliationDiscrepancy.findFirst({
      where: {
        env: this.env as PaymentEnv,
        type: c.type,
        entityRef: c.entityRef,
        status: { in: ['OPEN', 'ASSIGNED'] },
      },
    });
    if (existing) return false;
    await this.prisma.reconciliationDiscrepancy.create({
      data: {
        env: this.env as PaymentEnv,
        type: c.type,
        provider: c.provider,
        entityRef: c.entityRef,
        amountMinor: c.amountMinor,
        currency: c.currency,
        detail: c.detail,
      },
    });
    return true;
  }

  async list(
    filter: { status?: string; type?: string } = {},
  ): Promise<ReconciliationDiscrepancy[]> {
    return this.prisma.reconciliationDiscrepancy.findMany({
      where: {
        env: this.env as PaymentEnv,
        ...(filter.status ? { status: filter.status as never } : {}),
        ...(filter.type ? { type: filter.type as never } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
  }

  async assign(id: string, userId: string, actor: Actor): Promise<ReconciliationDiscrepancy> {
    const row = await this.update(id, { status: 'ASSIGNED', assignedToUserId: userId });
    await this.record(actor, 'PAYMENT_DISCREPANCY_ASSIGNED', id, { assignedTo: userId });
    return row;
  }

  async resolve(id: string, notes: string, actor: Actor): Promise<ReconciliationDiscrepancy> {
    const row = await this.update(id, {
      status: 'RESOLVED',
      resolutionNotes: notes,
      resolvedAt: new Date(),
    });
    await this.record(actor, 'PAYMENT_DISCREPANCY_RESOLVED', id, { notes });
    return row;
  }

  async ignore(id: string, notes: string, actor: Actor): Promise<ReconciliationDiscrepancy> {
    const row = await this.update(id, {
      status: 'IGNORED',
      resolutionNotes: notes,
      resolvedAt: new Date(),
    });
    await this.record(actor, 'PAYMENT_DISCREPANCY_IGNORED', id, { notes });
    return row;
  }

  async csv(filter: { status?: string; type?: string } = {}): Promise<string> {
    return discrepanciesToCsv(await this.list(filter));
  }

  async aging(): Promise<{ bucket: string; count: number }[]> {
    const open = await this.prisma.reconciliationDiscrepancy.findMany({
      where: { env: this.env as PaymentEnv, status: { in: ['OPEN', 'ASSIGNED'] } },
      select: { createdAt: true },
    });
    return agingBuckets(open, Date.now());
  }

  private async update(
    id: string,
    data: Record<string, unknown>,
  ): Promise<ReconciliationDiscrepancy> {
    const existing = await this.prisma.reconciliationDiscrepancy.findUnique({ where: { id } });
    if (!existing) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Discrepancy not found.', HttpStatus.NOT_FOUND);
    }
    return this.prisma.reconciliationDiscrepancy.update({ where: { id }, data });
  }

  private async record(
    actor: Actor,
    action: string,
    entityId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      actorUserId: actor.userId,
      ip: actor.ip,
      action,
      entityType: 'ReconciliationDiscrepancy',
      entityId,
      metadata,
    });
  }
}
