import { Module } from '@nestjs/common';
import { PricingModule } from '../pricing/pricing.module';
import {
  AdminEventsController,
  EventsController,
  PublicCategoriesController,
  PublicEventsController,
  PublicOrganizersController,
} from './events.controller';
import { EventsService } from './events.service';
import { PublicEventsService } from './public-events.service';

@Module({
  imports: [PricingModule],
  controllers: [
    EventsController,
    PublicEventsController,
    PublicCategoriesController,
    PublicOrganizersController,
    AdminEventsController,
  ],
  providers: [EventsService, PublicEventsService],
  exports: [EventsService, PublicEventsService],
})
export class EventsModule {}
