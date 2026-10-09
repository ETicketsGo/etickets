import { VenuesService } from './venues.service';

/**
 * A venue's time zone, when the organizer did not pick one.
 *
 * Found on QA: a Hyderabad concert at 19:00 read "7:30 am" on the payment page to a buyer whose
 * browser was in the United States, because the venue had no zone and the page fell back to
 * the reader's. Where the country has one zone the venue gets it; where it has several, it is
 * still never guessed.
 */
describe('VenuesService.create time zone', () => {
  const user = { id: 'u1' } as never;
  const make = () => {
    const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => data);
    const service = new VenuesService(
      { venue: { create } } as never,
      { assertMember: jest.fn(async () => undefined) } as never,
    );
    return { service, create };
  };
  const base = { name: 'Hall', city: 'Hyderabad' };

  it('stores the only zone a single-zone country has', async () => {
    const { service, create } = make();
    await service.create(user, 'org1', { ...base, country: 'IN' } as never);
    expect(create.mock.calls[0][0].data.timezone).toBe('Asia/Kolkata');
  });

  it('never guesses for a country with several zones', async () => {
    const { service, create } = make();
    await service.create(user, 'org1', { ...base, city: 'Dallas', country: 'US' } as never);
    expect(create.mock.calls[0][0].data.timezone).toBeUndefined();
  });

  it('keeps the zone the organizer chose', async () => {
    const { service, create } = make();
    await service.create(user, 'org1', {
      ...base,
      country: 'IN',
      timezone: 'Asia/Dubai',
    } as never);
    expect(create.mock.calls[0][0].data.timezone).toBe('Asia/Dubai');
  });
});
