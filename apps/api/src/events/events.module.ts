import { Module } from '@nestjs/common';
import {
  AdminEventsController,
  EventsController,
  PublicCategoriesController,
  PublicEventsController,
  PublicOrganizersController,
} from './events.controller';
import { EventsService } from './events.service';
import { PublicMoviesController } from './public-movies.controller';
import { PublicMoviesService } from './public-movies.service';
import { PublicEventsService } from './public-events.service';

@Module({
  controllers: [
    EventsController,
    PublicEventsController,
    PublicCategoriesController,
    PublicOrganizersController,
    AdminEventsController,
    PublicMoviesController,
  ],
  providers: [EventsService, PublicEventsService, PublicMoviesService],
  exports: [EventsService, PublicEventsService, PublicMoviesService],
})
export class EventsModule {}
