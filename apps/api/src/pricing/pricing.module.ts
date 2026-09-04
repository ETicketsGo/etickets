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
import { CinemaPricingPolicyService } from './cinema-policy/cinema-pricing-policy.service';

@Module({
  imports: [TaxModule],
  providers: [
    PricingService, // fee calculation (unchanged)
    AdvertisedPriceService, // what a LISTING advertises, per PRICE_DISPLAY_MODE
    FlatPricingStrategy,
    TierPricingStrategy,
    SeatPricingStrategy,
    PricingStrategiesService, // line pricing (ADR-019)
    CinemaPricingPolicyService, // regulated cinema rates (ADR-043)
  ],
  exports: [
    PricingService,
    PricingStrategiesService,
    AdvertisedPriceService,
    CinemaPricingPolicyService,
  ],
})
export class PricingModule {}
