import { showZone } from '../refunds/cash-returns.service';
import { cancelImpact, totalsByCurrency } from './event-cancel-impact';

const b = (over: Partial<Parameters<typeof cancelImpact>[1][number]> = {}) => ({
  paymentMethod: 'ONLINE',
  totalMinor: 10_000,
  currency: 'INR',
  cashCollectedAt: null as Date | null,
  refundCount: 0,
  ...over,
});

describe('what cancelling an event does to money', () => {
  it('splits online refunds, cash to give back, free bookings and refunds already open', () => {
    const impact = cancelImpact(2, [
      b(),
      b({ totalMinor: 5_000 }),
      b({ refundCount: 1 }),
      b({ totalMinor: 0 }),
      b({ paymentMethod: 'CASH', cashCollectedAt: new Date(), totalMinor: 21_420 }),
    ]);
    expect(impact).toEqual({
      datesToCancel: 2,
      onlineRefunds: { count: 2, totals: [{ currency: 'INR', amountMinor: 15_000 }] },
      alreadyInRefund: 1,
      free: 1,
      cash: { count: 1, totals: [{ currency: 'INR', amountMinor: 21_420 }] },
    });
  });

  it('never counts cash as an online refund', () => {
    const impact = cancelImpact(1, [b({ paymentMethod: 'CASH', cashCollectedAt: new Date() })]);
    expect(impact.onlineRefunds.count).toBe(0);
    expect(impact.cash.count).toBe(1);
  });

  it('keeps each currency apart', () => {
    expect(
      totalsByCurrency([
        { currency: 'USD', amountMinor: 100 },
        { currency: 'INR', amountMinor: 900 },
        { currency: 'USD', amountMinor: 50 },
      ]),
    ).toEqual([
      { currency: 'INR', amountMinor: 900 },
      { currency: 'USD', amountMinor: 150 },
    ]);
  });
});

describe('the zone a counter list reads a show time in', () => {
  const india = { timezone: null, country: 'India' };
  it("is the space's venue, then its cinema, then the event's venue", () => {
    expect(
      showZone(india, {
        venue: { timezone: 'Asia/Kolkata', country: 'India' },
        cinema: { timezone: 'Europe/London' },
      }),
    ).toBe('Asia/Kolkata');
    expect(showZone(india, { venue: null, cinema: { timezone: 'Asia/Kolkata' } })).toBe(
      'Asia/Kolkata',
    );
  });
  it("falls back to the only zone the event venue's country has", () => {
    expect(showZone(india, null)).toBe('Asia/Kolkata');
  });
  it('says nothing rather than guess for a country with several zones', () => {
    expect(showZone({ timezone: null, country: 'United States' }, null)).toBeNull();
  });
});
