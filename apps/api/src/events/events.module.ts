import { Module } from '@nestjs/common';
import {
  AdminEventsController,
  EventsController,
  PublicEventsController,
  PublicOrganizersController,
} from './events.controller';
import { EventsService } from './events.service';
import { PublicEventsService } from './public-events.service';

@Module({
  controllers: [
    EventsController,
    PublicEventsController,
    PublicOrganizersController,
    AdminEventsController,
  ],
  providers: [EventsService, PublicEventsService],
  exports: [EventsService, PublicEventsService],
})
export class EventsModule {}
