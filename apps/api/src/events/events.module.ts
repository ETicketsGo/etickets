import { Module } from '@nestjs/common';
import { ShowsModule } from '../shows/shows.module';
import { PricingModule } from '../pricing/pricing.module';
import {
  AdminEventsController,
  EventsController,
  PublicCategoriesController,
  PublicEventsController,
  PublicOrganizersController,
} from './events.controller';
import { EventsService } from './events.service';
import { EventSellabilityService } from './event-sellability.service';
import { EventSellabilitySweepService } from './event-sellability-sweep.service';
import { PublicEventsService } from './public-events.service';

@Module({
  imports: [PricingModule, ShowsModule],
  controllers: [
    EventsController,
    PublicEventsController,
    PublicCategoriesController,
    PublicOrganizersController,
    AdminEventsController,
  ],
  providers: [
    EventsService,
    PublicEventsService,
    EventSellabilityService,
    EventSellabilitySweepService,
  ],
  exports: [
    EventsService,
    PublicEventsService,
    EventSellabilityService,
    // Exported so the worker can sweep for listings that became unsellable after publish.
    EventSellabilitySweepService,
  ],
})
export class EventsModule {}
