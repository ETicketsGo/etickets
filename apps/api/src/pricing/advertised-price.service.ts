import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FeeMode } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import {
  applicableTiers,
  DEFAULT_FEE_TIERS,
  feeTierFromRule,
  type FeePlace,
  type FeeTier,
} from './fee-calculator';
import {
  advertisedPriceMinor,
  parsePriceDisplayMode,
  type PriceDisplayMode,
} from './price-display';

/**
 * The price a listing advertises, under whichever display mode is configured.
 *
 * ── WHY ONE SERVICE RATHER THAN THE HELPER AT EACH CALL SITE ───────────────────────
 * A buyer sees "from ₹799" on a search result, a recommendation carousel, a movie page and
 * an event card. If some of those apply the all-in rule and others do not, the platform is
 * advertising two different prices for the same ticket — which is worse than advertising
 * the bare price consistently, and is precisely the exposure the all-in rules exist to
 * address. Funnelling every surface through one object makes that mistake visible: a new
 * listing endpoint either injects this or it does not.
 *
 * Fee tiers are cached for the process lifetime per currency. They are configuration that
 * changes on the order of never, and a listing page renders dozens of cards — a query per
 * card to compute an advertised price would be a self-inflicted N+1 on the hottest path in
 * the product.
 */
@Injectable()
export class AdvertisedPriceService {
  private readonly mode: PriceDisplayMode;
  private readonly tierCache = new Map<string, FeeTier[]>();

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    // Parsed once, at construction. An unrecognised value is refused rather than defaulted,
    // because defaulting would advertise the wrong price in whichever market it was set for.
    this.mode = parsePriceDisplayMode(config.get<string>('PRICE_DISPLAY_MODE'));
  }

  /** True when the configured mode leaves prices exactly as they are stored. */
  get isPassThrough(): boolean {
    return this.mode === 'itemised';
  }

  /**
   * The bands this listing's price is built from - the ones that apply AT THE VENUE.
   *
   * The place used to be left out here, so a card added up every band configured for the
   * currency while checkout used only the ones scoped to the venue. With one India-scoped
   * band beside the national schedule the card advertised one fee and the checkout charged
   * another, which is the exact thing this service exists to prevent.
   *
   * The cache is keyed by place as well, because two venues in the same currency can now
   * legitimately resolve different bands.
   */
  private async tiersFor(currency: string, place: FeePlace = {}): Promise<FeeTier[]> {
    const key = `${currency}|${place.country ?? '*'}|${place.region ?? '*'}`;
    const cached = this.tierCache.get(key);
    if (cached) return cached;
    const rules = await this.prisma.feeRule.findMany({
      where: { active: true, currency },
      orderBy: { minMinor: 'asc' },
    });
    const applicable = applicableTiers(rules, place);
    const tiers = applicable.length ? applicable.map(feeTierFromRule) : DEFAULT_FEE_TIERS;
    this.tierCache.set(key, tiers);
    return tiers;
  }

  /**
   * The advertised price for one ticket. Returns the input unchanged in `itemised` mode,
   * without touching the database — so the default costs nothing.
   */
  async forTicket(
    basePriceMinor: number | null,
    feeMode: FeeMode,
    currency = 'INR',
    /** The venue's country and region, so the card quotes the fee the checkout will charge. */
    place: FeePlace = {},
  ): Promise<number | null> {
    if (basePriceMinor === null || this.isPassThrough) return basePriceMinor;
    return advertisedPriceMinor({
      basePriceMinor,
      mode: this.mode,
      feeMode,
      tiers: await this.tiersFor(currency, place),
      currency,
    });
  }
}
