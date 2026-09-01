import { BookingsService } from './bookings.service';

/**
 * What currency a booking is taken in.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────
 * `Booking.currency` was never written, so it fell to the column default of `'INR'`, and
 * both `create` and `quote` passed the literal `'INR'` to the fee calculator. Every
 * booking on the platform therefore claimed to be in rupees whatever it was selling.
 *
 * That is not cosmetic. The currency selects the fee tiers, the tax rules and — through
 * `routeProviderForBooking` — which payment provider receives the charge. A dollar sale
 * would have had rupee fee bands applied and been routed to an Indian gateway.
 *
 * ── WHY THE TICKET TYPES AND NOT THE VENUE ─────────────────────────────────────────
 * The venue's country decides what a NEW ticket type is priced in. Once priced, the
 * stored currency is the fact. Re-deriving from the venue at booking time would let an
 * organizer editing an address silently re-denominate tickets already on sale.
 */
const service = () =>
  new BookingsService(
    {} as never, // prisma
    {} as never, // pricing
    {} as never, // pricingStrategies
    {} as never, // audit
    {} as never, // inventory
    {} as never, // addOnInventory
    {} as never, // metrics
    {} as never, // lockShadow
    {} as never, // bookingShadow
  );

/** `cartCurrency` is private; these tests are about its rule, not its visibility. */
const cartCurrency = (
  priced: { currency?: string | null }[],
  venueCountry?: string | null,
): string =>
  (service() as unknown as { cartCurrency: (p: unknown, c: unknown) => string }).cartCurrency(
    priced,
    venueCountry ?? null,
  );

describe('the currency a cart is priced in', () => {
  it('comes from the tickets being bought', () => {
    expect(cartCurrency([{ currency: 'USD' }, { currency: 'USD' }], 'India')).toBe('USD');
  });

  it('ignores the venue when the tickets already say', () => {
    // An organizer moving an event to a new address must not re-denominate tickets that
    // are already on sale at a price somebody has seen.
    expect(cartCurrency([{ currency: 'INR' }], 'USA')).toBe('INR');
  });

  it('is case-insensitive, because stored data is not disciplined', () => {
    expect(cartCurrency([{ currency: 'usd' }, { currency: 'USD' }])).toBe('USD');
  });

  it('REFUSES a cart holding two currencies rather than picking one', () => {
    /*
      There is one `totalMinor` and one charge. Two currencies cannot be added without an
      exchange rate and this platform has no rate source, so the only honest answers are
      "refuse" and "invent a number". Taking the first line's currency would charge
      somebody dollars for a rupee ticket at 1:1 — an error found on a bank statement.
    */
    expect(() => cartCurrency([{ currency: 'INR' }, { currency: 'USD' }])).toThrow(
      /different currencies/i,
    );
  });

  it('falls back to the venue for an empty cart, which still produces a zero-total row', () => {
    expect(cartCurrency([], 'USA')).toBe('USD');
  });

  it('lets a line with no currency contribute no opinion instead of crashing', () => {
    /*
      `TicketType.currency` is NOT NULL with a default, so a missing one means a `select`
      that did not ask for the column. Reading through it would throw in the middle of the
      booking path, turning a query oversight into a customer who cannot buy a ticket.
    */
    expect(cartCurrency([{ currency: undefined }, { currency: 'USD' }])).toBe('USD');
    expect(cartCurrency([{ currency: null }], 'India')).toBe('INR');
    expect(cartCurrency([{ currency: '  ' }], 'USA')).toBe('USD');
  });

  it('falls back to rupees when nothing can answer, exactly as before', () => {
    // The pre-existing behaviour, kept deliberately: an unmapped market is unchanged by
    // this fix rather than guessed at.
    expect(cartCurrency([], 'Kenya')).toBe('INR');
    expect(cartCurrency([], null)).toBe('INR');
  });
});
