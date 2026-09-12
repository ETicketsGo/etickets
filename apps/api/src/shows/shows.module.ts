import { Module } from '@nestjs/common';
import { ShowsController, PublicShowsController } from './shows.controller';
import { ShowsService } from './shows.service';
import { TheaterOperationsController } from './theater-operations.controller';
import { SeatLayoutsService } from './seat-layouts.service';
import { SeatOverridesService } from './seat-overrides.service';
import { LiveOperationsService } from './live-operations.service';
import { InventoryModule } from '../inventory/inventory.module';
import { CommerceModule } from '../commerce/commerce.module';

@Module({
  // Cancelling a show releases the holds of the bookings still waiting to pay for it, with the
  // same strategies the booking sweep uses. Neither module imports this one, so no cycle.
  imports: [InventoryModule, CommerceModule],
  controllers: [ShowsController, PublicShowsController, TheaterOperationsController],
  providers: [ShowsService, SeatLayoutsService, SeatOverridesService, LiveOperationsService],
  exports: [ShowsService, SeatLayoutsService, SeatOverridesService, LiveOperationsService],
})
export class ShowsModule {}
