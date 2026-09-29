import { describe, it, expect } from 'vitest';
import { CURRENCY_PROVIDERS, isCountryConsistent, routeProviderForBooking } from './marketplace';

/**
 * Which provider takes a booking, decided from the booking's own currency and country.
 *
 * ── THE GAP THIS CLOSES ────────────────────────────────────────────────────────────
 * Two tables used to answer this question. `prisma/payment-routing-policy.ts` wrote the route
 * rows and knew INR, USD and CAD; `routeProviderForBooking`, which chooses the provider for a
 * REAL booking, knew only USD and INR. So the platform advertised a CAD route that no Canadian
 * checkout could use - `CAD` returned null and the buyer was told no provider supports their
 * currency. Canada was also missing from Stripe's country list, so even a corrected currency
 * would have been refused on the country check straight after.
 *
 * They are one table now. These tests are about the pairs that must keep working, not about the
 * table's contents for their own sake.
 */
describe('choosing a provider for a booking', () => {
  it('sends each launch currency somewhere', () => {
    expect(routeProviderForBooking({ currency: 'INR' })).toBe('razorpay');
    expect(routeProviderForBooking({ currency: 'USD' })).toBe('stripe');
    expect(routeProviderForBooking({ currency: 'CAD' })).toBe('stripe');
  });

  it('refuses a currency nobody settles, rather than guessing', () => {
    // Null makes the caller reject explicitly. Falling through to whichever provider happens to
    // be configured would charge a buyer through a gateway that cannot settle their money.
    expect(routeProviderForBooking({ currency: 'JPY' })).toBeNull();
  });

  it('does not care how the currency was cased', () => {
    expect(routeProviderForBooking({ currency: 'cad' })).toBe('stripe');
  });

  it('accepts the country each provider actually serves', () => {
    for (const country of ['US', 'USA', 'United States', 'CA', 'Canada']) {
      expect({ country, ok: isCountryConsistent('stripe', country) }).toEqual({
        country,
        ok: true,
      });
    }
    expect(isCountryConsistent('razorpay', 'India')).toBe(true);
  });

  it('still refuses a country its provider cannot serve', () => {
    // The check exists to catch a venue whose country contradicts its currency.
    expect(isCountryConsistent('razorpay', 'United States')).toBe(false);
    expect(isCountryConsistent('stripe', 'India')).toBe(false);
  });

  it('lets an unknown country pass, because currency is authoritative', () => {
    // Stored country strings are inconsistent; the currency is the trusted field.
    expect(isCountryConsistent('stripe', '')).toBe(true);
    expect(isCountryConsistent('stripe', null)).toBe(true);
  });

  it('routes a booking to the first provider its currency lists', () => {
    // The guard that keeps the two readers honest: whatever the table says, the live booking
    // takes the head of the list and the seed filters the same list by reachable keys.
    for (const [currency, providers] of Object.entries(CURRENCY_PROVIDERS)) {
      expect({ currency, chosen: routeProviderForBooking({ currency }) }).toEqual({
        currency,
        chosen: providers[0],
      });
    }
  });
});
