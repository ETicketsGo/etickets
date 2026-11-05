import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type PlatformFeePolicy } from '@prisma/client';
import { FeeMode } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService, type AuditEntry } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import { PricingService } from '../pricing/pricing.service';
import {
  appliedFeePolicy,
  calculateFeesWithPolicy,
  currenciesCollide,
  effectiveFeePolicyStatus,
  windowsOverlap,
  type FeePolicyKind,
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
 */

export type EffectiveStatus = 'ACTIVE' | 'SCHEDULED' | 'EXPIRED' | 'EXHAUSTED' | 'INACTIVE';

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

  async detail(id: string, now = new Date()) {
    const row = await this.prisma.platformFeePolicy.findUnique({ where: { id } });
    if (!row)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Fee policy not found.', HttpStatus.NOT_FOUND);
    const [view] = await this.views([row], now);
    const history = await this.prisma.platformFeePolicyEvent.findMany({
      where: { policyId: id },
      orderBy: { createdAt: 'asc' },
    });
    const names = await this.userNames(history.map((h) => h.actorUserId));
    return {
      ...view!,
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
          status: { in: ['ACTIVE', 'EXHAUSTED'] },
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
            ? 'This event already has a fee policy for that time. Deactivate it first.'
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
    return (await this.views([created], now))[0]!;
  }

  /**
   * Switch a policy off. Final: to bring the terms back, create a new policy.
   *
   * `version` is the one the admin was looking at. If anything moved since (another admin
   * deactivated it), the request is refused rather than applied to a row nobody has read.
   * Unpaid holds already priced under it keep that price until they are paid or released.
   */
  async deactivate(
    actorUserId: string,
    id: string,
    body: { reason: string; version: number },
    now = new Date(),
  ) {
    const reason = body.reason?.trim() ?? '';
    if (reason.length < 10) throw bad('Say why, in at least 10 characters.');
    const audit: AuditEntry = {
      actorUserId,
      action: 'PLATFORM_FEE_POLICY_DEACTIVATED',
      entityType: 'PlatformFeePolicy',
      entityId: id,
    };
    const row = await this.prisma.$transaction(async (tx) => {
      const moved = await tx.platformFeePolicy.updateMany({
        where: { id, version: body.version, status: { in: ['ACTIVE', 'EXHAUSTED', 'EXPIRED'] } },
        data: {
          status: 'INACTIVE',
          deactivatedAt: now,
          deactivatedByUserId: actorUserId,
          deactivationReason: reason,
          version: { increment: 1 },
        },
      });
      if (moved.count !== 1) {
        const current = await tx.platformFeePolicy.findUnique({ where: { id } });
        if (!current) {
          throw new AppException(
            ErrorCodes.NOT_FOUND,
            'Fee policy not found.',
            HttpStatus.NOT_FOUND,
          );
        }
        throw new AppException(
          ErrorCodes.CONFLICT,
          current.status === 'INACTIVE'
            ? 'This policy is already inactive.'
            : 'This policy changed since you opened it. Reload and try again.',
          HttpStatus.CONFLICT,
          { status: current.status, version: current.version },
        );
      }
      const after = await tx.platformFeePolicy.findUniqueOrThrow({ where: { id } });
      await tx.platformFeePolicyEvent.create({
        data: {
          policyId: id,
          action: 'DEACTIVATED',
          actorUserId,
          reason,
          snapshot: snapshotOf(after),
        },
      });
      audit.organizationId = after.organizationId;
      audit.metadata = { reason, version: after.version, policy: snapshotOf(after) };
      await this.audit.recordInTransaction(tx, audit);
      return after;
    });
    this.audit.afterCommit(audit);
    return (await this.views([row], now))[0]!;
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
      case 'EXPIRED':
        and.push({ status: { not: 'INACTIVE' } });
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
      this.userNames(rows.flatMap((r) => [r.createdByUserId, r.deactivatedByUserId])),
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
  };
}
