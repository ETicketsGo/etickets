import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RecommendationService } from './recommendation.service';
import type { RecommendationContext } from './strategies/recommendation-strategy.interface';

const querySchema = z.object({
  eventId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(12),
  strategy: z.string().optional(),
});

@ApiTags('public')
@Controller('public/recommendations')
export class RecommendationsController {
  constructor(
    private readonly recommendations: RecommendationService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Get()
  @ApiOperation({
    summary: 'Recommended "you might also like" events (blended, or a single ?strategy=).',
  })
  async get(
    @Query(new ZodValidationPipe(querySchema))
    q: {
      eventId?: string;
      limit: number;
      strategy?: string;
    },
  ) {
    // The seed's market, so the blend never crosses currencies without saying so.
    const seed = q.eventId
      ? await this.prisma.event.findUnique({
          where: { id: q.eventId },
          select: { venue: { select: { country: true } } },
        })
      : null;
    const ctx: RecommendationContext = {
      seedCountry: seed?.venue.country ?? null,
      userId: null,
      seedEventId: q.eventId,
      excludeEventIds: q.eventId ? [q.eventId] : [],
      limit: q.limit,
      now: new Date(),
    };
    const items = q.strategy
      ? await this.recommendations.recommendWith(q.strategy, ctx)
      : await this.recommendations.recommend(ctx);
    return { items };
  }
}
