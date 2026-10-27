/**
 * Email credit packs an organizer can buy once, on top of the plan's monthly quota.
 *
 * PROVISIONAL, like the plan prices: the owner has not confirmed pack sizes or prices. They live
 * in code (not a table) because there are two and they change only with a release; the price is
 * per country, in that country's currency, and the organizer's billing country picks it.
 *
 * A pack grants credits ONLY after the provider's verified record of the payment (never from the
 * redirect, never from the webhook's claim), and only once per payment: the ledger row's
 * idempotency key is the provider payment reference.
 */
export interface CreditPack {
  code: string;
  credits: number;
  name: string;
  prices: Record<string, { currency: string; amountMinor: number }>;
}

export const EMAIL_CREDIT_PACKS: readonly CreditPack[] = [
  {
    code: 'EMAIL_5K',
    credits: 5_000,
    name: '5,000 campaign email credits',
    prices: {
      IN: { currency: 'INR', amountMinor: 49_900 },
      US: { currency: 'USD', amountMinor: 900 },
    },
  },
  {
    code: 'EMAIL_25K',
    credits: 25_000,
    name: '25,000 campaign email credits',
    prices: {
      IN: { currency: 'INR', amountMinor: 1_99_900 },
      US: { currency: 'USD', amountMinor: 3_900 },
    },
  },
];

export function creditPackByCode(code: string | null | undefined): CreditPack | null {
  return EMAIL_CREDIT_PACKS.find((p) => p.code === code) ?? null;
}

/** The packs on sale in a country, with that country's price. */
export function creditPacksFor(country: string | null | undefined) {
  if (!country) return [];
  return EMAIL_CREDIT_PACKS.filter((p) => p.prices[country]).map((p) => ({
    code: p.code,
    name: p.name,
    credits: p.credits,
    currency: p.prices[country].currency,
    amountMinor: p.prices[country].amountMinor,
  }));
}
