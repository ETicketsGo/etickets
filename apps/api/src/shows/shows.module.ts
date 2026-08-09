import { Module } from '@nestjs/common';
import { ShowsController, PublicShowsController } from './shows.controller';
import { ShowsService } from './shows.service';
import { TheaterOperationsController } from './theater-operations.controller';
import { SeatLayoutsService } from './seat-layouts.service';
import { SeatOverridesService } from './seat-overrides.service';
import { LiveOperationsService } from './live-operations.service';

@Module({
  controllers: [ShowsController, PublicShowsController, TheaterOperationsController],
  providers: [ShowsService, SeatLayoutsService, SeatOverridesService, LiveOperationsService],
  exports: [ShowsService, SeatLayoutsService, SeatOverridesService, LiveOperationsService],
})
export class ShowsModule {}
