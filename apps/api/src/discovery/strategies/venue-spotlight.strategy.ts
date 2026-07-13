import { Injectable } from '@nestjs/common';
import { EventStatus } from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DiscoveryContext,
  DiscoverySection,
  DiscoveryStrategy,
} from './discovery-strategy.interface';

const LIMIT = 8;

/** A spotlit venue card. */
export interface VenueSpotlightItem {
  id: string;
  name: string;
  city: string;
  country: string;
  eventCount: number;
}

/** Venues that currently host published events (optionally scoped to a city). */
@Injectable()
export class VenueSpotlightStrategy implements DiscoveryStrategy {
  readonly key = 'venue-spotlight';

  constructor(private readonly prisma: PrismaService) {}

  async discover(ctx: DiscoveryContext): Promise<DiscoverySection> {
    const venues = await this.prisma.venue.findMany({
      where: {
        ...(ctx.city ? { city: { equals: ctx.city, mode: 'insensitive' } } : {}),
        events: { some: { status: EventStatus.PUBLISHED } },
      },
      select: {
        id: true,
        name: true,
        city: true,
        country: true,
        _count: { select: { events: { where: { status: EventStatus.PUBLISHED } } } },
      },
      orderBy: { events: { _count: 'desc' } },
      take: LIMIT,
    });
    const items: VenueSpotlightItem[] = venues.map((v) => ({
      id: v.id,
      name: v.name,
      city: v.city,
      country: v.country,
      eventCount: v._count.events,
    }));
    return { key: this.key, title: 'Popular venues', kind: 'venues', items };
  }
}
