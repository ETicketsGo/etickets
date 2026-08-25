import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Role } from '@eticketsgo/shared-types';
import type { CreateCouponInput, UpdateCouponInput } from '@eticketsgo/validation';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
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
    try {
      const coupon = await this.prisma.coupon.create({
        data: {
          organizationId: input.organizationId,
          code: input.code,
          type: input.type,
          value: input.value,
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
    const updated = await this.prisma.coupon.update({
      where: { id: coupon.id },
      data: {
        value: input.value ?? undefined,
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
}
