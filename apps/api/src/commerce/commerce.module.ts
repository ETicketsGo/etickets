import { Module } from '@nestjs/common';
import { CommerceController, PublicCommerceController } from './commerce.controller';
import { AddOnsService } from './addons.service';
import { BundlesService } from './bundles.service';
import { AddOnInventoryService } from './addon-inventory.service';

/**
 * Experience Commerce (v1.3): organizer add-on / bundle catalog + the public
 * availability reads, plus the shared add-on stock service consumed by the
 * booking/payment flow. Exports the services the bookings module composes with.
 */
@Module({
  controllers: [CommerceController, PublicCommerceController],
  providers: [AddOnsService, BundlesService, AddOnInventoryService],
  exports: [AddOnsService, BundlesService, AddOnInventoryService],
})
export class CommerceModule {}
