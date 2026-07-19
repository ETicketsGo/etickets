import { describe, it, expect } from 'vitest';
import { deriveEventInsights, type EventInsightInput } from '@eticketsgo/shared-types';

const base: EventInsightInput = {
  ticketsSold: 10,
  ticketsRemaining: 90,
  grossMinor: 100000,
  refundsMinor: 0,
  salesByTicketType: [
    { ticketType: 'General', quantity: 8, grossMinor: 60000 },
    { ticketType: 'VIP', quantity: 2, grossMinor: 40000 },
  ],
  salesByDay: [
    { day: '2026-07-01', bookings: 6, grossMinor: 60000 },
    { day: '2026-07-02', bookings: 4, grossMinor: 40000 },
  ],
  daysToEvent: 60,
};

const keys = (i: EventInsightInput) => deriveEventInsights(i).map((x) => x.key);

describe('deriveEventInsights', () => {
  it('flags nearly-sold-out at >=90% with remaining stock', () => {
    expect(keys({ ...base, ticketsSold: 95, ticketsRemaining: 5 })).toContain('NEARLY_SOLD_OUT');
  });

  it('flags sold out (positive) when nothing remains', () => {
    const r = deriveEventInsights({ ...base, ticketsSold: 100, ticketsRemaining: 0 });
    const sold = r.find((x) => x.key === 'SOLD_OUT');
    expect(sold?.level).toBe('positive');
    expect(keys({ ...base, ticketsSold: 100, ticketsRemaining: 0 })).not.toContain(
      'NEARLY_SOLD_OUT',
    );
  });

  it('flags a high refund rate at >=10% of gross', () => {
    expect(keys({ ...base, refundsMinor: 15000 })).toContain('HIGH_REFUND_RATE');
    expect(keys({ ...base, refundsMinor: 5000 })).not.toContain('HIGH_REFUND_RATE');
  });

  it('warns on slow sales near the event with low utilization + soft recent pace', () => {
    const slow: EventInsightInput = {
      ...base,
      ticketsSold: 10,
      ticketsRemaining: 90,
      daysToEvent: 5,
      salesByDay: [{ day: '2026-07-10', bookings: 1, grossMinor: 1000 }],
    };
    expect(keys(slow)).toContain('SLOW_SALES');
    // Far-off events are not flagged slow.
    expect(keys({ ...slow, daysToEvent: 60 })).not.toContain('SLOW_SALES');
  });

  it('always surfaces the most popular ticket and peak booking day when there are sales', () => {
    const r = deriveEventInsights(base);
    expect(r.find((x) => x.key === 'POPULAR_TICKET')?.detail).toContain('General');
    expect(r.find((x) => x.key === 'PEAK_DAY')?.detail).toContain('2026-07-01');
  });
});
