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
import { EventImageService } from './event-image.service';
import { OrganizerCalendarController } from './organizer-calendar.controller';
import { OrganizerCalendarService } from './organizer-calendar.service';
import { OrganizerSaleEligibilityService } from './organizer-sale-eligibility.service';

@Module({
  imports: [PricingModule, ShowsModule],
  controllers: [
    EventsController,
    PublicEventsController,
    PublicCategoriesController,
    PublicOrganizersController,
    AdminEventsController,
    OrganizerCalendarController,
  ],
  providers: [
    EventsService,
    PublicEventsService,
    EventImageService,
    EventSellabilityService,
    EventSellabilitySweepService,
    OrganizerCalendarService,
    OrganizerSaleEligibilityService,
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
