import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AppException, ErrorCodes } from '../common/errors';
import { computeTax, selectTaxRules, type TaxRuleInput } from '../pricing/tax-calculator';
import { taxRuleFromRow } from '../tax/tax-rule-row';

/**
 * Tax on what the PLATFORM sells to an organizer: a plan subscription or an email credit pack.
 *
 * ── THE ENGINE IS THE TICKET ENGINE; THE RULES ARE NOT THE TICKET RULES ───────────────
 * Rates come only from `TaxRule` rows an owner writes, with `appliesTo = PLATFORM_SERVICES`.
 * No rate is written in code. They are rated by the same `computeTax` the ticket path uses -
 * same matching on country, region, currency and effective dates, same CGST + SGST or IGST
 * presentation, same single rounding per levy - with the rule treated as a fee: the platform's
 * own service, whose place of supply is the RECIPIENT (the organizer's billing state) compared
 * with where the platform is registered (PLATFORM_TAX_REGION). That is India's s.12(2) rule for
 * services, and it decides intra-state CGST + SGST against inter-state IGST.
 *
 * Ticket pricing is untouched: `computeTax` rates a PLATFORM_SERVICES rule on nothing in a
 * ticket order, and this service reads no other base.
 *
 * ── FAIL CLOSED ──────────────────────────────────────────────────────────────────────
 * No applicable rule for the organizer's jurisdiction means NO checkout, with a sentence that
 * says why - never a silent zero. An explicit 0% rule is an answer ("no tax is due here") and
 * prints a 0% line. A split (CGST + SGST) rule needs both states known, or it is refused rather
 * than guessed.
 *
 * ── USA AND STRIPE TAX ───────────────────────────────────────────────────────────────
 * STRIPE_BILLING_AUTOMATIC_TAX=true hands US tax to Stripe Tax: the checkout is created with
 * `automatic_tax` and tax-exclusive prices, and the invoice records the tax Stripe charged.
 * Off (the default), the US uses PLATFORM_SERVICES rules like India, per state.
 */
export type BillingTaxMode = 'MANUAL' | 'PROVIDER_AUTOMATIC';

export interface BillingTaxLine {
  label: string;
  rateBasisPoints: number;
  baseMinor: number;
  amountMinor: number;
}

export interface BillingTaxQuote {
  mode: BillingTaxMode;
  currency: string;
  /** What the service costs before tax. */
  netMinor: number;
  /** MANUAL: the tax. PROVIDER_AUTOMATIC: 0 here; the provider computes it at checkout. */
  taxMinor: number;
  /** What the organizer is charged (MANUAL). PROVIDER_AUTOMATIC: net, tax added by Stripe. */
  totalMinor: number;
  lines: BillingTaxLine[];
  jurisdiction: {
    country: string;
    /** The organizer's billing state: the place of supply. */
    region: string | null;
    /** Where the platform is registered (PLATFORM_TAX_REGION). */
    sellerRegion: string | null;
    interState: boolean | null;
  };
}

/** A refusal with a stable code, so the console can say "tax is not set up" plainly. */
function notConfigured(message: string, details: Record<string, unknown>): AppException {
  return new AppException(
    ErrorCodes.BILLING_TAX_NOT_CONFIGURED,
    message,
    HttpStatus.CONFLICT,
    details,
  );
}

@Injectable()
export class BillingTaxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Whether US tax is computed by Stripe Tax. */
  stripeAutomaticTax(): boolean {
    return this.config.get<string>('STRIPE_BILLING_AUTOMATIC_TAX') === 'true';
  }

  /**
   * The tax on `amountMinor` (BEFORE tax) of platform service sold to this organization now.
   * Throws BILLING_TAX_NOT_CONFIGURED when it cannot be answered.
   */
  async quote(input: {
    organizationId: string;
    country: string;
    currency: string;
    amountMinor: number;
    at?: Date;
  }): Promise<BillingTaxQuote> {
    const org = await this.prisma.organization.findUnique({
      where: { id: input.organizationId },
      select: { registeredRegion: true },
    });
    const region = org?.registeredRegion?.trim() || null;
    const sellerRegion = this.config.get<string>('PLATFORM_TAX_REGION')?.trim() || null;
    const amount = Math.max(0, Math.round(input.amountMinor));
    const base = {
      currency: input.currency,
      jurisdiction: { country: input.country, region, sellerRegion, interState: null },
    };

    if (input.country === 'US' && this.stripeAutomaticTax()) {
      return {
        ...base,
        mode: 'PROVIDER_AUTOMATIC',
        netMinor: amount,
        taxMinor: 0,
        totalMinor: amount,
        lines: [],
      };
    }

    const rows = await this.prisma.taxRule.findMany({
      where: {
        active: true,
        appliesTo: 'PLATFORM_SERVICES',
        currency: { in: [input.currency, '*'] },
      },
      orderBy: { priority: 'asc' },
    });
    // Rated as the platform's own service: a FEE base, place of supply = the recipient.
    const rules: TaxRuleInput[] = rows.map((r) => ({ ...taxRuleFromRow(r), appliesTo: 'FEES' }));
    const at = input.at ?? new Date();
    const place = {
      country: input.country,
      region,
      currency: input.currency,
      at,
      customerRegion: region,
      platformRegion: sellerRegion,
    };
    const applicable = selectTaxRules(rules, place);
    if (applicable.length === 0) {
      throw notConfigured(
        'Tax on ETicketsGo plans is not set up for your country or state yet, so payments are closed for now. Contact ETicketsGo support.',
        { country: input.country, region },
      );
    }
    if (applicable.some((r) => (r.split ?? 'NONE') === 'CGST_SGST')) {
      if (!region) {
        throw notConfigured(
          "Add your organization's state in your organization details. GST on your plan depends on it.",
          { country: input.country, missing: 'organization.registeredRegion' },
        );
      }
      if (!sellerRegion) {
        throw notConfigured(
          'Tax on ETicketsGo plans is not fully set up yet, so payments are closed for now. Contact ETicketsGo support.',
          { country: input.country, missing: 'PLATFORM_TAX_REGION' },
        );
      }
    }

    const result = computeTax({ netSubtotalMinor: 0, customerFeeMinor: amount, rules, place });
    let lines: BillingTaxLine[] = result.taxLines.map((l) => ({
      label: l.label,
      rateBasisPoints: l.rateBasisPoints,
      baseMinor: l.baseMinor,
      amountMinor: l.amountMinor,
    }));
    // An explicit 0% rule is an answer: print it, rather than an invoice with no tax line.
    if (lines.length === 0) {
      lines = applicable.map((r) => ({
        label: r.label,
        rateBasisPoints: Math.round(r.rateBasisPoints),
        baseMinor: amount,
        amountMinor: 0,
      }));
    }
    const total = amount + result.taxAddedMinor;
    const interState = lines.some((l) => l.label === 'IGST')
      ? true
      : lines.some((l) => l.label === 'CGST' || l.label === 'SGST')
        ? false
        : null;
    return {
      ...base,
      jurisdiction: { ...base.jurisdiction, interState },
      mode: 'MANUAL',
      // Inclusive rules keep the stated price as the total; exclusive ones add to it.
      netMinor: total - result.taxMinor,
      taxMinor: result.taxMinor,
      totalMinor: total,
      lines,
    };
  }
}
