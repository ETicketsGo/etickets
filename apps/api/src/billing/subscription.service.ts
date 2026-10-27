import { HttpStatus, Injectable } from '@nestjs/common';
import type { OrganizerSubscription, Prisma } from '@prisma/client';
import type { BillingPlanCode, SubscriptionStatus } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService, type AuditEntry } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import {
  TransactionalEventPublisher,
  billingSubscriptionChangedEvent,
} from '../common/domain-events';
import { EntitlementService } from './entitlements/entitlement.service';
import { ensureBillingAccount } from './billing-account';
import {
  SubscriptionTransitionError,
  dueTimedEvent,
  isTerminal,
  transition,
  type SubscriptionEvent,
  type SubscriptionSnapshot,
} from './subscription-state-machine';

type Tx = Prisma.TransactionClient;

export interface ApplyContext {
  /** The audit action written with the change, e.g. BILLING_TRIAL_GRANTED. */
  auditAction: string;
  actorUserId?: string | null;
  reason?: string | null;
  priceId?: string | null;
  providerSubscriptionRef?: string | null;
  now?: Date;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Persists subscription moves. Every move is decided by the pure state machine; this only loads
 * the current row, asks `transition`, writes the answer, the audit row and the domain event in
 * ONE transaction, and then drops the organization's cached entitlements.
 *
 * Serialised per billing account: the transaction locks the account row first, so a webhook and
 * a staff grant arriving together are applied one after the other, never interleaved. The row's
 * `version` is checked on update as a second line of defence.
 */
@Injectable()
export class SubscriptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: TransactionalEventPublisher,
    private readonly entitlements: EntitlementService,
  ) {}

  async planByCode(db: Tx | PrismaService, code: BillingPlanCode) {
    const plan = await db.billingPlan.findUnique({ where: { code } });
    if (!plan || !plan.active) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `The ${code} plan is not in the catalogue. Load the plan catalogue first.`,
        HttpStatus.CONFLICT,
      );
    }
    return plan;
  }

  async apply(
    organizationId: string,
    event: SubscriptionEvent,
    ctx: ApplyContext,
  ): Promise<OrganizerSubscription> {
    let auditEntry: AuditEntry | null = null;
    const saved = await this.events.runWithEvents(async (tx, collector) => {
      const { row, entry, from } = await this.applyInTx(tx, organizationId, event, ctx);
      auditEntry = entry;
      const plan = await tx.billingPlan.findUnique({ where: { id: row.planId } });
      collector.collect(
        billingSubscriptionChangedEvent(
          {
            organizationId,
            subscriptionId: row.id,
            transition: event.type,
            fromStatus: from,
            toStatus: row.status,
            planCode: plan?.code ?? 'UNKNOWN',
            changedAt: (ctx.now ?? new Date()).toISOString(),
          },
          { actorId: ctx.actorUserId ?? undefined },
        ),
      );
      return row;
    });
    this.entitlements.bust(organizationId);
    if (auditEntry) this.audit.afterCommit(auditEntry);
    return saved;
  }

  /** The move itself, inside a caller's transaction (the provider event path uses this). */
  async applyInTx(
    tx: Tx,
    organizationId: string,
    event: SubscriptionEvent,
    ctx: ApplyContext,
  ): Promise<{ row: OrganizerSubscription; entry: AuditEntry; from: SubscriptionStatus | null }> {
    const now = ctx.now ?? new Date();
    const account = await ensureBillingAccount(tx, organizationId);
    await tx.$queryRaw`SELECT "id" FROM "OrganizerBillingAccount" WHERE "id" = ${account.id} FOR UPDATE`;
    const current = await tx.organizerSubscription.findUnique({
      where: { currentKey: account.id },
    });

    let result;
    try {
      result = transition(current ? toSnapshot(current) : null, event, now);
    } catch (e) {
      if (e instanceof SubscriptionTransitionError) {
        throw new AppException(
          ErrorCodes.SUBSCRIPTION_TRANSITION_INVALID,
          e.message,
          HttpStatus.CONFLICT,
          { reason: e.code, from: current?.status ?? null, event: event.type },
        );
      }
      throw e;
    }
    const { next, creates } = result;
    const terminal = isTerminal(next.status);

    let row: OrganizerSubscription;
    if (creates) {
      if (current) {
        // The state machine only starts a new row from none or a terminal state, and a terminal
        // row never holds currentKey. Reaching here would be two current subscriptions.
        throw new AppException(
          ErrorCodes.CONFLICT,
          'This organization already has a current subscription.',
          HttpStatus.CONFLICT,
        );
      }
      row = await tx.organizerSubscription.create({
        data: {
          accountId: account.id,
          ...next,
          priceId: ctx.priceId ?? null,
          providerSubscriptionRef: ctx.providerSubscriptionRef ?? null,
          currentKey: terminal ? null : account.id,
          grantedByUserId: ctx.actorUserId ?? null,
          note: ctx.reason ?? null,
        },
      });
    } else {
      const updated = await tx.organizerSubscription.updateMany({
        where: { id: current!.id, version: current!.version },
        data: {
          ...next,
          ...(ctx.priceId !== undefined ? { priceId: ctx.priceId } : {}),
          ...(ctx.providerSubscriptionRef
            ? { providerSubscriptionRef: ctx.providerSubscriptionRef }
            : {}),
          currentKey: terminal ? null : account.id,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new AppException(
          ErrorCodes.CONFLICT,
          'The subscription changed while this was being saved. Try again.',
          HttpStatus.CONFLICT,
        );
      }
      row = (await tx.organizerSubscription.findUnique({ where: { id: current!.id } }))!;
    }

    const entry: AuditEntry = {
      actorUserId: ctx.actorUserId ?? null,
      organizationId,
      action: ctx.auditAction,
      entityType: 'OrganizerSubscription',
      entityId: row.id,
      metadata: {
        transition: event.type,
        fromStatus: current?.status ?? null,
        toStatus: row.status,
        planId: row.planId,
        reason: ctx.reason ?? null,
      },
    };
    await this.audit.recordInTransaction(tx, entry);
    return { row, entry, from: (current?.status as SubscriptionStatus | undefined) ?? null };
  }

  // ── Commercial offers (staff) ────────────────────────────────────────────────

  async grantTrial(
    organizationId: string,
    input: { planCode: BillingPlanCode; days: number; reason: string },
    actorUserId: string,
  ) {
    if (input.planCode === 'FREE') {
      throw new AppException(ErrorCodes.VALIDATION_FAILED, 'A trial is of a paid plan.');
    }
    const plan = await this.planByCode(this.prisma, input.planCode);
    const now = new Date();
    return this.apply(
      organizationId,
      {
        type: 'START_TRIAL',
        planId: plan.id,
        trialEndsAt: new Date(now.getTime() + input.days * DAY),
      },
      { auditAction: 'BILLING_TRIAL_GRANTED', actorUserId, reason: input.reason, now },
    );
  }

  async grantComplimentary(
    organizationId: string,
    input: { planCode: BillingPlanCode; endsAt: Date | null; reason: string },
    actorUserId: string,
  ) {
    if (input.planCode === 'FREE') {
      throw new AppException(ErrorCodes.VALIDATION_FAILED, 'A complimentary plan is a paid plan.');
    }
    const plan = await this.planByCode(this.prisma, input.planCode);
    return this.apply(
      organizationId,
      { type: 'GRANT_COMPLIMENTARY', planId: plan.id, endsAt: input.endsAt },
      { auditAction: 'BILLING_COMPLIMENTARY_GRANTED', actorUserId, reason: input.reason },
    );
  }

  /** Ends a trial or complimentary plan now. A paid subscription is never ended this way. */
  async endGrant(organizationId: string, reason: string, actorUserId: string) {
    return this.apply(
      organizationId,
      { type: 'REVOKE' },
      { auditAction: 'BILLING_GRANT_ENDED', actorUserId, reason },
    );
  }

  /**
   * Applies every clock move that is due (trial, grace, complimentary or a cancelling period
   * ran out). Entitlements already follow the clock without it; this keeps the stored status
   * and the metrics honest. Safe to run as often as wanted: a move already made is not due.
   * Scheduling it (worker) arrives with the provider change.
   */
  async sweep(now: Date = new Date()): Promise<{ applied: number }> {
    const live = await this.prisma.organizerSubscription.findMany({
      where: { currentKey: { not: null } },
      include: { account: { select: { organizationId: true } } },
    });
    let applied = 0;
    for (const s of live) {
      const due = dueTimedEvent(toSnapshot(s), now);
      if (!due) continue;
      try {
        await this.apply(s.account.organizationId, due, {
          auditAction: 'BILLING_SUBSCRIPTION_EXPIRED_BY_CLOCK',
          now,
        });
        applied += 1;
      } catch (e) {
        // Moved by somebody else in the meantime; the next sweep sees the new state.
        if (!(e instanceof AppException)) throw e;
      }
    }
    return { applied };
  }
}

export function toSnapshot(s: OrganizerSubscription): SubscriptionSnapshot {
  return {
    status: s.status as SubscriptionStatus,
    source: s.source,
    planId: s.planId,
    currentPeriodStart: s.currentPeriodStart,
    currentPeriodEnd: s.currentPeriodEnd,
    cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    trialEndsAt: s.trialEndsAt,
    graceEndsAt: s.graceEndsAt,
    scheduledPlanId: s.scheduledPlanId,
    cancelledAt: s.cancelledAt,
    endedAt: s.endedAt,
  };
}
