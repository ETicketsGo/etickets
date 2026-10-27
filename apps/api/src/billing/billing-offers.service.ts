import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  EMAIL_CREDITS_LEDGER_KEY,
  ENTITLEMENT_DEFINITIONS,
  isEntitlementKey,
} from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService, type AuditEntry } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import {
  TransactionalEventPublisher,
  billingCreditsGrantedEvent,
  billingEntitlementOverrideChangedEvent,
} from '../common/domain-events';
import { CREDITS_PERIOD, EntitlementService } from './entitlements/entitlement.service';
import { ensureBillingAccount } from './billing-account';

/**
 * Commercial offers staff can give an organization, each on its own (WS6):
 *   - marketing credits (a CREDIT_GRANT row in the usage ledger);
 *   - a subscription discount (a DISCOUNT adjustment on the billing account, applied to plan
 *     invoices when paid plans open);
 *   - a single entitlement, on or off, for a window (EntitlementOverride).
 * Trials and complimentary plans are subscription moves (SubscriptionService).
 *
 * Fee waivers on TICKET sales are a different thing (platform fee policies) and are not here.
 */
@Injectable()
export class BillingOffersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: TransactionalEventPublisher,
    private readonly entitlements: EntitlementService,
  ) {}

  private async assertOrganization(organizationId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    });
    if (!org) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Organization not found.', HttpStatus.NOT_FOUND);
    }
  }

  /** Grants extra email credits. Idempotent per `idempotencyKey`: a retry grants nothing more. */
  async grantCredits(
    organizationId: string,
    input: { amount: number; reason: string; idempotencyKey: string },
    actorUserId: string,
  ) {
    await this.assertOrganization(organizationId);
    const key = `grant:${input.idempotencyKey}`;
    const prior = await this.prisma.usageLedger.findUnique({ where: { idempotencyKey: key } });
    if (prior) {
      if (prior.organizationId !== organizationId || prior.delta !== input.amount) {
        throw new AppException(
          ErrorCodes.CONFLICT,
          'That request key was already used for a different grant.',
          HttpStatus.CONFLICT,
        );
      }
      return { entry: prior, replayed: true };
    }
    let audit: AuditEntry | null = null;
    try {
      const entry = await this.events.runWithEvents(async (tx, collector) => {
        const row = await tx.usageLedger.create({
          data: {
            organizationId,
            key: EMAIL_CREDITS_LEDGER_KEY,
            delta: input.amount,
            reason: 'CREDIT_GRANT',
            periodKey: CREDITS_PERIOD,
            idempotencyKey: key,
            actorUserId,
            note: input.reason,
          },
        });
        audit = {
          actorUserId,
          organizationId,
          action: 'BILLING_CREDITS_GRANTED',
          entityType: 'UsageLedger',
          entityId: row.id,
          metadata: { amount: input.amount, reason: input.reason },
        };
        await this.audit.recordInTransaction(tx, audit);
        collector.collect(
          billingCreditsGrantedEvent({
            organizationId,
            ledgerEntryId: row.id,
            key: EMAIL_CREDITS_LEDGER_KEY,
            amount: input.amount,
            grantedAt: row.createdAt.toISOString(),
          }),
        );
        return row;
      });
      if (audit) this.audit.afterCommit(audit);
      return { entry, replayed: false };
    } catch (e) {
      // A concurrent retry with the same key won the race: answer with what it wrote.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const row = await this.prisma.usageLedger.findUniqueOrThrow({
          where: { idempotencyKey: key },
        });
        return { entry: row, replayed: true };
      }
      throw e;
    }
  }

  /** Records a discount on the organization's plan payments. Exactly one of percent or amount. */
  async recordDiscount(
    organizationId: string,
    input: {
      percentOffBps?: number | null;
      amountMinor?: number | null;
      endsAt?: Date | null;
      reason: string;
    },
    actorUserId: string,
  ) {
    const hasPercent = input.percentOffBps != null;
    const hasAmount = input.amountMinor != null;
    if (hasPercent === hasAmount) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'Give either a percentage off or an amount off, not both.',
      );
    }
    await this.assertOrganization(organizationId);
    let audit: AuditEntry | null = null;
    const row = await this.prisma.$transaction(async (tx) => {
      const account = await ensureBillingAccount(tx, organizationId);
      const adj = await tx.billingAdjustment.create({
        data: {
          accountId: account.id,
          kind: 'DISCOUNT',
          percentOffBps: input.percentOffBps ?? null,
          amountMinor: input.amountMinor ?? null,
          currency: hasAmount ? account.currency : null,
          endsAt: input.endsAt ?? null,
          reason: input.reason,
          createdByUserId: actorUserId,
        },
      });
      audit = {
        actorUserId,
        organizationId,
        action: 'BILLING_DISCOUNT_RECORDED',
        entityType: 'BillingAdjustment',
        entityId: adj.id,
        metadata: {
          percentOffBps: adj.percentOffBps,
          amountMinor: adj.amountMinor,
          currency: adj.currency,
          endsAt: adj.endsAt?.toISOString() ?? null,
          reason: input.reason,
        },
      };
      await this.audit.recordInTransaction(tx, audit);
      return adj;
    });
    if (audit) this.audit.afterCommit(audit);
    return row;
  }

  async grantOverride(
    organizationId: string,
    input: {
      key: string;
      boolValue?: boolean | null;
      intValue?: number | null;
      startsAt?: Date | null;
      endsAt?: Date | null;
      reason: string;
    },
    actorUserId: string,
  ) {
    if (!isEntitlementKey(input.key)) {
      throw new AppException(ErrorCodes.VALIDATION_FAILED, `Unknown entitlement ${input.key}.`);
    }
    const kind = ENTITLEMENT_DEFINITIONS[input.key].kind;
    const valid =
      kind === 'int'
        ? Number.isInteger(input.intValue) &&
          (input.intValue as number) >= 0 &&
          input.boolValue == null
        : typeof input.boolValue === 'boolean' && input.intValue == null;
    if (!valid) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        `${input.key} takes ${kind === 'int' ? 'a whole number' : 'on or off'}.`,
      );
    }
    const startsAt = input.startsAt ?? new Date();
    if (input.endsAt && input.endsAt.getTime() <= startsAt.getTime()) {
      throw new AppException(ErrorCodes.VALIDATION_FAILED, 'The end must be after the start.');
    }
    await this.assertOrganization(organizationId);
    let audit: AuditEntry | null = null;
    const row = await this.events.runWithEvents(async (tx, collector) => {
      const o = await tx.entitlementOverride.create({
        data: {
          organizationId,
          key: input.key,
          boolValue: kind === 'bool' ? input.boolValue! : null,
          intValue: kind === 'int' ? input.intValue! : null,
          startsAt,
          endsAt: input.endsAt ?? null,
          reason: input.reason,
          grantedByUserId: actorUserId,
        },
      });
      audit = {
        actorUserId,
        organizationId,
        action: 'ENTITLEMENT_OVERRIDE_GRANTED',
        entityType: 'EntitlementOverride',
        entityId: o.id,
        metadata: {
          key: o.key,
          boolValue: o.boolValue,
          intValue: o.intValue,
          startsAt: o.startsAt.toISOString(),
          endsAt: o.endsAt?.toISOString() ?? null,
          reason: input.reason,
        },
      };
      await this.audit.recordInTransaction(tx, audit);
      collector.collect(
        billingEntitlementOverrideChangedEvent({
          organizationId,
          overrideId: o.id,
          key: o.key,
          change: 'GRANTED',
          changedAt: o.createdAt.toISOString(),
        }),
      );
      return o;
    });
    this.entitlements.bust(organizationId);
    if (audit) this.audit.afterCommit(audit);
    return row;
  }

  async revokeOverride(id: string, reason: string, actorUserId: string) {
    const existing = await this.prisma.entitlementOverride.findUnique({ where: { id } });
    if (!existing) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Override not found.', HttpStatus.NOT_FOUND);
    }
    if (existing.revokedAt) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'That override is already revoked.',
        HttpStatus.CONFLICT,
      );
    }
    let audit: AuditEntry | null = null;
    const row = await this.events.runWithEvents(async (tx, collector) => {
      const now = new Date();
      const updated = await tx.entitlementOverride.updateMany({
        where: { id, revokedAt: null },
        data: { revokedAt: now, revokedByUserId: actorUserId, revokeReason: reason },
      });
      if (updated.count !== 1) {
        throw new AppException(
          ErrorCodes.CONFLICT,
          'That override is already revoked.',
          HttpStatus.CONFLICT,
        );
      }
      audit = {
        actorUserId,
        organizationId: existing.organizationId,
        action: 'ENTITLEMENT_OVERRIDE_REVOKED',
        entityType: 'EntitlementOverride',
        entityId: id,
        metadata: { key: existing.key, reason },
      };
      await this.audit.recordInTransaction(tx, audit);
      collector.collect(
        billingEntitlementOverrideChangedEvent({
          organizationId: existing.organizationId,
          overrideId: id,
          key: existing.key,
          change: 'REVOKED',
          changedAt: now.toISOString(),
        }),
      );
      return tx.entitlementOverride.findUniqueOrThrow({ where: { id } });
    });
    this.entitlements.bust(existing.organizationId);
    if (audit) this.audit.afterCommit(audit);
    return row;
  }
}
