import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';

function paginate(page: number, pageSize: number, total: number) {
  return { page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async bookings(params: { page: number; pageSize: number; status?: string; q?: string }) {
    const where = {
      ...(params.status ? { status: params.status as never } : {}),
      ...(params.q
        ? {
            OR: [
              { buyerEmail: { contains: params.q, mode: 'insensitive' as const } },
              { reference: { contains: params.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.booking.count({ where }),
      this.prisma.booking.findMany({
        where,
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        orderBy: { createdAt: 'desc' },
        include: { event: { select: { title: true } }, payment: { select: { status: true } } },
      }),
    ]);
    return {
      data: rows.map((b) => ({
        id: b.id,
        reference: b.reference,
        status: b.status,
        buyerEmail: b.buyerEmail,
        totalMinor: b.totalMinor,
        // An amount without its currency gets formatted as rupees; a USD booking read "₹".
        currency: b.currency,
        createdAt: b.createdAt,
        event: { title: b.event.title },
        paymentStatus: b.payment?.status ?? null,
      })),
      meta: paginate(params.page, params.pageSize, total),
    };
  }

  async payments(params: { page: number; pageSize: number; status?: string }) {
    const where = params.status ? { status: params.status as never } : {};
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.payment.count({ where }),
      this.prisma.payment.findMany({
        where,
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        orderBy: { createdAt: 'desc' },
        include: { booking: { select: { buyerEmail: true } } },
      }),
    ]);
    return {
      data: rows.map((p) => ({
        id: p.id,
        status: p.status,
        amountMinor: p.amountMinor,
        // Money carries its own currency: the page cannot know a Stripe charge was dollars.
        currency: p.currency,
        provider: p.provider,
        providerRef: p.providerRef,
        createdAt: p.createdAt,
        bookingId: p.bookingId,
        buyerEmail: p.booking.buyerEmail,
      })),
      meta: paginate(params.page, params.pageSize, total),
    };
  }

  feeRules() {
    return this.prisma.feeRule.findMany({ orderBy: [{ currency: 'asc' }, { minMinor: 'asc' }] });
  }

  /**
   * Update one platform fee rule.
   *
   * Booking fees are money, so this validates the resulting band rather than trusting the
   * caller. Two checks matter beyond "is it a number":
   *
   *  - `maxMinor` must exceed `minMinor`. An inverted band matches nothing, and because the
   *    resolver falls through to the last tier on no match, an inverted band silently
   *    reprices every booking in that range to whatever the top tier charges.
   *  - Bands must not overlap another ACTIVE rule in the same currency. `resolveBookingFee`
   *    returns the first match, so an overlap makes the fee depend on row order — the same
   *    subtotal could be charged differently after an unrelated edit.
   *
   * Currency is deliberately immutable: moving a rule between currencies would silently
   * reinterpret its minor-unit amounts (₹5 becoming $5). Create a new rule instead.
   */
  /**
   * Create a fee-rule band in an existing currency.
   *
   * Shares the band validation with the update path: an inverted band matches nothing (and
   * falls through to the top tier), and an overlap makes the charge depend on row order,
   * because resolution is first-match. Both fail silently at booking time, so they are
   * refused here.
   */
  async createFeeRule(
    actorUserId: string,
    input: {
      currency: string;
      label: string;
      minMinor: number;
      maxMinor: number | null;
      feeMinor?: number;
      feeType?: 'FLAT' | 'PERCENT';
      feePercentBps?: number | null;
      minFeeMinor?: number | null;
      maxFeeMinor?: number | null;
      country?: string;
      region?: string;
      active?: boolean;
    },
  ) {
    const active = input.active ?? true;
    this.assertBandShape(input.minMinor, input.maxMinor);
    const charge = this.normaliseCharge({
      feeType: input.feeType ?? 'FLAT',
      feeMinor: input.feeMinor,
      feePercentBps: input.feePercentBps ?? null,
      minFeeMinor: input.minFeeMinor ?? null,
      maxFeeMinor: input.maxFeeMinor ?? null,
    });
    if (active) {
      await this.assertNoOverlap(input.currency, input.minMinor, input.maxMinor, null, {
        country: input.country ?? '*',
        region: input.region ?? '*',
      });
    }

    const created = await this.prisma.feeRule.create({
      data: {
        currency: input.currency,
        label: input.label,
        minMinor: input.minMinor,
        maxMinor: input.maxMinor,
        ...charge,
        country: input.country ?? '*',
        region: input.region ?? '*',
        active,
      },
    });

    await this.audit.record({
      actorUserId,
      action: 'FEE_RULE_CREATED',
      entityType: 'FeeRule',
      entityId: created.id,
      metadata: {
        currency: created.currency,
        label: created.label,
        minMinor: created.minMinor,
        maxMinor: created.maxMinor,
        feeMinor: created.feeMinor,
        feeType: created.feeType,
        feePercentBps: created.feePercentBps,
        minFeeMinor: created.minFeeMinor,
        maxFeeMinor: created.maxFeeMinor,
        active: created.active,
      },
    });

    return created;
  }

  /**
   * How a band charges, checked and made consistent before it is stored.
   *
   * A booking fee is money taken from a customer, so a band that cannot charge sensibly is
   * refused here rather than discovered at checkout:
   *
   *  - FLAT needs its amount. Its percentage fields are cleared, so a band switched from PERCENT
   *    back to FLAT does not carry a dead 5% that a later reader might believe.
   *  - PERCENT needs its percentage. `feeMinor` is stored as 0 because nothing reads it, and a
   *    stale fixed amount left beside a percentage invites somebody to think both apply.
   *  - A floor above the ceiling is refused. The calculator would still cap at the ceiling, but
   *    a band whose floor can never be reached is a typo that should be caught while the person
   *    who made it is still looking at the form.
   */
  private normaliseCharge(c: {
    feeType: 'FLAT' | 'PERCENT';
    feeMinor: number | undefined;
    feePercentBps: number | null;
    minFeeMinor: number | null;
    maxFeeMinor: number | null;
  }): {
    feeType: 'FLAT' | 'PERCENT';
    feeMinor: number;
    feePercentBps: number | null;
    minFeeMinor: number | null;
    maxFeeMinor: number | null;
  } {
    if (c.feeType === 'FLAT') {
      if (c.feeMinor === undefined) {
        throw new AppException(
          ErrorCodes.VALIDATION_FAILED,
          'A fixed-amount band needs its booking fee amount.',
        );
      }
      return {
        feeType: 'FLAT',
        feeMinor: c.feeMinor,
        feePercentBps: null,
        minFeeMinor: null,
        maxFeeMinor: null,
      };
    }
    if (c.feePercentBps === null || c.feePercentBps < 1 || c.feePercentBps > 10_000) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'A percentage band needs a percentage above 0% and no more than 100%.',
      );
    }
    if (c.minFeeMinor !== null && c.maxFeeMinor !== null && c.minFeeMinor > c.maxFeeMinor) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'The minimum fee cannot be more than the maximum fee.',
      );
    }
    return {
      feeType: 'PERCENT',
      feeMinor: 0,
      feePercentBps: c.feePercentBps,
      minFeeMinor: c.minFeeMinor,
      maxFeeMinor: c.maxFeeMinor,
    };
  }

  /** An inverted band matches nothing and silently reprices via the fall-through tier. */
  private assertBandShape(minMinor: number, maxMinor: number | null): void {
    if (maxMinor !== null && maxMinor <= minMinor) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'The upper bound must be greater than the lower bound (use no upper bound for the top band).',
      );
    }
  }

  /** Fees resolve by first match, so overlapping active bands make the charge order-dependent. */
  /**
   * Two bands may not cover the same amount IN THE SAME PLACE.
   *
   * ── WHY THE PLACE IS PART OF THE QUESTION ──────────────────────────────────────
   * Overlap used to be judged per currency, which was right while a currency was the only
   * scope a band had. Now that a band can name a country and a state, a Telangana ₹5 rule and
   * a national ₹20 rule cover the same amounts on purpose — the state one replaces the
   * national one where it applies. Judging those as a clash would make the feature
   * unusable by refusing exactly the edit it exists to allow.
   *
   * So the comparison is within one (currency, country, region) scope. Across scopes,
   * specificity decides — see `PricingService.loadTiers`.
   */
  private async assertNoOverlap(
    currency: string,
    minMinor: number,
    maxMinor: number | null,
    excludeId: string | null,
    scope: { country: string; region: string } = { country: '*', region: '*' },
  ): Promise<void> {
    const siblings = await this.prisma.feeRule.findMany({
      where: {
        currency,
        country: scope.country,
        region: scope.region,
        active: true,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
    const hi = (m: number | null) => (m === null ? Number.MAX_SAFE_INTEGER : m);
    const clash = siblings.find((s) => minMinor <= hi(s.maxMinor) && s.minMinor <= hi(maxMinor));
    if (clash) {
      const where =
        scope.region !== '*'
          ? `${scope.region}, ${scope.country}`
          : scope.country !== '*'
            ? scope.country
            : 'everywhere';
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        `This band overlaps the active rule "${clash.label}" for ${currency} in ${where}. Fees are resolved by first match, so overlapping bands in one place make the charge depend on row order.`,
      );
    }
  }

  async updateFeeRule(
    actorUserId: string,
    id: string,
    patch: {
      label?: string;
      minMinor?: number;
      maxMinor?: number | null;
      feeMinor?: number;
      feeType?: 'FLAT' | 'PERCENT';
      feePercentBps?: number | null;
      minFeeMinor?: number | null;
      maxFeeMinor?: number | null;
      country?: string;
      region?: string;
      active?: boolean;
    },
  ) {
    const existing = await this.prisma.feeRule.findUnique({ where: { id } });
    if (!existing) throw new AppException(ErrorCodes.NOT_FOUND, 'Fee rule not found.');

    // Each charge field falls back to what is stored, so a patch that only changes the label
    // of a percentage band keeps its percentage, floor and ceiling.
    const pick = <T>(value: T | undefined, stored: T): T => (value === undefined ? stored : value);
    const charge = this.normaliseCharge({
      // A row with no type predates percentages, and every such row was a fixed amount.
      feeType: pick(patch.feeType, existing.feeType) ?? 'FLAT',
      feeMinor: pick(patch.feeMinor, existing.feeMinor),
      feePercentBps: pick(patch.feePercentBps, existing.feePercentBps),
      minFeeMinor: pick(patch.minFeeMinor, existing.minFeeMinor),
      maxFeeMinor: pick(patch.maxFeeMinor, existing.maxFeeMinor),
    });
    const next = {
      label: patch.label ?? existing.label,
      minMinor: patch.minMinor ?? existing.minMinor,
      maxMinor: patch.maxMinor === undefined ? existing.maxMinor : patch.maxMinor,
      ...charge,
      country: patch.country ?? existing.country,
      region: patch.region ?? existing.region,
      active: patch.active ?? existing.active,
    };

    // Same two guards the create path applies — an inverted band silently reprices via the
    // fall-through tier, and an overlap makes the charge depend on row order.
    this.assertBandShape(next.minMinor, next.maxMinor);
    if (next.active) {
      await this.assertNoOverlap(existing.currency, next.minMinor, next.maxMinor, id, {
        country: next.country,
        region: next.region,
      });
    }

    const updated = await this.prisma.feeRule.update({ where: { id }, data: next });

    await this.audit.record({
      actorUserId,
      action: 'FEE_RULE_UPDATED',
      entityType: 'FeeRule',
      entityId: id,
      // Before/after on money configuration — the point of the audit trail.
      metadata: {
        currency: existing.currency,
        before: {
          label: existing.label,
          minMinor: existing.minMinor,
          maxMinor: existing.maxMinor,
          feeMinor: existing.feeMinor,
          feeType: existing.feeType,
          feePercentBps: existing.feePercentBps,
          minFeeMinor: existing.minFeeMinor,
          maxFeeMinor: existing.maxFeeMinor,
          active: existing.active,
        },
        after: next,
      },
    });

    return updated;
  }
}
