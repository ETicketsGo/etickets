import { describe, expect, it } from 'vitest';
import { arrivalFacts, isEveningShow, longVenueDate } from './event-editorial';
import { selectedTicketId, type ChooserTicket } from '../components/event-reservation';

describe('longVenueDate', () => {
  it("writes the date out on the venue's clock, not the reader's", () => {
    // 01:30 UTC on 6 Nov is 18:30 on Thursday 5 Nov in Boise (MST, UTC-7).
    const boise = longVenueDate('2026-11-06T01:30:00.000Z', 'America/Boise', 'en-GB');
    expect(boise).toMatchObject({
      weekday: 'Thursday',
      date: '5 November 2026',
      short: 'Thursday 5 November',
      hour: 18,
    });
    // The same instant in Bengaluru is the next morning.
    const india = longVenueDate('2026-11-06T01:30:00.000Z', 'Asia/Kolkata', 'en-IN');
    expect(india.weekday).toBe('Friday');
    expect(india.hour).toBe(7);
  });
});

describe('isEveningShow', () => {
  it('calls a show "the evening" only from 5 pm at the venue', () => {
    expect(isEveningShow(10)).toBe(false);
    expect(isEveningShow(16)).toBe(false);
    expect(isEveningShow(17)).toBe(true);
    expect(isEveningShow(23)).toBe(true);
  });
});

describe('arrivalFacts', () => {
  it('lists only what is true for every event, and nothing without a date to arrive at', () => {
    expect(arrivalFacts(true)).toEqual(['offline', 'transfer']);
    expect(arrivalFacts(false)).toEqual([]);
  });

  it('never claims a refund window, doors or parking the public event does not carry', () => {
    expect(arrivalFacts(true)).not.toContain('refund');
    expect(arrivalFacts(true)).not.toContain('parking');
  });
});

describe('selectedTicketId', () => {
  const ticket = (id: string, unavailable = false): ChooserTicket => ({
    id,
    name: id,
    price: '$1',
    meta: null,
    unavailable,
    max: unavailable ? 0 : 10,
  });

  it('starts on the first ticket still on sale', () => {
    expect(selectedTicketId([ticket('closed', true), ticket('ga'), ticket('vip')], null, {})).toBe(
      'ga',
    );
  });

  it('keeps the buyer choice, and otherwise a ticket already counted (a restored selection)', () => {
    const tickets = [ticket('ga'), ticket('vip')];
    expect(selectedTicketId(tickets, 'vip', {})).toBe('vip');
    expect(selectedTicketId(tickets, null, { vip: 2 })).toBe('vip');
  });

  it('never selects a ticket that cannot be bought', () => {
    expect(selectedTicketId([ticket('ga', true)], 'ga', {})).toBeNull();
  });
});
