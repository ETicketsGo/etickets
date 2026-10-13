import { PublicEventsService } from './public-events.service';
import { AdvertisedPriceService } from '../pricing/advertised-price.service';

const advertised = new AdvertisedPriceService(
  { feeRule: { findMany: async () => [] } } as never,
  { get: () => undefined } as never,
);

const row = (id: string, city: string, country: string | null) => ({
  id,
  organizationId: 'org',
  title: id,
  slug: id,
  category: 'Music',
  feeMode: 'ADDED',
  venue: { name: 'V', city, country, region: null, timezone: null },
  organization: { name: 'Org' },
  images: [],
  sessions: [],
});

function serviceWith(rows: ReturnType<typeof row>[]) {
  const prisma = {
    event: { count: jest.fn(), findMany: jest.fn(async () => rows) },
    $transaction: jest.fn(async (qs: Promise<unknown>[]) => Promise.all(qs)),
  };
  return new PublicEventsService(prisma as never, advertised);
}

describe('PublicEventsService.list venue country', () => {
  it('answers one spelling per country, whatever the venue row stored', async () => {
    // "India" and "IN" are the same market; the card must not make them two groups.
    const result = await serviceWith([
      row('a', 'Hyderabad', 'India'),
      row('b', 'Hyderabad', 'IN'),
      row('c', 'Boise', 'USA'),
      row('d', 'Toronto', 'canada'),
    ]).list({ page: 1, pageSize: 10 });
    expect(result.data.map((e) => [e.venue.city, e.venue.country, e.venue.countryCode])).toEqual([
      ['Hyderabad', 'India', 'IN'],
      ['Hyderabad', 'India', 'IN'],
      ['Boise', 'United States', 'US'],
      ['Toronto', 'Canada', 'CA'],
    ]);
  });

  it('keeps the stored spelling of a country that is not a market, and never invents one', async () => {
    const result = await serviceWith([row('a', 'Oslo', 'Norway'), row('b', 'X', null)]).list({
      page: 1,
      pageSize: 10,
    });
    expect(result.data.map((e) => [e.venue.country, e.venue.countryCode])).toEqual([
      ['Norway', null],
      [null, null],
    ]);
  });
});
