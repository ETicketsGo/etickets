import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { Prisma, type PlatformFeePolicy } from '@prisma/client';
import { AdminPermission, FeeMode, NotificationType } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService, type AuditEntry } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import { AdminAudienceService } from '../notifications/admin-audience.service';
import { NotificationService } from '../notifications/notification.service';
import { PricingService } from '../pricing/pricing.service';
import {
  appliedFeePolicy,
  calculateFeesWithPolicy,
  currenciesCollide,
  effectiveFeePolicyStatus,
  selectFeePolicy,
  windowsOverlap,
  type FeePolicyKind,
  type FeePolicyRow,
  type FeePolicyScope,
} from '../pricing/fee-policy';
import { calculateFees, type FeeCalcResult } from '../pricing/fee-calculator';
import { FeePolicyResolver } from '../pricing/fee-policy-resolver.service';

/**
 * Platform fee overrides and waivers, managed from the back office.
 *
 * ── TERMS NEVER CHANGE ─────────────────────────────────────────────────────────────────
 * There is no edit. A policy is created, and later deactivated (or it expires, or its orders
 * run out). To change the terms, deactivate it and create another. Every booking priced under
 * a policy names it and its version, and re-pricing that booking (a coupon at checkout) reads
 * the row back - so the row must still say what it said when the booking was priced.
 *
 * ── NO TWO LIVE POLICIES FOR ONE TARGET AT ONCE ───────────────────────────────────────
 * Precedence decides between levels (event over organizer over schedule). Within one level
 * there is nothing to decide by, so a second live policy for the same event or organizer whose
 * window overlaps (and whose currency could also apply) is refused. Checked under a
 * transaction-scoped advisory lock on the target, so two admins creating at the same moment
 * cannot both pass the check.
 *
 * ── NOTHING HERE RE-PRICES AN ORDER ────────────────────────────────────────────────────
 * Creating, deactivating or expiring a policy changes the price of the NEXT sale. Every
 * booking keeps the money it was charged and the policy it names.
 *
 * ── TWO PEOPLE FOR EVERY CHANGE TO WHAT BUYERS PAY (maker-checker, AR-10) ────────────────
 * A new policy is PENDING_APPROVAL and prices nothing until an administrator holding
 * FEE_SCHEDULE_APPROVE, who is not its creator, approves it. Switching a live policy off
 * raises the fee back to the schedule, so it is a REQUEST that another such administrator
 * approves; until then the policy keeps pricing. Judged on identity, never on role: a super
 * admin who created a policy is still its maker. A database trigger refuses an ACTIVE policy
 * without an independent approver, any change to a policy's terms, and an INACTIVE one that
 * did not come through an approved request or the emergency path.
 *
 * The emergency path (`emergencyDeactivate`) lets ONE person holding both PLATFORM_CONFIG and
 * FEE_SCHEDULE_APPROVE switch a policy off at once, with a fresh second factor and a written
 * reason. It can only return sales to the approved schedule, never introduce a new fee; it is
 * recorded as an emergency and every other approver is told to review it.
 */

export type EffectiveStatus =
  | 'ACTIVE'
  | 'SCHEDULED'
  | 'EXPIRED'
  | 'EXHAUSTED'
  | 'INACTIVE'
  | 'PENDING_APPROVAL'
  | 'REJECTED'
  | 'WITHDRAWN';

/** States in which a policy has been approved and can price, or once could. */
const LIVE_STATES = ['ACTIVE', 'EXHAUSTED', 'EXPIRED'] as const;

export interface PolicyTermsInput {
  kind: FeePolicyKind;
  feeMinor?: number | null;
  percentBps?: number | null;
  minFeeMinor?: number | null;
  maxFeeMinor?: number | null;
  currency?: string | null;
}

export interface CreatePolicyInput extends PolicyTermsInput {
  scope: FeePolicyScope;
  eventId?: string | null;
  organizationId?: string | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  maxOrders?: number | null;
  reason: string;
  approvalReference?: string | null;
}

export interface ListPolicyFilters {
  scope?: FeePolicyScope;
  status?: EffectiveStatus;
  organizationId?: string;
  eventId?: string;
  q?: string;
  page: number;
  pageSize: number;
}

export interface PreviewInput extends PolicyTermsInput {
  scope: FeePolicyScope;
  eventId?: string | null;
  organizationId?: string | null;
  currency: string;
  subtotalMinor: number;
  /** Paid tickets in the sample basket. Only a per-ticket fee reads it. Defaults to one. */
  ticketCount?: number;
  feeMode?: FeeMode;
}

/** How far in the past a start may be stated, to absorb clock skew between console and API. */
const START_SKEW_MS = 5 * 60_000;

/** Bookings that used a policy: everything but an unpaid hold that never completed. */
const USED_BOOKING: Prisma.BookingWhereInput = {
  OR: [{ confirmedAt: { not: null } }, { status: 'PENDING_PAYMENT' }],
};

function bad(message: string): AppException {
  return new AppException(ErrorCodes.VALIDATION_FAILED, message, HttpStatus.BAD_REQUEST);
}

/**
 * The optional lowest and highest fee for a whole order, checked: neither negative, and the
 * lowest not above the highest. Both unset is the default and means no limit.
 */
function orderLimits(input: Pick<PolicyTermsInput, 'minFeeMinor' | 'maxFeeMinor'>): {
  minFeeMinor: number | null;
  maxFeeMinor: number | null;
} {
  const min = input.minFeeMinor ?? null;
  const max = input.maxFeeMinor ?? null;
  if ((min !== null && min < 0) || (max !== null && max < 0)) {
    throw bad('The lowest and highest fee cannot be below zero.');
  }
  if (min !== null && max !== null && min > max) {
    throw bad('The lowest fee cannot be more than the highest fee.');
  }
  return { minFeeMinor: min, maxFeeMinor: max };
}

/** The terms a kind allows, and nothing else: a waiver with a stray amount is refused. */
export function normaliseTerms(input: PolicyTermsInput): {
  kind: FeePolicyKind;
  feeMinor: number | null;
  percentBps: number | null;
  minFeeMinor: number | null;
  maxFeeMinor: number | null;
  currency: string | null;
} {
  const currency = input.currency?.trim() ? input.currency.trim().toUpperCase() : null;
  if (currency && !/^[A-Z]{3}$/.test(currency)) {
    throw bad('Currency must be a three-letter code, such as INR or USD.');
  }
  const has = (v: number | null | undefined) => v !== null && v !== undefined;
  switch (input.kind) {
    case 'WAIVE':
      if (
        has(input.feeMinor) ||
        has(input.percentBps) ||
        has(input.minFeeMinor) ||
        has(input.maxFeeMinor)
      ) {
        throw bad('A waiver takes no amount. The booking fee is zero.');
      }
      return {
        kind: 'WAIVE',
        feeMinor: null,
        percentBps: null,
        minFeeMinor: null,
        maxFeeMinor: null,
        currency,
      };
    case 'FIXED':
      if (!has(input.feeMinor)) throw bad('A fixed fee needs an amount.');
      if (has(input.percentBps) || has(input.minFeeMinor) || has(input.maxFeeMinor)) {
        throw bad('A fixed fee takes one amount, not a percentage or limits.');
      }
      if (!currency) throw bad('A fixed fee needs a currency.');
      return {
        kind: 'FIXED',
        feeMinor: input.feeMinor!,
        percentBps: null,
        minFeeMinor: null,
        maxFeeMinor: null,
        currency,
      };
    case 'PERCENT': {
      if (!has(input.percentBps)) throw bad('A percentage fee needs a percentage.');
      if (has(input.feeMinor)) throw bad('A percentage fee takes no fixed amount.');
      const min = input.minFeeMinor ?? null;
      const max = input.maxFeeMinor ?? null;
      if (min !== null && max !== null && min > max) {
        throw bad('The lowest fee cannot be more than the highest fee.');
      }
      if ((min !== null || max !== null) && !currency) {
        throw bad('A lowest or highest fee is an amount, so it needs a currency.');
      }
      return {
        kind: 'PERCENT',
        feeMinor: null,
        percentBps: input.percentBps!,
        minFeeMinor: min,
        maxFeeMinor: max,
        currency,
      };
    }
    case 'COMBINED': {
      // A share of the order plus a fixed amount per paid ticket: both are needed. A lowest and
      // highest fee for the whole order are optional (owner decision 2026-10-29).
      if (!has(input.percentBps) || input.percentBps! < 1) {
        throw bad('A combined fee needs a percentage above 0%.');
      }
      if (!has(input.feeMinor) || input.feeMinor! < 1) {
        throw bad('A combined fee needs a fixed amount per ticket above zero.');
      }
      if (!currency) throw bad('A combined fee states an amount, so it needs a currency.');
      const limits = orderLimits(input);
      return {
        kind: 'COMBINED',
        feeMinor: input.feeMinor!,
        percentBps: input.percentBps!,
        ...limits,
        currency,
      };
    }
    case 'FIXED_PER_TICKET': {
      // A fixed amount for each paid ticket, and no percentage. Optional order limits.
      if (!has(input.feeMinor)) throw bad('A per-ticket fee needs an amount per ticket.');
      if (has(input.percentBps)) {
        throw bad('A per-ticket fee takes no percentage. For both, choose a combined fee.');
      }
      if (!currency) throw bad('A per-ticket fee states an amount, so it needs a currency.');
      const limits = orderLimits(input);
      return {
        kind: 'FIXED_PER_TICKET',
        feeMinor: input.feeMinor!,
        percentBps: null,
        ...limits,
        currency,
      };
    }
    default:
      throw bad('Unknown kind of fee policy.');
  }
}

@Injectable()
export class PlatformFeePoliciesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly pricing: PricingService,
    private readonly resolver: FeePolicyResolver,
    @Optional() private readonly audience?: AdminAudienceService,
    @Optional() private readonly notifications?: NotificationService,
  ) {}

  // ── Reads ──────────────────────────────────────────────────────────────────────────

  async list(filters: ListPolicyFilters, now = new Date()) {
    const where = await this.whereFor(filters, now);
    const [total, rows] = await Promise.all([
      this.prisma.platformFeePolicy.count({ where }),
      this.prisma.platformFeePolicy.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
    ]);
    return {
      data: await this.views(rows, now),
      meta: {
        page: filters.page,
        pageSize: filters.pageSize,
        total,
        totalPages: Math.ceil(total / filters.pageSize),
      },
    };
  }

  async detail(id: string, now = new Date(), viewerUserId?: string) {
    const row = await this.prisma.platformFeePolicy.findUnique({ where: { id } });
    if (!row)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Fee policy not found.', HttpStatus.NOT_FOUND);
    const [view] = await this.views([row], now);
    // Why this viewer may not decide on what is pending, so the console can say so up front.
    const pendingFor = pendingDecision(row);
    const viewerBlockedReason =
      viewerUserId && pendingFor ? independenceFailure(viewerUserId, row, pendingFor) : null;
    const history = await this.prisma.platformFeePolicyEvent.findMany({
      where: { policyId: id },
      orderBy: { createdAt: 'asc' },
    });
    const names = await this.userNames(history.map((h) => h.actorUserId));
    return {
      ...view!,
      pendingDecision: pendingFor,
      viewerBlockedReason,
      history: history.map((h) => ({
        id: h.id,
        action: h.action,
        actorUserId: h.actorUserId,
        actorName: h.actorUserId ? (names.get(h.actorUserId) ?? null) : null,
        reason: h.reason,
        snapshot: h.snapshot,
        createdAt: h.createdAt,
      })),
    };
  }

  /**
   * What a draft policy would charge on a sample basket, beside what the schedule charges -
   * and the policy live for that target now, which the draft would conflict with.
   *
   * Tax is not included: it depends on the buyer and the ticket, and on rules this preview
   * does not need to explain. It is computed on whatever fee the customer is charged.
   */
  async preview(input: PreviewInput, now = new Date()) {
    const terms = normaliseTerms(input);
    const currency = input.currency.trim().toUpperCase();
    if (terms.currency && terms.currency !== currency) {
      throw bad('The sample basket must be in the policy currency.');
    }
    const target = await this.target(input.scope, input.eventId, input.organizationId);
    const feeMode = input.feeMode ?? target.event?.feeMode ?? FeeMode.CUSTOMER_PAYS;
    const place = target.event?.venue
      ? { country: target.event.venue.country, region: target.event.venue.region }
      : {};
    const { tiers } = await this.pricing.resolveFeeTiers(currency, place);
    const draft = {
      id: 'preview',
      scope: input.scope,
      eventId: target.eventId,
      organizationId: target.organizationId,
      ...terms,
      startsAt: now,
      endsAt: null,
      maxOrders: null,
      usedOrders: 0,
      status: 'ACTIVE',
      version: 0,
    };
    const subtotalMinor = Math.max(0, Math.round(input.subtotalMinor));
    const ticketCount = input.ticketCount ?? 1;
    const schedule = calculateFees({ subtotalMinor, feeMode, tiers, currency, ticketCount });
    const outcome = calculateFeesWithPolicy({
      subtotalMinor,
      feeMode,
      currency,
      ticketCount,
      baseTiers: tiers,
      policy: { ...draft, applied: appliedFeePolicy(draft) },
    });
    const current = await this.resolver.resolve(currency, {
      eventId: target.eventId,
      organizationId: target.organizationId,
      at: now,
    });
    const currentRow = current
      ? await this.prisma.platformFeePolicy.findUnique({ where: { id: current.id } })
      : null;
    return {
      currency,
      subtotalMinor,
      ticketCount,
      feeMode,
      schedule: lines(schedule),
      withPolicy: lines(outcome.fees),
      feeWaivedMinor: outcome.feeWaivedMinor ?? 0,
      appliesToBasket: outcome.policy !== null,
      currentPolicy: currentRow ? ((await this.views([currentRow], now))[0] ?? null) : null,
    };
  }

  // ── Writes ─────────────────────────────────────────────────────────────────────────

  async create(actorUserId: string, input: CreatePolicyInput, now = new Date()) {
    const terms = normaliseTerms(input);
    const reason = input.reason?.trim() ?? '';
    if (reason.length < 10) throw bad('Say why, in at least 10 characters.');
    const target = await this.target(input.scope, input.eventId, input.organizationId);
    const startsAt = input.startsAt ?? now;
    if (startsAt.getTime() < now.getTime() - START_SKEW_MS) {
      throw bad('A policy cannot start in the past. Bookings already made are never re-priced.');
    }
    const endsAt = input.endsAt ?? null;
    if (endsAt && endsAt.getTime() <= Math.max(startsAt.getTime(), now.getTime())) {
      throw bad('The end must be after the start, and in the future.');
    }
    if (input.maxOrders != null && (!Number.isInteger(input.maxOrders) || input.maxOrders < 1)) {
      throw bad('The order limit must be a whole number of at least 1.');
    }

    const audit: AuditEntry = {
      actorUserId,
      organizationId: target.organizationId,
      action: 'PLATFORM_FEE_POLICY_CREATED',
      entityType: 'PlatformFeePolicy',
    };
    const created = await this.prisma.$transaction(async (tx) => {
      // Serialise every create for this target, so the overlap check below cannot race.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`platform-fee-policy:${input.scope}:${target.eventId ?? target.organizationId}`}))`;
      const live = await tx.platformFeePolicy.findMany({
        where: {
          scope: input.scope,
          ...(input.scope === 'EVENT'
            ? { eventId: target.eventId }
            : { organizationId: target.organizationId }),
          // A policy waiting for approval counts too: approving two overlapping ones later
          // would leave nothing to decide between them.
          status: { in: ['ACTIVE', 'EXHAUSTED', 'PENDING_APPROVAL'] },
        },
      });
      const clash = live.find(
        (p) =>
          windowsOverlap(p, { startsAt, endsAt }, now) &&
          currenciesCollide(p.currency, terms.currency),
      );
      if (clash) {
        throw new AppException(
          ErrorCodes.CONFLICT,
          input.scope === 'EVENT'
            ? clash.status === 'PENDING_APPROVAL'
              ? 'This event already has a fee policy for that time waiting for approval. Withdraw or reject it first.'
              : 'This event already has a fee policy for that time. Deactivate it first.'
            : clash.status === 'PENDING_APPROVAL'
              ? 'This organizer already has a fee policy for that time waiting for approval. Withdraw or reject it first.'
              : 'This organizer already has a fee policy for that time. Deactivate it first.',
          HttpStatus.CONFLICT,
          { conflictingPolicyId: clash.id },
        );
      }
      const row = await tx.platformFeePolicy.create({
        data: {
          scope: input.scope,
          eventId: target.eventId,
          organizationId: target.organizationId,
          ...terms,
          startsAt,
          endsAt,
          maxOrders: input.maxOrders ?? null,
          reason,
          approvalReference: input.approvalReference?.trim() || null,
          createdByUserId: actorUserId,
          // Prices nothing until a second administrator approves it.
          status: 'PENDING_APPROVAL',
        },
      });
      await tx.platformFeePolicyEvent.create({
        data: {
          policyId: row.id,
          action: 'CREATED',
          actorUserId,
          reason,
          snapshot: snapshotOf(row),
        },
      });
      audit.entityId = row.id;
      audit.metadata = snapshotOf(row);
      await this.audit.recordInTransaction(tx, audit);
      return row;
    });
    this.audit.afterCommit(audit);
    await this.notifyApprovers('POLICY_SUBMITTED', created, actorUserId, reason);
    return (await this.views([created], now))[0]!;
  }

  /**
   * Checker: approve a policy waiting for approval. From this moment it can price sales.
   *
   * Serialised with every create for the same target by the same advisory lock, and checked
   * again inside it: still pending, the version the approver read, an approver who is not the
   * creator, a window that has not ended, and no approved policy that would now overlap. A
   * start that passed while it waited moves to the approval time: nothing is re-priced.
   */
  async approve(
    actorUserId: string,
    id: string,
    body: { version: number; note?: string | null },
    now = new Date(),
  ) {
    const first = await this.mustFind(id);
    await this.assertIndependent(actorUserId, first, 'POLICY', 'approve');
    const note = body.note?.trim() || null;
    const audit: AuditEntry = {
      actorUserId,
      organizationId: first.organizationId,
      action: 'PLATFORM_FEE_POLICY_APPROVED',
      entityType: 'PlatformFeePolicy',
      entityId: id,
    };
    const committed: { eventId?: string } = {};
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(first)}))`;
      const current = await tx.platformFeePolicy.findUnique({ where: { id } });
      if (!current) throw notFound();
      if (current.status !== 'PENDING_APPROVAL') throw notPending(current);
      if (current.version !== body.version) throw moved(current);
      if (independenceFailure(actorUserId, current, 'POLICY')) throw independenceError('POLICY');
      if (current.endsAt && current.endsAt.getTime() <= now.getTime()) {
        throw new AppException(
          ErrorCodes.CONFLICT,
          'This policy ended while it waited for approval. Nothing was changed. Reject it, and create a new one if it is still needed.',
          HttpStatus.CONFLICT,
          { reason: 'ENDED_BEFORE_APPROVAL' },
        );
      }
      const startsAt = current.startsAt.getTime() < now.getTime() ? now : current.startsAt;
      const live = await tx.platformFeePolicy.findMany({
        where: {
          id: { not: id },
          scope: current.scope,
          ...(current.scope === 'EVENT'
            ? { eventId: current.eventId }
            : { organizationId: current.organizationId }),
          status: { in: ['ACTIVE', 'EXHAUSTED'] },
        },
      });
      const clash = live.find(
        (p) =>
          windowsOverlap(p, { startsAt, endsAt: current.endsAt }, now) &&
          currenciesCollide(p.currency, current.currency),
      );
      if (clash) {
        throw new AppException(
          ErrorCodes.CONFLICT,
          'Another approved fee policy now covers the same time. Nothing was changed. It must be switched off first, or this one rejected.',
          HttpStatus.CONFLICT,
          { reason: 'OVERLAPS_LIVE_POLICY', conflictingPolicyId: clash.id },
        );
      }
      const claimed = await tx.platformFeePolicy.updateMany({
        where: { id, version: body.version, status: 'PENDING_APPROVAL' },
        data: {
          status: 'ACTIVE',
          startsAt,
          approvedByUserId: actorUserId,
          approvedAt: now,
          approvalNote: note,
          version: { increment: 1 },
        },
      });
      if (claimed.count !== 1) throw moved(current);
      const after = await tx.platformFeePolicy.findUniqueOrThrow({ where: { id } });
      const event = await tx.platformFeePolicyEvent.create({
        data: {
          policyId: id,
          action: 'APPROVED',
          actorUserId,
          reason: note,
          snapshot: snapshotOf(after),
        },
      });
      audit.metadata = {
        note,
        createdByUserId: after.createdByUserId,
        version: after.version,
        policy: snapshotOf(after),
      };
      await this.audit.recordInTransaction(tx, audit);
      committed.eventId = event.id;
      return after;
    });
    this.audit.afterCommit(audit);
    await this.notifyDecision('APPROVED', row, row.createdByUserId, actorUserId, note, committed);
    return (await this.views([row], now))[0]!;
  }

  /** Checker: refuse a policy waiting for approval. Final; it never priced anything. */
  async reject(
    actorUserId: string,
    id: string,
    body: { version: number; note: string },
    now = new Date(),
  ) {
    const note = requiredNote(body.note, 'Say why the policy is rejected, so its maker knows.');
    const first = await this.mustFind(id);
    await this.assertIndependent(actorUserId, first, 'POLICY', 'reject');
    const { row, eventId } = await this.move(actorUserId, first, body.version, {
      from: 'PENDING_APPROVAL',
      data: {
        status: 'REJECTED',
        rejectedByUserId: actorUserId,
        rejectedAt: now,
        rejectionNote: note,
      },
      action: 'REJECTED',
      auditAction: 'PLATFORM_FEE_POLICY_REJECTED',
      reason: note,
    });
    await this.notifyDecision('REJECTED', row, row.createdByUserId, actorUserId, note, {
      eventId,
    });
    return (await this.views([row], now))[0]!;
  }

  /** Maker: take back a policy waiting for approval. Only its creator may. */
  async withdraw(actorUserId: string, id: string, body: { version: number }, now = new Date()) {
    const first = await this.mustFind(id);
    if (first.createdByUserId !== actorUserId) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'Only the person who created this policy can withdraw it. To stop it, reject it with a reason.',
        HttpStatus.FORBIDDEN,
        { reason: 'NOT_THE_MAKER' },
      );
    }
    const { row } = await this.move(actorUserId, first, body.version, {
      from: 'PENDING_APPROVAL',
      data: { status: 'WITHDRAWN' },
      action: 'WITHDRAWN',
      auditAction: 'PLATFORM_FEE_POLICY_WITHDRAWN',
      reason: null,
    });
    return (await this.views([row], now))[0]!;
  }

  /**
   * Maker: ask to switch a policy off. Switching off raises the fee back to the schedule, so a
   * second administrator approves it (`approveDeactivation`); until then the policy keeps
   * pricing. For a policy that must stop now, use `emergencyDeactivate`.
   *
   * `version` is the one the admin was looking at. If anything moved since, the request is
   * refused rather than applied to a row nobody has read.
   */
  async deactivate(
    actorUserId: string,
    id: string,
    body: { reason: string; version: number },
    now = new Date(),
  ) {
    const reason = body.reason?.trim() ?? '';
    if (reason.length < 10) throw bad('Say why, in at least 10 characters.');
    const first = await this.mustFind(id);
    if (first.deactivationRequestedByUserId) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'A request to switch this policy off is already waiting for approval.',
        HttpStatus.CONFLICT,
        { reason: 'DEACTIVATION_PENDING', status: first.status, version: first.version },
      );
    }
    const { row } = await this.move(actorUserId, first, body.version, {
      from: LIVE_STATES,
      whereExtra: { deactivationRequestedByUserId: null },
      data: {
        deactivationRequestedByUserId: actorUserId,
        deactivationRequestedAt: now,
        deactivationRequestReason: reason,
      },
      action: 'DEACTIVATION_REQUESTED',
      auditAction: 'PLATFORM_FEE_POLICY_DEACTIVATION_REQUESTED',
      reason,
    });
    await this.notifyApprovers('POLICY_DEACTIVATION', row, actorUserId, reason);
    return (await this.views([row], now))[0]!;
  }

  /** Checker: approve a request to switch a policy off. Final; the schedule applies again. */
  async approveDeactivation(
    actorUserId: string,
    id: string,
    body: { version: number; note?: string | null },
    now = new Date(),
  ) {
    const first = await this.mustFind(id);
    this.assertDeactivationPending(first);
    await this.assertIndependent(actorUserId, first, 'DEACTIVATION', 'approve');
    const note = body.note?.trim() || null;
    const { row, eventId } = await this.move(actorUserId, first, body.version, {
      from: LIVE_STATES,
      whereExtra: {
        deactivationRequestedByUserId: { not: null, notIn: [actorUserId] },
      },
      data: {
        status: 'INACTIVE',
        deactivatedAt: now,
        deactivatedByUserId: actorUserId,
        deactivationReason: first.deactivationRequestReason,
      },
      action: 'DEACTIVATED',
      auditAction: 'PLATFORM_FEE_POLICY_DEACTIVATED',
      reason: note ?? first.deactivationRequestReason,
      metadata: { requestedByUserId: first.deactivationRequestedByUserId, note },
    });
    await this.notifyDecision(
      'APPROVED',
      row,
      first.deactivationRequestedByUserId,
      actorUserId,
      note,
      { eventId },
      'DEACTIVATION',
    );
    return (await this.views([row], now))[0]!;
  }

  /** Checker: refuse a request to switch a policy off. The policy stays as it is. */
  async rejectDeactivation(
    actorUserId: string,
    id: string,
    body: { version: number; note: string },
    now = new Date(),
  ) {
    const note = requiredNote(body.note, 'Say why the request is rejected, so its maker knows.');
    const first = await this.mustFind(id);
    this.assertDeactivationPending(first);
    await this.assertIndependent(actorUserId, first, 'DEACTIVATION', 'reject');
    const { row, eventId } = await this.move(actorUserId, first, body.version, {
      from: LIVE_STATES,
      whereExtra: { deactivationRequestedByUserId: first.deactivationRequestedByUserId },
      data: clearRequest,
      action: 'DEACTIVATION_REJECTED',
      auditAction: 'PLATFORM_FEE_POLICY_DEACTIVATION_REJECTED',
      reason: note,
      metadata: { requestedByUserId: first.deactivationRequestedByUserId },
    });
    await this.notifyDecision(
      'REJECTED',
      row,
      first.deactivationRequestedByUserId,
      actorUserId,
      note,
      { eventId },
      'DEACTIVATION',
    );
    return (await this.views([row], now))[0]!;
  }

  /** Maker: take back a request to switch a policy off. Only the requester may. */
  async withdrawDeactivation(
    actorUserId: string,
    id: string,
    body: { version: number },
    now = new Date(),
  ) {
    const first = await this.mustFind(id);
    this.assertDeactivationPending(first);
    if (first.deactivationRequestedByUserId !== actorUserId) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'Only the person who asked to switch this policy off can withdraw the request.',
        HttpStatus.FORBIDDEN,
        { reason: 'NOT_THE_MAKER' },
      );
    }
    const { row } = await this.move(actorUserId, first, body.version, {
      from: LIVE_STATES,
      whereExtra: { deactivationRequestedByUserId: actorUserId },
      data: clearRequest,
      action: 'DEACTIVATION_WITHDRAWN',
      auditAction: 'PLATFORM_FEE_POLICY_DEACTIVATION_WITHDRAWN',
      reason: null,
    });
    return (await this.views([row], now))[0]!;
  }

  /**
   * Break glass: switch a policy off now, alone. Sales go back to the approved schedule.
   *
   * Needs PLATFORM_CONFIG and FEE_SCHEDULE_APPROVE (the controller) and a fresh second factor,
   * and a reason of at least 20 characters. Recorded as an emergency in the history and the
   * audit log, and every other approver is told to review it. Works whether or not a normal
   * request is waiting; that request is closed by it.
   */
  async emergencyDeactivate(
    actorUserId: string,
    id: string,
    body: { version: number; reason: string },
    now = new Date(),
  ) {
    const reason = body.reason?.trim() ?? '';
    if (reason.length < 20) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'An emergency switch-off needs a reason of at least 20 characters: what went wrong, and why it cannot wait for a normal approval.',
        HttpStatus.BAD_REQUEST,
        { reason: 'REASON_REQUIRED' },
      );
    }
    const first = await this.mustFind(id);
    const { row } = await this.move(actorUserId, first, body.version, {
      from: LIVE_STATES,
      data: {
        status: 'INACTIVE',
        deactivatedAt: now,
        deactivatedByUserId: actorUserId,
        deactivationReason: reason,
        emergencyDeactivation: true,
      },
      action: 'EMERGENCY_DEACTIVATED',
      auditAction: 'PLATFORM_FEE_POLICY_EMERGENCY_DEACTIVATED',
      reason,
      metadata: {
        emergency: true,
        pendingRequestByUserId: first.deactivationRequestedByUserId,
      },
    });
    await this.notifyApprovers('POLICY_EMERGENCY_DEACTIVATED', row, actorUserId, reason);
    return (await this.views([row], now))[0]!;
  }

  /**
   * What approving the pending decision would have done to recent orders.
   *
   * For a new policy: the booking fee each confirmed order for its target in the last `days`
   * paid under the rules live now, against the fee with this policy approved. For a policy
   * with a switch-off request (or any live one): the fee with it, against the fee without it.
   * Orders are re-priced on today's schedule, in their own currency, at their venue. Event
   * policies win over organizer ones, as at checkout. An estimate: a confirmed booking keeps
   * the fee it was charged.
   */
  async impact(id: string, days = 30, now = new Date()) {
    const row = await this.mustFind(id);
    const windowDays = Math.min(Math.max(Math.trunc(days) || 30, 1), 365);
    const since = new Date(now.getTime() - windowDays * 86_400_000);
    const mode: 'APPROVE' | 'DEACTIVATE' =
      row.status === 'PENDING_APPROVAL' ? 'APPROVE' : 'DEACTIVATE';
    const orders = await this.prisma.booking.findMany({
      where: {
        ...(row.scope === 'EVENT'
          ? { eventId: row.eventId! }
          : { organizationId: row.organizationId }),
        ...(row.currency ? { currency: row.currency } : {}),
        status: { in: ['CONFIRMED', 'PARTIALLY_REFUNDED'] },
        confirmedAt: { gte: since },
      },
      select: {
        eventId: true,
        organizationId: true,
        currency: true,
        subtotalMinor: true,
        discountMinor: true,
        _count: { select: { tickets: true } },
        event: { select: { feeMode: true, venue: { select: { country: true, region: true } } } },
      },
      orderBy: { confirmedAt: 'desc' },
      // Bounded: an estimate does not need every order, and this is an interactive read.
      take: 5000,
    });

    const tierCache = new Map<string, Awaited<ReturnType<PricingService['resolveFeeTiers']>>>();
    const candidateCache = new Map<string, Awaited<ReturnType<FeePolicyResolver['candidates']>>>();
    const priced: PolicyImpactOrder[] = [];
    for (const o of orders) {
      const place = o.event?.venue
        ? { country: o.event.venue.country, region: o.event.venue.region }
        : {};
      const tierKey = `${o.currency}|${place.country ?? ''}|${place.region ?? ''}`;
      let tiers = tierCache.get(tierKey);
      if (!tiers) {
        tiers = await this.pricing.resolveFeeTiers(o.currency, place);
        tierCache.set(tierKey, tiers);
      }
      let candidates = candidateCache.get(o.eventId);
      if (!candidates) {
        candidates = await this.resolver.candidates({
          eventId: o.eventId,
          organizationId: o.organizationId,
          at: now,
        });
        candidateCache.set(o.eventId, candidates);
      }
      const others = candidates.filter((c) => c.id !== row.id);
      const self = { ...row, status: 'ACTIVE', startsAt: now } as FeePolicyRow;
      const ctx = { eventId: o.eventId, organizationId: o.organizationId, at: now };
      const withSelf = selectFeePolicy([...others, self], o.currency, ctx);
      const withoutSelf = selectFeePolicy(others, o.currency, ctx);
      const [before, after] =
        mode === 'APPROVE' ? [withoutSelf, withSelf] : [withSelf, withoutSelf];
      const feeMode = (o.event?.feeMode as FeeMode | undefined) ?? FeeMode.CUSTOMER_PAYS;
      const fee = (policy: FeePolicyRow | null) =>
        calculateFeesWithPolicy({
          subtotalMinor: Math.max(0, o.subtotalMinor - (o.discountMinor ?? 0)),
          feeMode,
          currency: o.currency,
          ticketCount: Math.max(1, o._count.tickets),
          paymentFeeBps: 0,
          baseTiers: tiers!.tiers,
          policy: policy ? { ...policy, applied: appliedFeePolicy(policy) } : null,
        }).fees.bookingFeeMinor;
      priced.push({ currency: o.currency, beforeMinor: fee(before), afterMinor: fee(after) });
    }
    return {
      policyId: row.id,
      mode,
      windowDays,
      ...summariseImpact(priced),
    };
  }

  // ── Maker-checker internals ───────────────────────────────────────────────────────

  private async mustFind(id: string) {
    const row = await this.prisma.platformFeePolicy.findUnique({ where: { id } });
    if (!row) throw notFound();
    return row;
  }

  private assertDeactivationPending(row: PlatformFeePolicy) {
    if (!row.deactivationRequestedByUserId) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'There is no request to switch this policy off waiting for a decision.',
        HttpStatus.CONFLICT,
        { reason: 'NO_DEACTIVATION_PENDING', status: row.status, version: row.version },
      );
    }
  }

  /**
   * One conditional state change with its history row and audit entry, in one transaction.
   * The update only matches the version the admin read and an allowed state, so two people
   * deciding at the same moment cannot both win: the second gets a conflict.
   */
  private async move(
    actorUserId: string,
    first: PlatformFeePolicy,
    version: number,
    step: {
      from: string | readonly string[];
      whereExtra?: Prisma.PlatformFeePolicyWhereInput;
      data: Prisma.PlatformFeePolicyUpdateManyMutationInput;
      action: string;
      auditAction: string;
      reason: string | null;
      metadata?: Record<string, unknown>;
    },
  ): Promise<{ row: PlatformFeePolicy; eventId: string }> {
    const from = (
      typeof step.from === 'string' ? [step.from] : [...step.from]
    ) as Prisma.EnumPlatformFeePolicyStatusFilter['in'];
    const audit: AuditEntry = {
      actorUserId,
      organizationId: first.organizationId,
      action: step.auditAction,
      entityType: 'PlatformFeePolicy',
      entityId: first.id,
    };
    const out = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.platformFeePolicy.updateMany({
        where: { id: first.id, version, status: { in: from }, ...(step.whereExtra ?? {}) },
        data: { ...step.data, version: { increment: 1 } },
      });
      if (claimed.count !== 1) {
        const current = await tx.platformFeePolicy.findUnique({ where: { id: first.id } });
        if (!current) throw notFound();
        throw moved(current);
      }
      const after = await tx.platformFeePolicy.findUniqueOrThrow({ where: { id: first.id } });
      const event = await tx.platformFeePolicyEvent.create({
        data: {
          policyId: first.id,
          action: step.action,
          actorUserId,
          reason: step.reason,
          snapshot: snapshotOf(after),
        },
      });
      audit.metadata = {
        reason: step.reason,
        version: after.version,
        createdByUserId: after.createdByUserId,
        ...(step.metadata ?? {}),
        policy: snapshotOf(after),
      } as Prisma.InputJsonObject;
      await this.audit.recordInTransaction(tx, audit);
      return { row: after, eventId: event.id };
    });
    this.audit.afterCommit(audit);
    return out;
  }

  /** Refuse, and record the refusal, when the actor is the maker of what they decide on. */
  private async assertIndependent(
    actorUserId: string,
    row: PlatformFeePolicy,
    subject: PendingSubject,
    attempted: 'approve' | 'reject',
  ) {
    if (subject === 'POLICY' && row.status !== 'PENDING_APPROVAL') throw notPending(row);
    const failure = independenceFailure(actorUserId, row, subject);
    if (!failure) return;
    await this.audit.record({
      actorUserId,
      organizationId: row.organizationId,
      action: 'PLATFORM_FEE_POLICY_APPROVAL_REFUSED',
      entityType: 'PlatformFeePolicy',
      entityId: row.id,
      metadata: { subject, attempted, reason: failure },
    });
    throw independenceError(subject, attempted === 'reject');
  }

  /** What the policy is for, in words an approver recognises. */
  private async targetLabel(row: PlatformFeePolicy): Promise<string> {
    if (row.scope === 'EVENT' && row.eventId) {
      const e = await this.prisma.event.findUnique({
        where: { id: row.eventId },
        select: { title: true },
      });
      return e?.title ?? row.eventId;
    }
    const o = await this.prisma.organization.findUnique({
      where: { id: row.organizationId },
      select: { name: true },
    });
    return o?.name ?? row.organizationId;
  }

  /** Tell the people who may approve. Never fails the action that has already committed. */
  private async notifyApprovers(
    kind: 'POLICY_SUBMITTED' | 'POLICY_DEACTIVATION' | 'POLICY_EMERGENCY_DEACTIVATED',
    row: PlatformFeePolicy,
    actorUserId: string,
    note: string | null,
  ) {
    if (!this.audience) return;
    try {
      const [actor, target] = await Promise.all([
        this.prisma.user.findUnique({ where: { id: actorUserId }, select: { email: true } }),
        this.targetLabel(row),
      ]);
      const latest = await this.prisma.platformFeePolicyEvent.findFirst({
        where: { policyId: row.id },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      await this.audience.notifyAdminsHolding(
        [AdminPermission.FEE_SCHEDULE_APPROVE],
        NotificationType.FEE_SCHEDULE_AWAITING_APPROVAL,
        {
          kind,
          policyId: row.id,
          decisionId: latest?.id ?? `${row.id}:${row.version}`,
          currency: row.currency ?? '',
          target,
          actorEmail: actor?.email ?? '',
          note: note ?? '',
        },
        { skip: (userId) => userId === actorUserId || userId === row.createdByUserId },
      );
    } catch {
      // The change is committed; a failed lookup must not turn it into an error.
    }
  }

  /** Tell the maker what the checker decided. Never fails the decision. */
  private async notifyDecision(
    decision: 'APPROVED' | 'REJECTED',
    row: PlatformFeePolicy,
    makerUserId: string | null,
    actorUserId: string,
    note: string | null,
    committed: { eventId?: string },
    subject: PendingSubject = 'POLICY',
  ) {
    if (!this.notifications || !makerUserId) return;
    try {
      const [people, target] = await Promise.all([
        this.prisma.user.findMany({
          where: { id: { in: [makerUserId, actorUserId] } },
          select: { id: true, email: true },
        }),
        this.targetLabel(row),
      ]);
      const to = people.find((p) => p.id === makerUserId);
      if (!to) return;
      await this.notifications.send({
        type: NotificationType.FEE_SCHEDULE_DECIDED,
        userId: to.id,
        toEmail: to.email,
        payload: {
          subject: subject === 'POLICY' ? 'POLICY' : 'POLICY_DEACTIVATION',
          decision,
          decisionId: committed.eventId ?? `${row.id}:${row.version}`,
          policyId: row.id,
          currency: row.currency ?? '',
          target,
          deciderEmail: people.find((p) => p.id === actorUserId)?.email ?? '',
          note: note ?? '',
        },
      });
    } catch {
      // The decision stands whether or not the message goes out.
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────────────

  /** The event or organization a policy names, which must exist. */
  private async target(
    scope: FeePolicyScope,
    eventId?: string | null,
    organizationId?: string | null,
  ) {
    if (scope === 'EVENT') {
      if (!eventId) throw bad('Choose the event this policy is for.');
      const event = await this.prisma.event.findUnique({
        where: { id: eventId },
        select: {
          id: true,
          organizationId: true,
          feeMode: true,
          venue: { select: { country: true, region: true } },
        },
      });
      if (!event)
        throw new AppException(ErrorCodes.NOT_FOUND, 'Event not found.', HttpStatus.NOT_FOUND);
      if (organizationId && organizationId !== event.organizationId) {
        throw bad('That event belongs to a different organizer.');
      }
      return { eventId: event.id, organizationId: event.organizationId, event };
    }
    if (scope !== 'ORGANIZATION') throw bad('Scope must be EVENT or ORGANIZATION.');
    if (!organizationId) throw bad('Choose the organizer this policy is for.');
    if (eventId) throw bad('An organizer policy does not name an event.');
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    });
    if (!org)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Organizer not found.', HttpStatus.NOT_FOUND);
    return { eventId: null, organizationId: org.id, event: null };
  }

  private async whereFor(
    f: ListPolicyFilters,
    now: Date,
  ): Promise<Prisma.PlatformFeePolicyWhereInput> {
    const and: Prisma.PlatformFeePolicyWhereInput[] = [];
    if (f.scope) and.push({ scope: f.scope });
    if (f.organizationId) and.push({ organizationId: f.organizationId });
    if (f.eventId) and.push({ eventId: f.eventId });
    const notEnded: Prisma.PlatformFeePolicyWhereInput = {
      OR: [{ endsAt: null }, { endsAt: { gt: now } }],
    };
    switch (f.status) {
      case 'INACTIVE':
        and.push({ status: 'INACTIVE' });
        break;
      case 'PENDING_APPROVAL':
      case 'REJECTED':
      case 'WITHDRAWN':
        and.push({ status: f.status });
        break;
      case 'EXPIRED':
        and.push({ status: { in: [...LIVE_STATES] } });
        and.push({ OR: [{ status: 'EXPIRED' }, { endsAt: { lte: now } }] });
        break;
      case 'EXHAUSTED':
        and.push({ status: 'EXHAUSTED' }, notEnded);
        break;
      case 'SCHEDULED':
        and.push({ status: 'ACTIVE', startsAt: { gt: now } }, notEnded);
        break;
      case 'ACTIVE':
        and.push({ status: 'ACTIVE', startsAt: { lte: now } }, notEnded);
        break;
    }
    const q = f.q?.trim();
    if (q) {
      const [orgs, events] = await Promise.all([
        this.prisma.organization.findMany({
          where: { name: { contains: q, mode: 'insensitive' } },
          select: { id: true },
          take: 200,
        }),
        this.prisma.event.findMany({
          where: { title: { contains: q, mode: 'insensitive' } },
          select: { id: true },
          take: 200,
        }),
      ]);
      and.push({
        OR: [
          { id: q },
          { eventId: q },
          { organizationId: q },
          { reason: { contains: q, mode: 'insensitive' } },
          { approvalReference: { contains: q, mode: 'insensitive' } },
          { organizationId: { in: orgs.map((o) => o.id) } },
          { eventId: { in: events.map((e) => e.id) } },
        ],
      });
    }
    return and.length ? { AND: and } : {};
  }

  private async userNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((v): v is string => Boolean(v)))];
    if (!unique.length) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, fullName: true },
    });
    return new Map(users.map((u) => [u.id, u.fullName]));
  }

  private async views(rows: PlatformFeePolicy[], now: Date) {
    if (rows.length === 0) return [];
    const eventIds = [...new Set(rows.map((r) => r.eventId).filter((v): v is string => !!v))];
    const orgIds = [...new Set(rows.map((r) => r.organizationId))];
    const [events, orgs, names, counts] = await Promise.all([
      eventIds.length
        ? this.prisma.event.findMany({
            where: { id: { in: eventIds } },
            select: { id: true, title: true },
          })
        : Promise.resolve([]),
      this.prisma.organization.findMany({
        where: { id: { in: orgIds } },
        select: { id: true, name: true },
      }),
      this.userNames(
        rows.flatMap((r) => [
          r.createdByUserId,
          r.deactivatedByUserId,
          r.approvedByUserId,
          r.rejectedByUserId,
          r.deactivationRequestedByUserId,
        ]),
      ),
      this.prisma.booking.groupBy({
        by: ['feePolicyId'],
        where: { feePolicyId: { in: rows.map((r) => r.id) }, ...USED_BOOKING },
        _count: { _all: true },
      }),
    ]);
    const titleById = new Map(events.map((e) => [e.id, e.title]));
    const orgById = new Map(orgs.map((o) => [o.id, o.name]));
    const countById = new Map(counts.map((c) => [c.feePolicyId, c._count._all]));
    return rows.map((r) => ({
      id: r.id,
      scope: r.scope,
      eventId: r.eventId,
      eventTitle: r.eventId ? (titleById.get(r.eventId) ?? null) : null,
      organizationId: r.organizationId,
      organizationName: orgById.get(r.organizationId) ?? null,
      kind: r.kind,
      feeMinor: r.feeMinor,
      percentBps: r.percentBps,
      minFeeMinor: r.minFeeMinor,
      maxFeeMinor: r.maxFeeMinor,
      currency: r.currency,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      maxOrders: r.maxOrders,
      usedOrders: r.usedOrders,
      bookingCount: countById.get(r.id) ?? 0,
      status: r.status,
      effectiveStatus: effectiveFeePolicyStatus(r, now) as EffectiveStatus,
      reason: r.reason,
      approvalReference: r.approvalReference,
      createdByUserId: r.createdByUserId,
      createdByName: names.get(r.createdByUserId) ?? null,
      createdAt: r.createdAt,
      deactivatedAt: r.deactivatedAt,
      deactivatedByUserId: r.deactivatedByUserId,
      deactivationReason: r.deactivationReason,
      approvedByUserId: r.approvedByUserId,
      approvedByName: r.approvedByUserId ? (names.get(r.approvedByUserId) ?? null) : null,
      approvedAt: r.approvedAt,
      approvalNote: r.approvalNote,
      rejectedByUserId: r.rejectedByUserId,
      rejectedByName: r.rejectedByUserId ? (names.get(r.rejectedByUserId) ?? null) : null,
      rejectedAt: r.rejectedAt,
      rejectionNote: r.rejectionNote,
      deactivationRequest: r.deactivationRequestedByUserId
        ? {
            requestedByUserId: r.deactivationRequestedByUserId,
            requestedByName: names.get(r.deactivationRequestedByUserId) ?? null,
            requestedAt: r.deactivationRequestedAt,
            reason: r.deactivationRequestReason,
          }
        : null,
      emergencyDeactivation: r.emergencyDeactivation,
      version: r.version,
    }));
  }
}

function lines(f: FeeCalcResult) {
  return {
    bookingFeeMinor: f.bookingFeeMinor,
    paymentFeeMinor: f.paymentFeeMinor,
    customerFeeMinor: f.customerFeeMinor,
    organizerFeeMinor: f.organizerFeeMinor,
    totalMinor: f.totalMinor,
    // How a per-ticket fee (COMBINED, FIXED_PER_TICKET) was worked out, when it is one.
    ...(f.platformFeeBreakdown ? { platformFeeBreakdown: f.platformFeeBreakdown } : {}),
  };
}

function snapshotOf(r: PlatformFeePolicy): Prisma.InputJsonObject {
  return {
    scope: r.scope,
    eventId: r.eventId,
    organizationId: r.organizationId,
    kind: r.kind,
    feeMinor: r.feeMinor,
    percentBps: r.percentBps,
    minFeeMinor: r.minFeeMinor,
    maxFeeMinor: r.maxFeeMinor,
    currency: r.currency,
    startsAt: r.startsAt.toISOString(),
    endsAt: r.endsAt?.toISOString() ?? null,
    maxOrders: r.maxOrders,
    usedOrders: r.usedOrders,
    status: r.status,
    version: r.version,
    approvalReference: r.approvalReference,
    approvedByUserId: r.approvedByUserId,
    deactivationRequestedByUserId: r.deactivationRequestedByUserId,
    emergencyDeactivation: r.emergencyDeactivation,
  };
}

// ── Maker-checker helpers ─────────────────────────────────────────────────────────────

/** What is waiting for a second person on a policy: the policy itself, or its switch-off. */
export type PendingSubject = 'POLICY' | 'DEACTIVATION';

/** Why `actorUserId` may not decide, or null when they may. */
export type PolicyIndependenceFailure = 'CREATOR' | 'REQUESTER';

/**
 * Judged on identity, never on role: a super admin who created a policy (or asked to switch it
 * off) is still its maker and cannot approve or reject it.
 */
export function independenceFailure(
  actorUserId: string,
  row: Pick<PlatformFeePolicy, 'createdByUserId' | 'deactivationRequestedByUserId'>,
  subject: PendingSubject,
): PolicyIndependenceFailure | null {
  if (subject === 'POLICY') return row.createdByUserId === actorUserId ? 'CREATOR' : null;
  return row.deactivationRequestedByUserId === actorUserId ? 'REQUESTER' : null;
}

/** What on this policy is waiting for a decision, if anything. */
export function pendingDecision(
  row: Pick<PlatformFeePolicy, 'status' | 'deactivationRequestedByUserId'>,
): PendingSubject | null {
  if (row.status === 'PENDING_APPROVAL') return 'POLICY';
  if (row.deactivationRequestedByUserId && row.status !== 'INACTIVE') return 'DEACTIVATION';
  return null;
}

/** The advisory-lock key create and approve share for one target. */
function lockKey(row: Pick<PlatformFeePolicy, 'scope' | 'eventId' | 'organizationId'>): string {
  return `platform-fee-policy:${row.scope}:${row.eventId ?? row.organizationId}`;
}

const clearRequest: Prisma.PlatformFeePolicyUpdateManyMutationInput = {
  deactivationRequestedByUserId: null,
  deactivationRequestedAt: null,
  deactivationRequestReason: null,
};

function requiredNote(note: string | null | undefined, message: string): string {
  const clean = note?.trim() ?? '';
  if (clean.length < 5) {
    throw new AppException(ErrorCodes.VALIDATION_FAILED, message, HttpStatus.BAD_REQUEST, {
      reason: 'NOTE_REQUIRED',
    });
  }
  return clean;
}

function notFound() {
  return new AppException(ErrorCodes.NOT_FOUND, 'Fee policy not found.', HttpStatus.NOT_FOUND);
}

function notPending(row: Pick<PlatformFeePolicy, 'status' | 'version'>) {
  return new AppException(
    ErrorCodes.CONFLICT,
    'This policy is not waiting for approval.',
    HttpStatus.CONFLICT,
    { reason: 'NOT_PENDING', status: row.status, version: row.version },
  );
}

function moved(row: Pick<PlatformFeePolicy, 'status' | 'version'>) {
  return new AppException(
    ErrorCodes.CONFLICT,
    row.status === 'INACTIVE'
      ? 'This policy is already inactive.'
      : 'This policy changed since you opened it. Reload and try again.',
    HttpStatus.CONFLICT,
    { reason: 'POLICY_MOVED', status: row.status, version: row.version },
  );
}

function independenceError(subject: PendingSubject, reject = false) {
  const what = subject === 'POLICY' ? 'a fee policy you created' : 'a switch-off you asked for';
  return new AppException(
    ErrorCodes.SEPARATION_OF_DUTIES,
    `You cannot ${reject ? 'reject' : 'approve'} ${what}. Another administrator must decide.`,
    HttpStatus.FORBIDDEN,
    { reason: 'APPROVER_IS_MAKER', rule: 'FEE_POLICY_APPROVER_INDEPENDENT' },
  );
}

export interface PolicyImpactOrder {
  currency: string;
  beforeMinor: number;
  afterMinor: number;
}

export interface PolicyImpactCurrency {
  currency: string;
  orders: number;
  beforeFeeMinor: number;
  afterFeeMinor: number;
  deltaMinor: number;
  higher: number;
  lower: number;
  unchanged: number;
  largestIncreaseMinor: number;
  largestDecreaseMinor: number;
}

/**
 * Totals per currency, never across them: summing rupees and dollars into one figure is the
 * defect `money-per-currency` fixed elsewhere. `direction` says which way buyers' fees move.
 */
export function summariseImpact(orders: readonly PolicyImpactOrder[]): {
  orders: number;
  direction: 'INCREASE' | 'DECREASE' | 'MIXED' | 'NONE';
  currencies: PolicyImpactCurrency[];
} {
  const by = new Map<string, PolicyImpactCurrency>();
  for (const o of orders) {
    let c = by.get(o.currency);
    if (!c) {
      c = {
        currency: o.currency,
        orders: 0,
        beforeFeeMinor: 0,
        afterFeeMinor: 0,
        deltaMinor: 0,
        higher: 0,
        lower: 0,
        unchanged: 0,
        largestIncreaseMinor: 0,
        largestDecreaseMinor: 0,
      };
      by.set(o.currency, c);
    }
    const delta = o.afterMinor - o.beforeMinor;
    c.orders += 1;
    c.beforeFeeMinor += o.beforeMinor;
    c.afterFeeMinor += o.afterMinor;
    c.deltaMinor += delta;
    if (delta > 0) {
      c.higher += 1;
      c.largestIncreaseMinor = Math.max(c.largestIncreaseMinor, delta);
    } else if (delta < 0) {
      c.lower += 1;
      c.largestDecreaseMinor = Math.max(c.largestDecreaseMinor, -delta);
    } else {
      c.unchanged += 1;
    }
  }
  const currencies = [...by.values()].sort((a, b) => a.currency.localeCompare(b.currency));
  const up = currencies.some((c) => c.higher > 0);
  const down = currencies.some((c) => c.lower > 0);
  return {
    orders: orders.length,
    direction: up && down ? 'MIXED' : up ? 'INCREASE' : down ? 'DECREASE' : 'NONE',
    currencies,
  };
}
