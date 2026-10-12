import { describe, expect, it } from 'vitest';
import { eventIsSoldOut, showIsSoldOut } from './event-availability';

const NOW = Date.parse('2026-10-12T10:00:00Z');
const future = '2026-11-01T18:00:00Z';
const past = '2026-10-01T18:00:00Z';

describe('showIsSoldOut', () => {
  it('is true only when every ticket type is out of stock', () => {
    expect(showIsSoldOut({ ticketTypes: [{ available: 0 }, { available: 0 }] })).toBe(true);
    expect(showIsSoldOut({ ticketTypes: [{ available: 0 }, { available: 3 }] })).toBe(false);
  });

  it('is not sold out when nothing was ever for sale', () => {
    expect(showIsSoldOut({ ticketTypes: [] })).toBe(false);
    expect(showIsSoldOut(undefined)).toBe(false);
  });
});

describe('eventIsSoldOut', () => {
  it('is true when every upcoming date is sold out', () => {
    const shows = [
      { startsAt: future, ticketTypes: [{ available: 0 }] },
      { startsAt: future, ticketTypes: [{ available: 0 }] },
    ];
    expect(eventIsSoldOut(shows, NOW)).toBe(true);
  });

  it('is false while another date still has tickets', () => {
    const shows = [
      { startsAt: future, ticketTypes: [{ available: 0 }] },
      { startsAt: future, ticketTypes: [{ available: 2 }] },
    ];
    expect(eventIsSoldOut(shows, NOW)).toBe(false);
  });

  it('ignores a date that has already started', () => {
    const shows = [
      { startsAt: past, ticketTypes: [{ available: 5 }] },
      { startsAt: future, ticketTypes: [{ available: 0 }] },
    ];
    expect(eventIsSoldOut(shows, NOW)).toBe(true);
  });

  it('is false when there is no upcoming date at all', () => {
    expect(eventIsSoldOut([{ startsAt: past, ticketTypes: [{ available: 0 }] }], NOW)).toBe(false);
    expect(eventIsSoldOut([], NOW)).toBe(false);
  });
});
