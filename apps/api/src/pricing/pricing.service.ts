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
import type { PolicyEffect } from './cinema-policy/apply-policy';

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
  /**
   * The fee bands that apply where this sale is happening.
   *
   * ── WHY LOCATION AND NOT ONLY CURRENCY ─────────────────────────────────────────
   * Fees were selected by currency alone, which is not the unit anybody regulates. Several
   * Indian states cap what may be charged for booking a cinema ticket online, and the cap
   * differs by state — so one INR band cannot be correct for the whole country.
   *
   * ── MOST SPECIFIC WINS, AND ONLY ONE SET APPLIES ───────────────────────────────
   * A rule naming a region beats one naming only a country, which beats the wildcard. The
   * winning specificity takes the WHOLE band set: mixing a Telangana ₹5 band with a national
   * ₹20 band would produce a fee schedule nobody wrote, where the charge depends on which
   * band an order happens to fall in rather than on a decision somebody made.
   */
  private async loadTiers(
    currency: string,
    place: { country?: string | null; region?: string | null } = {},
  ): Promise<FeeTier[]> {
    const rules = await this.prisma.feeRule.findMany({
      where: { active: true, currency },
      orderBy: { minMinor: 'asc' },
    });
    if (rules.length === 0) return DEFAULT_FEE_TIERS;

    const matches = (ruleValue: string, actual: string | null | undefined): boolean => {
      const v = (ruleValue ?? '*').trim();
      if (v === '*' || v === '') return true;
      if (actual == null) return false;
      return v.toUpperCase() === actual.trim().toUpperCase();
    };

    const applicable = rules.filter(
      (r) => matches(r.country, place.country) && matches(r.region, place.region),
    );
    if (applicable.length === 0) return DEFAULT_FEE_TIERS;

    /*
      Specificity is counted, not guessed: a named region scores 2, a named country 1. Taking
      the highest score present and keeping only those rules means a state's schedule replaces
      the national one wholesale rather than being blended into it.
    */
    const score = (r: { country: string; region: string }) =>
      (r.region !== '*' ? 2 : 0) + (r.country !== '*' ? 1 : 0);
    const best = Math.max(...applicable.map(score));

    return applicable
      .filter((r) => score(r) === best)
      .map((r) => ({ minMinor: r.minMinor, maxMinor: r.maxMinor, feeMinor: r.feeMinor }));
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
    /**
     * What a jurisdiction's cinema pricing order does to this money, already resolved.
     *
     * Resolved by the caller rather than here, because resolution needs the CINEMA — its
     * classification and local body — and this service prices carts, not venues. Absent, and
     * for every non-cinema order, nothing below changes at all.
     */
    policy?: PolicyEffect,
  ): Promise<FeeCalcResult> {
    // The venue's location decides the fee schedule, for the same reason it decides the
    // admission's place of supply: a cap applies to the sale that happens there.
    const tiers = await this.loadTiers(currency, {
      country: taxPlace.country,
      region: taxPlace.region,
    });
    // Fees first, with no tax, because tax is levied on what the customer is actually
    // charged — the discounted ticket price plus their share of the fees.
    const uncapped = calculateFees({ subtotalMinor, feeMode, discountMinor, tiers, currency });

    /*
      ── A JURISDICTION MAY LIMIT OR FORBID THE PLATFORM'S FEE ────────────────────────
      Applied here, BEFORE tax, because tax is levied on what the customer is actually
      charged. Capping afterwards would tax a fee nobody paid.

      `maxOnlineFeeMinor === null` means unrestricted and the tiers stand exactly as before.
      Zero is a real answer — the fee is not permitted, or the jurisdiction's position has
      not been confirmed and the platform declines to assume its own schedule is lawful
      there. Whatever the customer is not charged, the organizer does not absorb either:
      this reduces the charge, it does not move it.
    */
    const cap = policy?.maxOnlineFeeMinor ?? null;
    const fees =
      cap === null || uncapped.customerFeeMinor <= cap
        ? uncapped
        : {
            ...uncapped,
            customerFeeMinor: cap,
            // Kept proportional so the itemisation still explains the total it belongs to.
            bookingFeeMinor: Math.min(uncapped.bookingFeeMinor, cap),
            paymentFeeMinor: Math.max(0, cap - Math.min(uncapped.bookingFeeMinor, cap)),
          };

    const maintenanceMinor = policy?.maintenanceMinor ?? 0;
    const maintenanceAddedMinor = policy?.maintenanceAddedMinor ?? 0;

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
      /*
        Rated whether the charge is inside the ticket price or added to it. A TaxRule
        naming MAINTENANCE decides if it is taxed at all — the platform asserts nothing
        about that, and passing it only makes the question answerable by configuration.
      */
      maintenanceMinor,
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
    /*
      ── ONE ROW FOR THE PLATFORM FEE ───────────────────────────────────────────────
      A customer wants to know what the platform costs them, once. Splitting that into a fee
      and a tax on the fee, two rows apart, asks them to do arithmetic to answer it — and on a
      ₹40 fee the two numbers are ₹40.00 and ₹7.20, neither of which is the answer.

      So the fee is also reported ALL-IN, with the rate that is inside it, and the storefront
      renders "Platform fee (incl. GST 18%)  ₹47.20".

      Reported ALONGSIDE the itemisation rather than instead of it. A tax invoice must still
      show the taxable value and the rate, and `taxLines` is untouched — this is a second view
      of the same money, not a replacement for it.

      Only tax charged ON THE FEE counts here. Admission tax belongs to the ticket, and
      folding it in would make the fee look like most of the order.
    */
    const feeTaxLines = taxLines.filter((l) => l.basis === 'FEES');
    const feeTaxMinor = feeTaxLines.reduce((sum, l) => sum + l.amountMinor, 0);
    // CGST 9% + SGST 9% is one 18% levy to a reader, so the components are summed.
    const feeTaxRateBasisPoints = feeTaxLines.reduce((sum, l) => sum + l.rateBasisPoints, 0);
    // Added tax makes the fee cost more; inclusive tax was already inside it.
    const addedFeeTaxMinor = feeTaxLines
      .filter((l) => !l.inclusive)
      .reduce((sum, l) => sum + l.amountMinor, 0);

    return {
      ...fees,
      taxLines,
      taxMinor,
      /**
       * What the platform fee costs the customer in total, tax included.
       *
       * Equal to `customerFeeMinor` when the fee's tax is inclusive (it was already inside)
       * and to fee + tax when it is added. Either way it is the single number to show.
       */
      customerFeeInclusiveMinor: fees.customerFeeMinor + addedFeeTaxMinor,
      /** The combined rate inside that figure — 1800 for an 18% GST, 0 when untaxed. */
      feeTaxRateBasisPoints,
      feeTaxMinor,
      maintenanceMinor,
      maintenanceTreatment: policy?.maintenanceTreatment ?? 'NOT_APPLICABLE',
      /*
        `maintenanceAddedMinor`, not `maintenanceMinor`.

        An INCLUDED charge is already inside the ticket price the customer is paying, exactly
        as an inclusive tax is. Adding it here would charge it a second time on every order in
        every included-charge market — the same mistake, in a different column, that inclusive
        tax has already produced twice on this platform.
      */
      totalMinor:
        fees.netSubtotalMinor + fees.customerFeeMinor + maintenanceAddedMinor + taxAddedMinor,
    };
  }
}
