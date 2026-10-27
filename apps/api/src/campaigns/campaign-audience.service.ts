import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppException, ErrorCodes } from '../common/errors';
import {
  audienceCountsSql,
  materialiseBatchSql,
  segmentDefinitionSchema,
  type AudienceCounts,
  type AudienceDefinition,
  type SegmentDefinition,
} from './campaign-audience';

/** Rows per materialisation batch. Each batch is one INSERT ... SELECT. */
export const MATERIALISE_BATCH = 2000;

/**
 * Audience counts and recipient materialisation. Every method takes an organization id the
 * caller has ALREADY authorized; nothing here decides who may ask.
 */
@Injectable()
export class CampaignAudienceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The definition with a saved segment resolved, and event ids narrowed to THIS organizer's
   * events. A foreign id is dropped, not an error: it matches nobody either way, and an error
   * would confirm that the id exists somewhere.
   */
  async resolve(organizationId: string, def: AudienceDefinition): Promise<SegmentDefinition> {
    let base: SegmentDefinition = {
      sources: def.sources,
      eventIds: def.eventIds,
      cities: def.cities,
    };
    if (def.savedSegmentId) {
      const segment = await this.prisma.savedSegment.findFirst({
        where: { id: def.savedSegmentId, organizationId },
        select: { definition: true },
      });
      if (!segment) {
        throw new AppException(
          ErrorCodes.NOT_FOUND,
          'That saved audience was not found.',
          HttpStatus.NOT_FOUND,
        );
      }
      base = segmentDefinitionSchema.parse(segment.definition);
    }
    if (base.eventIds?.length) {
      const own = await this.prisma.event.findMany({
        where: { id: { in: base.eventIds }, organizationId },
        select: { id: true },
      });
      base = { ...base, eventIds: own.map((e) => e.id) };
    }
    return base;
  }

  async counts(
    organizationId: string,
    purpose: string,
    def: SegmentDefinition,
  ): Promise<AudienceCounts> {
    const rows = await this.prisma.$queryRaw<AudienceCounts[]>(
      audienceCountsSql(organizationId, purpose, def),
    );
    const r = rows[0];
    return {
      matched: r?.matched ?? 0,
      eligible: r?.eligible ?? 0,
      noConsent: r?.noConsent ?? 0,
      suppressedGlobal: r?.suppressedGlobal ?? 0,
      suppressedOrganizer: r?.suppressedOrganizer ?? 0,
    };
  }

  /**
   * Materialise every recipient, batch by batch. Idempotent: a rerun after a crash inserts only
   * what is missing. Returns how many rows this run inserted.
   */
  async materialise(
    campaign: { id: string; organizationId: string; purpose: string },
    def: SegmentDefinition,
    batch = MATERIALISE_BATCH,
  ): Promise<number> {
    let after = '';
    let inserted = 0;
    for (let i = 0; i < 10_000; i++) {
      const rows = await this.prisma.$queryRaw<
        { lastHash: string | null; batchSize: number; inserted: number }[]
      >(
        materialiseBatchSql({
          campaignId: campaign.id,
          organizationId: campaign.organizationId,
          purpose: campaign.purpose,
          def,
          afterHash: after,
          limit: batch,
        }),
      );
      const r = rows[0];
      inserted += r?.inserted ?? 0;
      if (!r?.lastHash || r.batchSize < batch) break;
      after = r.lastHash;
    }
    return inserted;
  }

  // ── Saved segments ──────────────────────────────────────────────────────────────

  listSegments(organizationId: string) {
    return this.prisma.savedSegment.findMany({
      where: { organizationId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, definition: true, createdAt: true, updatedAt: true },
    });
  }

  async createSegment(
    organizationId: string,
    userId: string,
    name: string,
    definition: SegmentDefinition,
  ) {
    try {
      return await this.prisma.savedSegment.create({
        data: {
          organizationId,
          name,
          definition: definition as unknown as Prisma.InputJsonValue,
          createdByUserId: userId,
        },
        select: { id: true, name: true, definition: true, createdAt: true, updatedAt: true },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new AppException(
          ErrorCodes.CONFLICT,
          'You already have a saved audience with that name.',
          HttpStatus.CONFLICT,
        );
      }
      throw err;
    }
  }

  async deleteSegment(organizationId: string, id: string): Promise<{ deleted: boolean }> {
    const r = await this.prisma.savedSegment.deleteMany({ where: { id, organizationId } });
    return { deleted: r.count > 0 };
  }
}
