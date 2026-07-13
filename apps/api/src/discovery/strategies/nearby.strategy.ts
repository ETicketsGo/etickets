import { Injectable } from '@nestjs/common';
import { PublicEventsService } from '../../events/public-events.service';
import {
  DiscoveryContext,
  DiscoverySection,
  DiscoveryStrategy,
} from './discovery-strategy.interface';

const LIMIT = 8;

/**
 * Events near the visitor. "Nearby" is CITY-BASED today: we filter by
 * ctx.city (matched against the venue city) because the platform stores no
 * per-visitor geolocation. FUTURE: when venue lat/long + a visitor coordinate
 * are available, this strategy can switch to a radius/distance ranking without
 * changing the discovery seam or the client.
 *
 * With no city in context the section is empty and the composer drops it.
 */
@Injectable()
export class NearbyStrategy implements DiscoveryStrategy {
  readonly key = 'nearby';

  constructor(private readonly publicEvents: PublicEventsService) {}

  async discover(ctx: DiscoveryContext): Promise<DiscoverySection> {
    const empty: DiscoverySection = { key: this.key, title: 'Near you', kind: 'events', items: [] };
    if (!ctx.city) return empty;
    const { data } = await this.publicEvents.list({
      page: 1,
      pageSize: LIMIT,
      city: ctx.city,
    });
    return { key: this.key, title: `Near you in ${ctx.city}`, kind: 'events', items: data };
  }
}
