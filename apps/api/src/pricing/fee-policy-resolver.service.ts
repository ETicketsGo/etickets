import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { selectFeePolicy, type FeePolicyContext, type FeePolicyRow } from './fee-policy';

/**
 * Which platform fee policy prices a sale - the database half of `fee-policy.ts`.
 *
 * Live pricing (`PricingService.quote`) and the advertised "from" price both ask this, so a
 * card and the checkout cannot resolve different policies for the same ticket.
 */
@Injectable()
export class FeePolicyResolver {
  constructor(private readonly prisma: PrismaService) {}

  /** Every policy that could be live for this event or organization at `ctx.at`. */
  async candidates(ctx: FeePolicyContext): Promise<FeePolicyRow[]> {
    const targets = [
      ...(ctx.eventId ? [{ scope: 'EVENT' as const, eventId: ctx.eventId }] : []),
      ...(ctx.organizationId
        ? [{ scope: 'ORGANIZATION' as const, organizationId: ctx.organizationId }]
        : []),
    ];
    if (targets.length === 0) return [];
    return this.prisma.platformFeePolicy.findMany({
      where: {
        status: 'ACTIVE',
        startsAt: { lte: ctx.at },
        AND: [{ OR: [{ endsAt: null }, { endsAt: { gt: ctx.at } }] }, { OR: targets }],
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** The policy that prices a sale in `currency`, or null for the platform schedule. */
  async resolve(currency: string, ctx: FeePolicyContext): Promise<FeePolicyRow | null> {
    return selectFeePolicy(await this.candidates(ctx), currency, ctx);
  }

  /**
   * A policy by id, whatever its status now - for re-pricing a booking under the terms it was
   * snapshotted with. Terms never change after creation, so this is what the booking meant.
   */
  async byId(id: string): Promise<FeePolicyRow | null> {
    return this.prisma.platformFeePolicy.findUnique({ where: { id } });
  }
}
