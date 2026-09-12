import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Role } from '@eticketsgo/shared-types';
import type { CreateCouponInput, UpdateCouponInput } from '@eticketsgo/validation';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import { currencyForCountry } from '../common/country';
import type { RequestUser } from '../common/decorators';

const ORGANIZER_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER];

/**
 * Organizer-facing discount-code management. The redemption + discount math already
 * live in the booking/checkout path (`resolveCoupon` / `computeCouponDiscountMinor`);
 * this only adds authoring CRUD on top of the existing `Coupon` model. Org-scoped and
 * audited; never mutates a coupon's redemption count (only checkout does).
 */
@Injectable()
export class CouponsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    private readonly audit: AuditService,
  ) {}

  async list(user: RequestUser, organizationId: string, page = 1, pageSize = 25) {
    await this.access.assertMember(user, organizationId, ORGANIZER_ROLES);
    const take = Math.min(100, Math.max(1, pageSize));
    const skip = (Math.max(1, page) - 1) * take;
    const [rows, total] = await Promise.all([
      this.prisma.coupon.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.coupon.count({ where: { organizationId } }),
    ]);
    return {
      data: rows,
      meta: {
        page: Math.max(1, page),
        pageSize: take,
        total,
        totalPages: Math.max(1, Math.ceil(total / take)),
      },
    };
  }

  async create(user: RequestUser, input: CreateCouponInput) {
    await this.access.assertMember(user, input.organizationId, ORGANIZER_ROLES);
    const currency = await this.currencyFor(input.organizationId, input.type, input.currency);
    try {
      const coupon = await this.prisma.coupon.create({
        data: {
          organizationId: input.organizationId,
          code: input.code,
          type: input.type,
          value: input.value,
          currency,
          maxRedemptions: input.maxRedemptions,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          // Private unless deliberately published — see the schema comment. Publishing is a
          // one-way door in practice: a code buyers have already seen cannot be unseen.
          isPublic: input.isPublic ?? false,
          publicLabel: input.publicLabel,
          status: 'ACTIVE',
        },
      });
      await this.audit.record({
        actorUserId: user.id,
        organizationId: input.organizationId,
        action: 'COUPON_CREATED',
        entityType: 'Coupon',
        entityId: coupon.id,
        metadata: {
          code: coupon.code,
          type: coupon.type,
          value: coupon.value,
          currency: coupon.currency,
          isPublic: coupon.isPublic,
        },
      });
      return coupon;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new AppException(
          ErrorCodes.CONFLICT,
          'That coupon code is already in use.',
          HttpStatus.CONFLICT,
        );
      }
      throw e;
    }
  }

  async update(user: RequestUser, id: string, input: UpdateCouponInput) {
    const coupon = await this.loadOwned(user, id);
    /*
      A FIXED coupon leaves every update with a currency. One named here is checked as it is on
      create; a row from before coupons carried one is given the organization's own, so editing
      an old code is also how it stops relying on the INR fallback. A PERCENT coupon never has
      one, and a currency sent for it is ignored rather than stored as a meaningless label.
    */
    const currency =
      coupon.type === 'FIXED' && (input.currency || !coupon.currency)
        ? await this.currencyFor(coupon.organizationId!, 'FIXED', input.currency)
        : undefined;
    const updated = await this.prisma.coupon.update({
      where: { id: coupon.id },
      data: {
        value: input.value ?? undefined,
        currency: currency ?? undefined,
        maxRedemptions: input.maxRedemptions === undefined ? undefined : input.maxRedemptions,
        startsAt: input.startsAt === undefined ? undefined : input.startsAt,
        endsAt: input.endsAt === undefined ? undefined : input.endsAt,
        status: input.status ?? undefined,
        isPublic: input.isPublic ?? undefined,
        publicLabel: input.publicLabel === undefined ? undefined : input.publicLabel,
      },
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: coupon.organizationId,
      action: 'COUPON_UPDATED',
      entityType: 'Coupon',
      entityId: coupon.id,
      metadata: {
        ...input,
        currency: currency ?? undefined,
        startsAt: input.startsAt ?? undefined,
        endsAt: input.endsAt ?? undefined,
      },
    });
    return updated;
  }

  async remove(user: RequestUser, id: string) {
    const coupon = await this.loadOwned(user, id);
    // Never delete a coupon that has been used — it is referenced by bookings and is
    // part of the financial record. Deactivate instead.
    if (coupon.redemptions > 0) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'This coupon has been redeemed and cannot be deleted. Deactivate it instead.',
        HttpStatus.CONFLICT,
      );
    }
    await this.prisma.coupon.delete({ where: { id: coupon.id } });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: coupon.organizationId,
      action: 'COUPON_DELETED',
      entityType: 'Coupon',
      entityId: coupon.id,
      metadata: { code: coupon.code },
    });
    return { ok: true };
  }

  private async loadOwned(user: RequestUser, id: string) {
    const coupon = await this.prisma.coupon.findUnique({ where: { id } });
    if (!coupon || !coupon.organizationId) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Coupon not found.', HttpStatus.NOT_FOUND);
    }
    await this.access.assertMember(user, coupon.organizationId, ORGANIZER_ROLES);
    return coupon;
  }

  /**
   * The currency to store on a coupon.
   *
   * ── WHY A FIXED COUPON MUST HAVE ONE ──────────────────────────────────────────────
   * A FIXED `value` is minor units, and checkout used to take it off a booking in any currency:
   * a ₹500-off code took $500 off a US booking. It now applies only in its own currency, so it
   * has to have one. Omitted, it is the currency most of the organization's venues sell in, or
   * INR — the platform's historic default — before there is a venue.
   *
   * A currency none of the organization's venues sells in is refused: no booking could ever be
   * in it, so the code would be accepted here and then refused at every checkout. Before the
   * organization has a venue there is nothing to check against, and the choice is left to them.
   *
   * A PERCENT coupon carries none — a percentage means the same thing in every currency.
   */
  private async currencyFor(
    organizationId: string,
    type: CreateCouponInput['type'],
    requested: string | undefined,
  ): Promise<string | null> {
    if (type !== 'FIXED') return null;
    const selling = await this.sellingCurrencies(organizationId);
    if (!requested) return selling[0] ?? 'INR';
    if (selling.length > 0 && !selling.includes(requested)) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        `None of your venues sells in ${requested}, so a discount in ${requested} could never apply. Use ${selling.join(' or ')}.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return requested;
  }

  /**
   * The currencies an organization sells in, most of its venues first.
   *
   * A venue's country decides what its tickets are priced in — the same `currencyForCountry`
   * the booking path uses — so these are the only currencies a booking with this organization
   * can be in. Ties go alphabetically, as the coupon-currency backfill migration breaks them, so
   * a coupon created without a currency gets the same default existing coupons were given.
   */
  private async sellingCurrencies(organizationId: string): Promise<string[]> {
    const venues = await this.prisma.venue.findMany({
      where: { organizationId },
      select: { country: true },
    });
    const counts = new Map<string, number>();
    for (const venue of venues) {
      const currency = currencyForCountry(venue.country);
      if (currency) counts.set(currency, (counts.get(currency) ?? 0) + 1);
    }
    return [...counts]
      .sort(([a, n], [b, m]) => m - n || a.localeCompare(b))
      .map(([currency]) => currency);
  }
}
