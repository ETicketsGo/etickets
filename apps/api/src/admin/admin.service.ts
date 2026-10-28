import { HttpStatus, Injectable } from '@nestjs/common';
import { feeBandLabel, money } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import { deletionImpact, type CoverageGap } from './fee-band-coverage';
import { groupScopeWhere, type GroupScope } from './group-scope';
import { countryWhere } from './country-filter';
import { allOf, dayRangeWhere, type ListFilters } from './list-filters';

function paginate(page: number, pageSize: number, total: number) {
  return { page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async bookings(
    params: {
      page: number;
      pageSize: number;
      status?: string;
      q?: string;
      country?: string;
    } & GroupScope &
      ListFilters,
  ) {
    const country = countryWhere('bookings', params.country);
    const created = dayRangeWhere(params.from, params.to);
    /*
      The organizer, event and day window the money queues already filter by. Read-only narrowing
      of which bookings are listed - the same columns the grouped summary filters on (see
      `FILTERS` in the grouping service), so the summary above the list still adds up to it.
    */
    const narrowing = allOf(
      country,
      params.organizationId ? { organizationId: params.organizationId } : null,
      params.eventId ? { eventId: params.eventId } : null,
      created ? { createdAt: created } : null,
    );
    const where = {
      /*
        The group scope is spread FIRST and the search after it, because both can produce a
        top-level key and only one of them may be lost. The scope is a set of AND-ed relation
        filters and the search is an `OR` - they cannot collide - but the order says which is
        load-bearing: a list that dropped its scope would show every country while the summary
        above it said India.
      */
      ...groupScopeWhere('bookings', params),
      ...(params.status ? { status: params.status as never } : {}),
      ...(params.q
        ? {
            OR: [
              { buyerEmail: { contains: params.q, mode: 'insensitive' as const } },
              { reference: { contains: params.q, mode: 'insensitive' as const } },
              // What an admin remembers about a sale is the event it was for.
              { event: { title: { contains: params.q, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
      // In `AND`, not spread: the group scope can also name `event`, and one must not erase the other.
      ...(narrowing.length > 0 ? { AND: narrowing } : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.booking.count({ where }),
      this.prisma.booking.findMany({
        where,
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          event: { select: { title: true, venue: { select: { country: true } } } },
          payment: { select: { status: true } },
        },
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
        // Where the sale happened: the venue's country, as stored. The console names it.
        country: b.event.venue?.country ?? null,
        paymentStatus: b.payment?.status ?? null,
      })),
      meta: paginate(params.page, params.pageSize, total),
    };
  }

  /**
   * The payment ledger.
   *
   * Search reaches the database, like the booking queue beside it already did: it used to filter
   * the fetched page in the browser, so looking for a buyer found them only if they were already
   * on screen. A provider reference is searchable too, because that is what a provider's own
   * dashboard gives you when you are chasing one charge.
   *
   * The booking's reference and event come back as well. A payment on its own is an amount and
   * an opaque id; what somebody actually needs is which sale it was.
   */
  async payments(
    params: { page: number; pageSize: number; status?: string; q?: string } & GroupScope &
      ListFilters,
  ) {
    const created = dayRangeWhere(params.from, params.to);
    /*
      Every condition in one `AND`, never spread side by side. The group scope, the organizer,
      the event and the country all reach through `booking`, and two spreads naming the same
      top-level key let the later one silently erase the earlier - a list that drops a filter
      shows more rows than its heading claims.
    */
    const where = {
      AND: allOf(
        groupScopeWhere('payments', params),
        params.status ? { status: params.status as never } : null,
        params.q
          ? {
              OR: [
                { providerRef: { contains: params.q, mode: 'insensitive' as const } },
                { booking: { buyerEmail: { contains: params.q, mode: 'insensitive' as const } } },
                { booking: { reference: { contains: params.q, mode: 'insensitive' as const } } },
                {
                  booking: {
                    event: { title: { contains: params.q, mode: 'insensitive' as const } },
                  },
                },
              ],
            }
          : null,
        countryWhere('payments', params.country),
        // The booking's organizer, the same column the grouped summary groups by.
        params.organizationId ? { booking: { organizationId: params.organizationId } } : null,
        params.eventId ? { booking: { eventId: params.eventId } } : null,
        created ? { createdAt: created } : null,
      ),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.payment.count({ where }),
      this.prisma.payment.findMany({
        where,
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          booking: {
            select: { buyerEmail: true, reference: true, event: { select: { title: true } } },
          },
        },
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
        bookingReference: p.booking.reference,
        eventTitle: p.booking.event.title,
      })),
      meta: paginate(params.page, params.pageSize, total),
    };
  }

  /**
   * Every fee band, each with the name it is shown under.
   *
   * `displayLabel` is written from the band's boundaries (`feeBandLabel`) every time, so it
   * cannot describe a range the band no longer has. The stored `label` is returned untouched as
   * history. Deleted bands are left out unless asked for: they price nothing and are kept only
   * so the audit trail points at a real row.
   */
  async feeRules(opts: { includeDeleted?: boolean } = {}) {
    const rows = await this.prisma.feeRule.findMany({
      where: opts.includeDeleted ? {} : { deletedAt: null },
      orderBy: [{ currency: 'asc' }, { minMinor: 'asc' }],
    });
    return rows.map((r) => ({ ...r, displayLabel: feeBandLabel(r, r.currency) }));
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
      /** Optional: a band is shown under the name its boundaries give it (see `feeRules`). */
      label?: string;
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
        // Stored for history only. Nothing displays it; `feeRules` writes the shown name.
        label: input.label?.trim() || feeBandLabel(input, input.currency),
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
      // 409: the band itself is well formed; it conflicts with another band that exists.
      throw new AppException(
        ErrorCodes.CONFLICT,
        `This band overlaps the active rule "${feeBandLabel(clash, currency)}" for ${currency} in ${where}. Fees are resolved by first match, so overlapping bands in one place make the charge depend on row order.`,
        HttpStatus.CONFLICT,
        { conflictingRuleId: clash.id },
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
    // A deleted band stays deleted. Editing it back to life would skip the coverage checks the
    // delete passed, and the audit trail would show a delete that did not hold.
    if (existing.deletedAt) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'This fee band was deleted and cannot be changed. Add a new band instead.',
        HttpStatus.CONFLICT,
      );
    }

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

  /**
   * Delete a fee band. SOFT: the row is switched off and stamped with who deleted it and when.
   *
   * ── WHY SOFT ──────────────────────────────────────────────────────────────────────
   * A booking never pointed at a band - it snapshots `bookingFeeMinor` and the rest - so a hard
   * delete would not change a sale. But the audit log names bands by id, and a finance review
   * reading "FEE_RULE_UPDATED fr_123" must be able to open fr_123. Kept, switched off, hidden
   * from the editor.
   *
   * ── WHAT IS REFUSED (409) ─────────────────────────────────────────────────────────
   * See `fee-band-coverage.ts`. In short: a delete that leaves the band's place with no band at
   * all (pricing would silently use the built-in India defaults, in any currency), or that opens
   * a range of order amounts no band covers (the nearest band would quietly price it). The
   * message names the range so the admin knows which neighbour to widen first.
   *
   * An inactive band prices nothing, so deleting one is always allowed. That is also the way to
   * retire a band whose range a neighbour should take over: switch it off, widen the neighbour,
   * then delete it.
   */
  async deleteFeeRule(actorUserId: string, id: string) {
    const existing = await this.prisma.feeRule.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Fee rule not found.', HttpStatus.NOT_FOUND);
    }
    const label = feeBandLabel(existing, existing.currency);
    const where =
      existing.region !== '*'
        ? `${existing.region}, ${existing.country}`
        : existing.country !== '*'
          ? existing.country
          : 'everywhere';

    if (existing.active) {
      const active = await this.prisma.feeRule.findMany({
        where: { currency: existing.currency, active: true, deletedAt: null },
      });
      const impact = deletionImpact(existing, active, existing.currency);
      if (!impact.ok && impact.reason === 'NO_BAND_LEFT') {
        throw new AppException(
          ErrorCodes.CONFLICT,
          `"${label}" is the last active ${existing.currency} band for ${where}. Deleting it would leave no band there, and those orders would be charged the built-in default fees. Add the replacement band first.`,
          HttpStatus.CONFLICT,
          { reason: 'NO_BAND_LEFT' },
        );
      }
      if (!impact.ok && impact.reason === 'GAP') {
        throw new AppException(
          ErrorCodes.CONFLICT,
          `Deleting "${label}" would leave ${describeGaps(impact.gaps, existing.currency)} with no ${existing.currency} band in ${where}. Change a neighbouring band to cover that range first: switch this band off, widen the neighbour, then delete this band.`,
          HttpStatus.CONFLICT,
          { reason: 'GAP', gaps: impact.gaps },
        );
      }
    }

    const deleted = await this.prisma.feeRule.update({
      where: { id },
      data: { active: false, deletedAt: new Date(), deletedByUserId: actorUserId },
    });

    await this.audit.record({
      actorUserId,
      action: 'FEE_RULE_DELETED',
      entityType: 'FeeRule',
      entityId: id,
      metadata: {
        currency: existing.currency,
        displayLabel: label,
        before: {
          label: existing.label,
          minMinor: existing.minMinor,
          maxMinor: existing.maxMinor,
          feeMinor: existing.feeMinor,
          feeType: existing.feeType,
          feePercentBps: existing.feePercentBps,
          minFeeMinor: existing.minFeeMinor,
          maxFeeMinor: existing.maxFeeMinor,
          country: existing.country,
          region: existing.region,
          active: existing.active,
        },
      },
    });

    return { ...deleted, displayLabel: label };
  }
}

/** An uncovered range in words, for the refusal: "orders between Rs 499 and Rs 1,000". */
function describeGaps(gaps: CoverageGap[], currency: string): string {
  return gaps
    .map((g) => {
      if (g.afterMinor === null && g.beforeMinor === null) return 'every order';
      if (g.afterMinor === null) return `orders below ${money(g.beforeMinor ?? 0, currency)}`;
      if (g.beforeMinor === null) return `orders above ${money(g.afterMinor, currency)}`;
      return `orders between ${money(g.afterMinor, currency)} and ${money(g.beforeMinor, currency)}`;
    })
    .join(' and ');
}
