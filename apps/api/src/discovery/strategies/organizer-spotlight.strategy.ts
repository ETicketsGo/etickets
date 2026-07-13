import { Injectable } from '@nestjs/common';
import { EventStatus, OrganizationStatus } from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DiscoveryContext,
  DiscoverySection,
  DiscoveryStrategy,
} from './discovery-strategy.interface';

const LIMIT = 8;

/** A spotlit organizer card. `verified` mirrors PublicEventsService.organizer. */
export interface OrganizerSpotlightItem {
  id: string;
  name: string;
  verified: boolean;
  eventCount: number;
}

/** A few verified (APPROVED) organizations that have published events. */
@Injectable()
export class OrganizerSpotlightStrategy implements DiscoveryStrategy {
  readonly key = 'organizer-spotlight';

  constructor(private readonly prisma: PrismaService) {}

  async discover(_ctx: DiscoveryContext): Promise<DiscoverySection> {
    const orgs = await this.prisma.organization.findMany({
      where: {
        status: OrganizationStatus.APPROVED,
        events: { some: { status: EventStatus.PUBLISHED } },
      },
      select: {
        id: true,
        name: true,
        _count: { select: { events: { where: { status: EventStatus.PUBLISHED } } } },
      },
      orderBy: { events: { _count: 'desc' } },
      take: LIMIT,
    });
    const items: OrganizerSpotlightItem[] = orgs.map((o) => ({
      id: o.id,
      name: o.name,
      verified: true,
      eventCount: o._count.events,
    }));
    return { key: this.key, title: 'Organizer spotlight', kind: 'organizers', items };
  }
}
