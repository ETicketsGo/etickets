import { describe, expect, it } from 'vitest';
import type { EventSession, TicketType } from '@eticketsgo/web-kit';
import { isLongText, sessionBreakdown, ticketTotals } from './event-overview-model';

const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const HOUR = 3_600_000;

function session(id: string, startOffsetH: number, status = 'SCHEDULED', types: TicketType[] = []) {
  return {
    id,
    startsAt: new Date(NOW + startOffsetH * HOUR).toISOString(),
    endsAt: new Date(NOW + (startOffsetH + 2) * HOUR).toISOString(),
    status,
    ticketTypes: types,
  } satisfies EventSession;
}

function type(total: number, sold: number, held: number, inventory = true): TicketType {
  return {
    id: `t${total}${sold}`,
    name: 'GA',
    priceMinor: 1000,
    currency: 'INR',
    quantityTotal: total,
    maxPerOrder: 10,
    salesStartAt: null,
    salesEndAt: null,
    status: 'ACTIVE',
    inventory: inventory ? { quantityTotal: total, quantitySold: sold, quantityHeld: held } : null,
  };
}

describe('ticketTotals', () => {
  it('adds the inventory across every session and ticket type', () => {
    expect(
      ticketTotals([
        session('a', 10, 'SCHEDULED', [type(100, 30, 2), type(50, 5, 0)]),
        session('b', 20, 'SCHEDULED', [type(20, 20, 0)]),
      ]),
    ).toEqual({ capacity: 170, sold: 55, held: 2, types: 3 });
  });

  it('counts nothing for a ticket type with no inventory row, rather than guessing', () => {
    expect(ticketTotals([session('a', 1, 'SCHEDULED', [type(80, 0, 0, false)])])).toEqual({
      capacity: 0,
      sold: 0,
      held: 0,
      types: 1,
    });
    expect(ticketTotals([])).toEqual({ capacity: 0, sold: 0, held: 0, types: 0 });
  });
});

describe('sessionBreakdown', () => {
  it('lists what is still to come soonest first, and counts the rest', () => {
    const b = sessionBreakdown(
      [
        session('later', 48),
        session('done', -100),
        session('now', -1), // started an hour ago, ends in one: still on
        session('off', 5, 'CANCELLED'),
        session('soon', 3),
      ],
      NOW,
    );
    expect(b.upcoming.map((s) => s.id)).toEqual(['now', 'soon', 'later']);
    expect(b.past).toBe(1);
    expect(b.cancelled).toBe(1);
  });

  it('handles fifty sessions without losing any', () => {
    const many = Array.from({ length: 50 }, (_, i) => session(`s${i}`, i * 24 - 240));
    const b = sessionBreakdown(many, NOW);
    expect(b.upcoming.length + b.past + b.cancelled).toBe(50);
    expect(b.past).toBe(10);
  });
});

describe('isLongText', () => {
  it('folds long paragraphs and long lists, and leaves short text alone', () => {
    expect(isLongText(null)).toBe(false);
    expect(isLongText('A short note.')).toBe(false);
    expect(isLongText('x'.repeat(321))).toBe(true);
    expect(isLongText('1\n2\n3\n4\n5\n6')).toBe(true);
  });
});
