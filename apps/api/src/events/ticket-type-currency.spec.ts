import { EventsService } from './events.service';

/**
 * What currency an organizer's tickets are priced in.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────
 * `createTicketTypeSchema` defaulted the currency to `'INR'` and no console has ever sent
 * one, so every ticket type on the platform was created in rupees regardless of where the
 * event was. On QA that produced a ₹499 ticket for a show in Meridian, Idaho.
 *
 * The wrong symbol is the least of it. The currency chooses the fee tiers, the tax rules
 * and — through `routeProviderForBooking` — which payment provider takes the money. A
 * dollar show was going to be charged with Indian fee bands through an Indian gateway.
 *
 * ── WHY THE SERVICE AND NOT THE SCHEMA ─────────────────────────────────────────────
 * A validation schema can see the request and cannot see the venue, and the venue is the
 * only thing that knows the answer. So the schema stopped deciding and the service asks.
 */
function setup(venueCountry: string | null) {
  const create = jest.fn().mockResolvedValue({ id: 'tt-1' });
  const prisma = {
    eventSession: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'es-1',
        event: {
          id: 'ev-1',
          organizationId: 'org-1',
          isFree: false,
          venue: venueCountry === null ? null : { country: venueCountry },
        },
      }),
    },
    ticketType: { create },
  };
  const access = { assertMember: jest.fn().mockResolvedValue(undefined) };
  const stub = {} as never;
  /*
    Listed one per line rather than spread, so adding a constructor dependency breaks this
    at COMPILE time — which is the moment to decide whether pricing currency cares about it.
  */
  const service = new EventsService(
    prisma as never,
    access as never,
    stub, // audit
    stub, // audience
    stub, // config
    stub, // shows
  );
  return { service, create };
}

const ORGANIZER = { id: 'u-1', email: 'o@t.test', fullName: 'O', roles: [] } as never;
const input = {
  eventSessionId: 'es-1',
  name: 'General',
  priceMinor: 49_900,
  quantityTotal: 50,
  maxPerOrder: 10,
} as never;

describe('ticket-type currency follows the venue', () => {
  it('prices a show in the United States in dollars', async () => {
    const { service, create } = setup('USA');
    await service.addTicketType(ORGANIZER, input);
    expect(create.mock.calls[0][0].data.currency).toBe('USD');
  });

  it('prices a show in India in rupees', async () => {
    const { service, create } = setup('India');
    await service.addTicketType(ORGANIZER, input);
    expect(create.mock.calls[0][0].data.currency).toBe('INR');
  });

  it('reads the country however the venue form spelled it', async () => {
    // Venues store free text. "US", "USA" and "United States" are the same country and
    // must not price differently depending on who typed the address.
    for (const spelling of ['US', 'usa', 'United States']) {
      const { service, create } = setup(spelling);
      await service.addTicketType(ORGANIZER, input);
      expect(create.mock.calls[0][0].data.currency).toBe('USD');
    }
  });

  it('lets an explicit currency win over the venue', async () => {
    // The caller has said what they mean; the venue is only ever the default.
    const { service, create } = setup('USA');
    await service.addTicketType(ORGANIZER, { ...(input as object), currency: 'CAD' } as never);
    expect(create.mock.calls[0][0].data.currency).toBe('CAD');
  });

  it('falls back to rupees for a market with no mapping, exactly as before', async () => {
    // Not a guess at Kenya's currency — a deliberate no-change for anyone the map does not
    // cover, so this fix cannot alter an existing market it does not understand.
    const { service, create } = setup('Kenya');
    await service.addTicketType(ORGANIZER, input);
    expect(create.mock.calls[0][0].data.currency).toBe('INR');
  });

  it('falls back to rupees when the event has no venue at all', async () => {
    const { service, create } = setup(null);
    await service.addTicketType(ORGANIZER, input);
    expect(create.mock.calls[0][0].data.currency).toBe('INR');
  });
});
