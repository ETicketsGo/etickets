import { Module } from '@nestjs/common';
import {
  AdminEventsController,
  EventsController,
  PublicEventsController,
} from './events.controller';
import { EventsService } from './events.service';
import { PublicEventsService } from './public-events.service';

@Module({
  controllers: [EventsController, PublicEventsController, AdminEventsController],
  providers: [EventsService, PublicEventsService],
  exports: [EventsService],
})
export class EventsModule {}
