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

/**
 * The currency a set of priced lines - and anything sold beside them - is in.
 *
 * ONE rule for every financial write that has to pick a currency: a booking, and the add-ons
 * and bundles sold with an event's tickets.
 *
 *   - A priced line is authoritative. Its currency was settled when it was priced.
 *   - Lines in more than one currency are refused, never averaged or guessed between.
 *   - With no priced line, only a known, supported venue country may answer. Nothing priced
 *     is not evidence of India, so an unknown fails closed.
 *
 * It lived privately in `BookingsService.cartCurrency`. Add-ons and bundles then took the
 * column default instead - 'INR' for every venue in every country - because there was no
 * shared rule to call. Lifting it here is what lets them agree with the booking they are
 * added to.
 */
export function resolveCommerceCurrency(
  pricedCurrencies: (string | null | undefined)[],
  venueCountry: string | null | undefined,
): string {
  const distinct = [
    ...new Set(pricedCurrencies.map((c) => c?.trim().toUpperCase()).filter(Boolean)),
  ] as string[];
  if (distinct.length > 1) {
    throw new AppException(
      ErrorCodes.VALIDATION_FAILED,
      'These tickets are priced in different currencies and cannot be bought together.',
      HttpStatus.BAD_REQUEST,
      { currencies: distinct },
    );
  }
  return distinct[0] ?? requireCommerceCurrency(venueCountry);
}

/** The least of Prisma this needs, so a caller's transaction client can be passed in too. */
interface EventCurrencyReader {
  ticketType: {
    findMany(args: {
      where: { eventSession: { eventId: string } };
      select: { currency: true };
    }): Promise<{ currency: string | null }[]>;
  };
  event: {
    findUnique(args: {
      where: { id: string };
      select: { venue: { select: { country: true } } };
    }): Promise<{ venue: { country: string | null } | null } | null>;
  };
}

/**
 * The currency an EVENT sells in, for things priced beside its tickets.
 *
 * Its ticket types first - they are what a booking for this event will be priced in, and an
 * add-on in any other currency would be refused at checkout as a mixed cart - then its
 * venue's country, failing closed when neither can answer.
 */
export async function currencyForEvent(db: EventCurrencyReader, eventId: string): Promise<string> {
  const [ticketTypes, event] = await Promise.all([
    db.ticketType.findMany({ where: { eventSession: { eventId } }, select: { currency: true } }),
    db.event.findUnique({
      where: { id: eventId },
      select: { venue: { select: { country: true } } },
    }),
  ]);
  return resolveCommerceCurrency(
    ticketTypes.map((t) => t.currency),
    event?.venue?.country,
  );
}
