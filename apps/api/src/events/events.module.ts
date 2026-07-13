import { Module } from '@nestjs/common';
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
