import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FeeMode } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import {
  calculateFees,
  DEFAULT_FEE_TIERS,
  type FeeCalcResult,
  type FeeTier,
} from './fee-calculator';
import type { TaxPlace } from './tax-calculator';
import { TAX_PROVIDER, type TaxProvider } from '../tax/tax-provider.interface';

@Injectable()
export class PricingService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(TAX_PROVIDER) private readonly tax: TaxProvider,
    private readonly config: ConfigService,
  ) {}

  /**
   * Active fee tiers for one currency, cheapest band first.
   *
   * Filtering by currency is load-bearing, not tidiness. Fee amounts are integer MINOR
   * units, so a ₹5 booking fee and a $5 booking fee are stored as 500 each while meaning
   * entirely different sums, and the bands (₹0–₹199 vs $0–$1.99) do not correspond at all.
   * Before multi-currency rules existed this query returned every active rule regardless of
   * currency, which was harmless only because the table held nothing but INR. The moment
   * USD/CAD/AUD rows are seeded, an unfiltered query would interleave four currencies'
   * bands and charge whichever happened to match the subtotal first.
   *
   * Falls back to the built-in India defaults when a currency has no configured rules, which
   * preserves the previous behaviour for an empty table.
   */
  private async loadTiers(currency: string): Promise<FeeTier[]> {
    const rules = await this.prisma.feeRule.findMany({
      where: { active: true, currency },
      orderBy: { minMinor: 'asc' },
    });
    if (rules.length === 0) return DEFAULT_FEE_TIERS;
    return rules.map((r) => ({ minMinor: r.minMinor, maxMinor: r.maxMinor, feeMinor: r.feeMinor }));
  }

  /**
   * Compute fees (and any configured tax) for a quote using the currently active DB rules
   * for `currency`. Defaults to INR so existing callers that do not pass one behave exactly
   * as before — and with no tax rules configured, the result is identical to before tax
   * existed in this codebase.
   */
  async quote(
    subtotalMinor: number,
    feeMode: FeeMode,
    discountMinor = 0,
    currency = 'INR',
    taxPlace: TaxPlace = {},
    /**
     * The order broken into ticket kinds, when the caller knows it.
     *
     * Optional so every existing caller keeps working, but a rule with a PRICE BAND cannot
     * be applied without it and will refuse rather than rate a whole order in one band.
     * India bands cinema admission at ₹100 and sporting admission at ₹500, per ticket.
     */
    admissionLines?: { unitPriceMinor: number; quantity: number; category?: string | null }[],
  ): Promise<FeeCalcResult> {
    const tiers = await this.loadTiers(currency);
    // Fees first, with no tax, because tax is levied on what the customer is actually
    // charged — the discounted ticket price plus their share of the fees.
    const fees = calculateFees({ subtotalMinor, feeMode, discountMinor, tiers, currency });

    /*
      Tax comes from the configured provider rather than from a rule table read inline.

      With TAX_PROVIDER=manual — the default — the provider reads exactly the same TaxRule
      rows this method used to read, so the result is unchanged. The indirection buys the
      thing that matters later: swapping to a tax service for the US market becomes a
      configuration change and an adapter, with no edit to the money model, the booking, the
      receipt or the refund path.
    */
    const { taxLines, taxMinor, taxAddedMinor } = await this.tax.quote({
      // Spread first, then pin the currency: `taxPlace.currency` is nullable and a caller
      // leaving it unset must not blank out the currency the quote is actually priced in.
      /*
        The platform's own state is configuration, not something a caller knows — so it is
        stamped here rather than threaded through every call site. A caller that already set
        one wins, which keeps the seam testable.
      */
      context: {
        platformRegion: this.config.get<string>('PLATFORM_TAX_REGION') ?? null,
        ...taxPlace,
        currency,
      },
      netSubtotalMinor: fees.netSubtotalMinor,
      customerFeeMinor: fees.customerFeeMinor,
      admissionLines,
      lines: [{ reference: 'tickets', kind: 'admission', amountMinor: fees.netSubtotalMinor }],
    });

    /*
      `taxAddedMinor`, not `taxMinor`.

      An INCLUSIVE tax is already inside the ticket price — the ₹250 on the poster contains
      its GST — so adding it here would charge it a second time and raise every Indian price
      by the rate. An exclusive tax reports the same number in both fields, so this is
      identical to the previous line for every market that adds tax at the till.
    */
    return {
      ...fees,
      taxLines,
      taxMinor,
      totalMinor: fees.netSubtotalMinor + fees.customerFeeMinor + taxAddedMinor,
    };
  }
}
