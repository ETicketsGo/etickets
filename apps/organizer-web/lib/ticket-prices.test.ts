import { describe, expect, it } from 'vitest';
import { money, type EventSession, type TicketType } from '@eticketsgo/web-kit';
import { priceLabel, priceRow, stockLine, ticketPriceList } from './ticket-prices';

const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const HOUR = 3_600_000;

function type(over: Partial<TicketType> = {}): TicketType {
  return {
    id: 't1',
    name: 'General',
    priceMinor: 2500,
    currency: 'USD',
    quantityTotal: 100,
    maxPerOrder: 10,
    salesStartAt: null,
    salesEndAt: null,
    status: 'ACTIVE',
    inventory: { quantityTotal: 100, quantitySold: 30, quantityHeld: 0 },
    ...over,
  };
}

function session(
  id: string,
  startOffsetH: number,
  types: TicketType[] = [],
  status = 'SCHEDULED',
): EventSession {
  return {
    id,
    startsAt: new Date(NOW + startOffsetH * HOUR).toISOString(),
    endsAt: new Date(NOW + (startOffsetH + 2) * HOUR).toISOString(),
    status,
    ticketTypes: types,
  };
}

describe('priceLabel', () => {
  it('formats the price in its own currency with the console money formatter', () => {
    expect(priceLabel(2500, 'USD', false)).toBe(money(2500, 'USD'));
    expect(priceLabel(50000, 'INR', false)).toBe(money(50000, 'INR'));
    expect(priceLabel(2500, 'USD', false)).not.toBe(priceLabel(2500, 'INR', false));
  });

  it('reads Free for a price of 0 or a free event', () => {
    expect(priceLabel(0, 'USD', false)).toBe('Free');
    expect(priceLabel(2500, 'USD', true)).toBe('Free');
  });
});

describe('priceRow', () => {
  it('takes sold and held from the stock record and works out what is left', () => {
    const row = priceRow(
      type({ inventory: { quantityTotal: 100, quantitySold: 30, quantityHeld: 5 } }),
      false,
    );
    expect(row).toMatchObject({ name: 'General', sold: 30, held: 5, available: 65, active: true });
  });

  it('never shows a negative number left', () => {
    const row = priceRow(
      type({ inventory: { quantityTotal: 10, quantitySold: 9, quantityHeld: 4 } }),
      false,
    );
    expect(row.available).toBe(0);
  });

  it('says nothing can be counted when the ticket type has no stock record', () => {
    const row = priceRow(type({ inventory: null }), false);
    expect(row).toMatchObject({ sold: null, held: null, available: null });
    expect(stockLine(row)).toBe('Sold and left not counted yet');
  });

  it('marks a switched-off ticket type', () => {
    expect(priceRow(type({ status: 'INACTIVE' }), false).active).toBe(false);
  });
});

describe('stockLine', () => {
  it('names sold and left, and on hold only when there is any', () => {
    expect(stockLine(priceRow(type(), false))).toBe('30 sold, 70 left');
    expect(
      stockLine(
        priceRow(
          type({ inventory: { quantityTotal: 50, quantitySold: 10, quantityHeld: 2 } }),
          false,
        ),
      ),
    ).toBe('10 sold, 38 left, 2 on hold');
  });
});

describe('ticketPriceList', () => {
  it('lists a single-session event as one group', () => {
    const list = ticketPriceList([session('a', 10, [type(), type({ id: 't2', name: 'VIP' })])], {
      eventIsFree: false,
      now: NOW,
    });
    expect(list.groups).toHaveLength(1);
    expect(list.groups[0].rows.map((r) => r.name)).toEqual(['General', 'VIP']);
    expect(list.types).toBe(2);
    expect(list.hiddenSessions).toBe(0);
  });

  it('puts upcoming sessions first, soonest first, then ended ones, latest first', () => {
    const list = ticketPriceList(
      [session('later', 48), session('old', -100), session('soon', 5), session('recent', -10)],
      { eventIsFree: false, now: NOW },
    );
    expect(list.groups.map((g) => g.sessionId)).toEqual(['soon', 'later', 'recent', 'old']);
    expect(list.groups.map((g) => g.ended)).toEqual([false, false, true, true]);
  });

  it('counts cancelled sessions instead of listing them', () => {
    const list = ticketPriceList(
      [session('a', 5, [type()]), session('b', 6, [type()], 'CANCELLED')],
      {
        eventIsFree: false,
        now: NOW,
      },
    );
    expect(list.groups.map((g) => g.sessionId)).toEqual(['a']);
    expect(list.cancelledSessions).toBe(1);
  });

  it('caps the sessions listed and counts the rest', () => {
    const many = Array.from({ length: 8 }, (_, i) => session(`s${i}`, i + 1, [type()]));
    const list = ticketPriceList(many, { eventIsFree: false, now: NOW, cap: 5 });
    expect(list.groups).toHaveLength(5);
    expect(list.hiddenSessions).toBe(3);
    expect(list.types).toBe(5);
  });

  it('prices every row Free for a free event', () => {
    const list = ticketPriceList([session('a', 5, [type()])], { eventIsFree: true, now: NOW });
    expect(list.groups[0].rows[0].price).toBe('Free');
  });

  it('handles an event with no sessions', () => {
    expect(ticketPriceList([], { eventIsFree: false, now: NOW })).toEqual({
      groups: [],
      hiddenSessions: 0,
      cancelledSessions: 0,
      types: 0,
    });
  });
});
