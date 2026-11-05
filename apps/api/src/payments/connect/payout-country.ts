import { HttpStatus } from '@nestjs/common';
import { isCountryConsistent, marketFor, type MarketplaceProvider } from '@eticketsgo/shared-types';
import type { PrismaService } from '../../prisma/prisma.service';
import { AppException, ErrorCodes } from '../../common/errors';

/**
 * The country an organizer's payout account is set up in: where the organization is
 * registered. Refused BEFORE the provider is asked anything when that provider does not pay
 * out there (Stripe: US and Canada; Razorpay Route: India) or when no country is recorded.
 *
 * One gate for both providers, so the Stripe account call, the Stripe onboarding link and
 * the Razorpay link refuse with the same codes and the same words.
 */
export async function payoutCountryFor(
  prisma: Pick<PrismaService, 'organization'>,
  organizationId: string,
  provider: MarketplaceProvider,
): Promise<string> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, registeredCountry: true },
  });
  if (!org) {
    throw new AppException(ErrorCodes.NOT_FOUND, 'Organization not found.', HttpStatus.NOT_FOUND);
  }
  if (!org.registeredCountry?.trim()) {
    throw new AppException(
      ErrorCodes.ORGANIZATION_DETAILS_INCOMPLETE,
      'Your organization details are incomplete: add your country of registration in Settings, then try again.',
      HttpStatus.UNPROCESSABLE_ENTITY,
      { fields: ['registeredCountry'] },
    );
  }
  const market = marketFor(org.registeredCountry);
  const code = market?.code ?? org.registeredCountry.trim().toUpperCase();
  if (!market || !isCountryConsistent(provider, code)) {
    throw new AppException(
      ErrorCodes.PAYOUT_COUNTRY_UNSUPPORTED,
      'Payout setup here is not available for your country yet.',
      HttpStatus.UNPROCESSABLE_ENTITY,
      { country: code },
    );
  }
  return code;
}
