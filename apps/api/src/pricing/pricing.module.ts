import { Module } from '@nestjs/common';
import { TaxModule } from '../tax/tax.module';
import { PricingService } from './pricing.service';
import { AdvertisedPriceService } from './advertised-price.service';
import {
  FlatPricingStrategy,
  SeatPricingStrategy,
  TierPricingStrategy,
} from './pricing-strategies';
import { PricingStrategiesService } from './pricing-strategies.service';

@Module({
  imports: [TaxModule],
  providers: [
    PricingService, // fee calculation (unchanged)
    AdvertisedPriceService, // what a LISTING advertises, per PRICE_DISPLAY_MODE
    FlatPricingStrategy,
    TierPricingStrategy,
    SeatPricingStrategy,
    PricingStrategiesService, // line pricing (ADR-019)
  ],
  exports: [PricingService, PricingStrategiesService, AdvertisedPriceService],
})
export class PricingModule {}
