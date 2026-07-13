import { Injectable } from '@nestjs/common';
import { PublicEventsService } from '../../events/public-events.service';
import {
  DiscoveryContext,
  DiscoverySection,
  DiscoveryStrategy,
} from './discovery-strategy.interface';

const LIMIT = 8;

/** Start of the coming Saturday → end of the coming Sunday (server-local). */
export function weekendWindow(now: Date): { dateFrom: Date; dateTo: Date } {
  const day = now.getDay(); // 0 = Sunday … 6 = Saturday
  // Days to this weekend's Saturday. On Sunday, Saturday was yesterday (-1).
  const daysToSat = day === 0 ? -1 : 6 - day;
  const sat = new Date(now);
  sat.setDate(now.getDate() + daysToSat);
  sat.setHours(0, 0, 0, 0);
  const dateTo = new Date(sat);
  dateTo.setDate(sat.getDate() + 1);
  dateTo.setHours(23, 59, 59, 999);
  // Never look into the past: if we are already mid-weekend, start from now.
  const dateFrom = now > sat ? now : sat;
  return { dateFrom, dateTo };
}

/** Events with at least one session during the coming Saturday/Sunday. */
@Injectable()
export class WeekendStrategy implements DiscoveryStrategy {
  readonly key = 'weekend';

  constructor(private readonly publicEvents: PublicEventsService) {}

  async discover(ctx: DiscoveryContext): Promise<DiscoverySection> {
    const { dateFrom, dateTo } = weekendWindow(ctx.now);
    const { data } = await this.publicEvents.list({
      page: 1,
      pageSize: LIMIT,
      city: ctx.city,
      dateFrom,
      dateTo,
    });
    return { key: this.key, title: 'This weekend', kind: 'events', items: data };
  }
}
