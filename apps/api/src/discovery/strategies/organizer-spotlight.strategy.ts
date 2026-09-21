import { Injectable } from '@nestjs/common';
import { EventStatus, OrganizationStatus } from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DiscoveryContext,
  DiscoverySection,
  DiscoveryStrategy,
} from './discovery-strategy.interface';
import { venueInScope } from './scope';

const LIMIT = 8;

/** A spotlit organizer card. `verified` mirrors PublicEventsService.organizer. */
export interface OrganizerSpotlightItem {
  id: string;
  name: string;
  verified: boolean;
  eventCount: number;
}

/**
 * A few verified (APPROVED) organizations with published events IN THE VISITOR'S PLACE.
 *
 * It used to be platform-wide by design, so a visitor in the United States was shown a
 * Bengaluru promoter as a "spotlight" — an organizer they cannot buy a single ticket from.
 * Now an organizer appears only for its events where the visitor is, and its count is of
 * those events, not of everything it runs everywhere.
 */
@Injectable()
export class OrganizerSpotlightStrategy implements DiscoveryStrategy {
  readonly key = 'organizer-spotlight';

  constructor(private readonly prisma: PrismaService) {}

  async discover(ctx: DiscoveryContext): Promise<DiscoverySection> {
    const here = { status: EventStatus.PUBLISHED, venue: venueInScope(ctx) };
    const orgs = await this.prisma.organization.findMany({
      where: {
        status: OrganizationStatus.APPROVED,
        events: { some: here },
      },
      select: {
        id: true,
        name: true,
        _count: { select: { events: { where: here } } },
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
