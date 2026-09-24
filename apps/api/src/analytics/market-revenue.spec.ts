import 'reflect-metadata';
import { BusinessReportsService } from './business-reports.service';
import { MARKETS } from '@eticketsgo/shared-types';

/**
 * The country view of the reports page.
 *
 * ── WHAT THIS PROTECTS ─────────────────────────────────────────────────────────────
 * "Business reports show only INR" was a report that could not be told apart from a broken one:
 * a market with nothing in it was simply absent. These tests hold the two properties that make
 * the answer readable - every configured market is present with its zeros, and the spellings of a
 * country in `Venue.country` fold into one row rather than splitting a market in half.
 *
 * They also hold the line that a currency is NOT a country: the rows carry both, and the money
 * stays in the currency it was taken in.
 */
const FROM = new Date('2026-09-01T00:00:00.000Z');
const TO = new Date('2026-09-30T23:59:59.999Z');

function makeService(sales: unknown[], refunds: unknown[]) {
  // Two $queryRaw calls, in the order `marketRevenue` awaits them.
  const $queryRaw = jest
    .fn()
    .mockResolvedValueOnce(sales)
    .mockResolvedValueOnce(refunds)
    .mockResolvedValue([]);
  const prisma = { $queryRaw } as never;
  return new BusinessReportsService(prisma, {} as never, {} as never);
}

const sale = (country: string | null, currency: string, over: Record<string, unknown> = {}) => ({
  country,
  currency,
  gross: 100_000n,
  bookingfee: 5_000n,
  paymentfee: 2_000n,
  bookings: 4n,
  organizers: 2n,
  events: 3n,
  ...over,
});

describe('business reports: by market', () => {
  it('lists every configured market, with zeros for the ones that sold nothing', async () => {
    const service = makeService([sale('India', 'INR')], []);

    const report = await service.marketRevenue(FROM, TO);

    expect(report.markets).toHaveLength(MARKETS.length);
    const india = report.markets.find((m) => m.country === 'India');
    expect(india).toMatchObject({ code: 'IN', currency: 'INR', bookings: 4, configured: true });

    // The half that answers "why do I only see rupees" without anybody having to ask.
    const us = report.markets.find((m) => m.code === 'US');
    expect(us).toMatchObject({ currency: 'USD', bookings: 0, grossMinor: 0, configured: true });
  });

  it('folds the spellings of one country into one row', async () => {
    /* `Venue.country` holds whatever was typed before the dropdown existed. */
    const service = makeService([sale('India', 'INR'), sale('IN', 'INR', { gross: 50_000n })], []);

    const report = await service.marketRevenue(FROM, TO);

    const india = report.markets.filter((m) => m.country === 'India');
    expect(india).toHaveLength(1);
    expect(india[0].grossMinor).toBe(150_000);
    expect(india[0].bookings).toBe(8);
  });

  it('keeps one country per currency and never adds two currencies together', async () => {
    const service = makeService(
      [sale('India', 'INR'), sale('United States', 'USD', { gross: 2_000n })],
      [],
    );

    const report = await service.marketRevenue(FROM, TO);

    const traded = report.markets.filter((m) => m.bookings > 0);
    expect(traded.map((m) => [m.country, m.currency, m.grossMinor])).toEqual([
      ['India', 'INR', 100_000],
      ['United States', 'USD', 2_000],
    ]);
  });

  it('subtracts refunds within the market that made them', async () => {
    const service = makeService(
      [sale('India', 'INR')],
      [{ country: 'India', currency: 'INR', refunds: 30_000n }],
    );

    const report = await service.marketRevenue(FROM, TO);

    const india = report.markets.find((m) => m.country === 'India');
    expect(india).toMatchObject({ refundsMinor: 30_000, netMinor: 70_000 });
  });

  it('names a country the platform has no market configuration for rather than hiding it', async () => {
    /* A venue in a country we cannot take money in is a data problem worth seeing. */
    const service = makeService([sale('Ruritania', 'INR')], []);

    const report = await service.marketRevenue(FROM, TO);

    const row = report.markets.find((m) => m.country === 'Ruritania');
    expect(row).toMatchObject({ configured: false, code: null, bookings: 4 });
  });

  it('reports a sale whose venue has no country at all, said out loud', async () => {
    const service = makeService([sale(null, 'INR')], []);

    const report = await service.marketRevenue(FROM, TO);

    expect(report.markets.some((m) => m.country === 'Country not recorded')).toBe(true);
  });
});
