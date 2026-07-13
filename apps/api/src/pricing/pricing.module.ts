import { Module } from '@nestjs/common';
import { PricingService } from './pricing.service';
import {
  FlatPricingStrategy,
  SeatPricingStrategy,
  TierPricingStrategy,
} from './pricing-strategies';
import { PricingStrategiesService } from './pricing-strategies.service';

@Module({
  providers: [
    PricingService, // fee calculation (unchanged)
    FlatPricingStrategy,
    TierPricingStrategy,
    SeatPricingStrategy,
    PricingStrategiesService, // line pricing (ADR-019)
  ],
  exports: [PricingService, PricingStrategiesService],
})
export class PricingModule {}
