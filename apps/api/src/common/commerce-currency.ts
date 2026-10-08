import { HttpStatus } from '@nestjs/common';
import { currencyForCountry } from './country';
import { AppException, ErrorCodes } from './errors';

/** Resolve currency only from an authoritative, supported country answer. */
export function requireCommerceCurrency(country: string | null | undefined): string {
  const currency = currencyForCountry(country);
  if (currency) return currency;

  throw new AppException(
    ErrorCodes.CONFLICT,
    'Currency cannot be determined. Complete the venue country with a supported market before pricing or checkout.',
    HttpStatus.CONFLICT,
    { reason: 'CURRENCY_CONTEXT_REQUIRED' },
  );
}
