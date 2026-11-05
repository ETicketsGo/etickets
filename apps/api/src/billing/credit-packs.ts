/**
 * Email credit packs an organizer can buy once, on top of the plan's monthly quota.
 *
 * ── SIZES ARE CODE, PRICES ARE CONFIGURATION (owner decision 2026-10-27) ─────────────
 * Three sizes: 1,000, 5,000 and 10,000 credits. What each costs is set by staff per country
 * (CreditPackPrice, BILLING_MANAGE with a recent second factor, audited) and is UNPUBLISHED
 * until somebody publishes it. No price, or an unpublished one, means the pack is not on sale
 * in that country: the organizer page does not list it and a checkout for it is refused.
 *
 * A pack grants credits ONLY after the provider's verified record of the payment (never from the
 * redirect, never from the webhook's claim), and only once per payment: the ledger row's
 * idempotency key is the provider payment reference.
 */
export interface CreditPack {
  code: string;
  credits: number;
  name: string;
}

export const EMAIL_CREDIT_PACKS: readonly CreditPack[] = [
  { code: 'EMAIL_1K', credits: 1_000, name: '1,000 campaign email credits' },
  { code: 'EMAIL_5K', credits: 5_000, name: '5,000 campaign email credits' },
  { code: 'EMAIL_10K', credits: 10_000, name: '10,000 campaign email credits' },
];

export const CREDIT_PACK_CODES = EMAIL_CREDIT_PACKS.map((p) => p.code);

export function creditPackByCode(code: string | null | undefined): CreditPack | null {
  return EMAIL_CREDIT_PACKS.find((p) => p.code === code) ?? null;
}

/** A pack as the organizer sees it: only a PUBLISHED price, in the country's currency. */
export interface CreditPackOffer {
  code: string;
  name: string;
  credits: number;
  currency: string;
  /** Before tax. */
  amountMinor: number;
}

/** The packs on sale, from the country's published prices. Unknown codes are dropped. */
export function creditPackOffers(
  prices: readonly {
    packCode: string;
    currency: string;
    amountMinor: number;
    published: boolean;
  }[],
): CreditPackOffer[] {
  return EMAIL_CREDIT_PACKS.flatMap((pack) => {
    const price = prices.find((p) => p.packCode === pack.code && p.published);
    return price
      ? [
          {
            code: pack.code,
            name: pack.name,
            credits: pack.credits,
            currency: price.currency,
            amountMinor: price.amountMinor,
          },
        ]
      : [];
  });
}
