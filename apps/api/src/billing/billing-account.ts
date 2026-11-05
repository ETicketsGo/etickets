import { HttpStatus } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { countryAliases, currencyForCountry } from '@eticketsgo/shared-types';
import { AppException, ErrorCodes } from '../common/errors';

/** Countries that have organizer plan prices. Billing follows the ORGANIZER's country. */
export const BILLING_COUNTRIES = ['IN', 'US'] as const;

/**
 * The ISO alpha-2 code for an organization's registered country, as typed ("India", "usa", "IN").
 * Unknown or empty: null. Never the visitor's country and never a guess.
 */
export function billingCountryOf(registeredCountry: string | null | undefined): string | null {
  const raw = (registeredCountry ?? '').trim();
  if (!raw) return null;
  const aliases = countryAliases(raw);
  for (const alpha2 of ['IN', 'US', 'CA', 'GB', 'AE', 'SG', 'AU', 'NZ']) {
    if (aliases.includes(alpha2.toLowerCase())) return alpha2;
  }
  return /^[A-Za-z]{2}$/.test(raw) ? raw.toUpperCase() : null;
}

type Tx = Prisma.TransactionClient;

/**
 * The organization's billing account, created on first need. Country and currency are taken
 * from the organization's registered country; "XX" when it has none yet. A staff grant needs
 * no price, so an unknown country never blocks one.
 */
export async function ensureBillingAccount(tx: Tx, organizationId: string) {
  const existing = await tx.organizerBillingAccount.findUnique({ where: { organizationId } });
  if (existing) return existing;
  const org = await tx.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, registeredCountry: true, financeContactEmail: true, contactEmail: true },
  });
  if (!org) {
    throw new AppException(ErrorCodes.NOT_FOUND, 'Organization not found.', HttpStatus.NOT_FOUND);
  }
  const country = billingCountryOf(org.registeredCountry) ?? 'XX';
  const currency = currencyForCountry(country) ?? 'USD';
  // Upsert: two first requests at once both end with the one account.
  return tx.organizerBillingAccount.upsert({
    where: { organizationId },
    create: {
      organizationId,
      country,
      currency,
      billingEmail: org.financeContactEmail ?? org.contactEmail ?? null,
    },
    update: {},
  });
}
