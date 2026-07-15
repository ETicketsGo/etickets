import { describe, it, expect } from 'vitest';
import {
  groupWalletTickets,
  summarizeBookingGroup,
  countByStatus,
  compareSeatLabels,
  pickInitialTicketIndex,
  isTicketInactive,
  type GroupCounts,
} from './tickets';
import type { WalletTicket } from './api';

/** Minimal WalletTicket factory; override per case. */
function ticket(over: Partial<WalletTicket> & { id: string }): WalletTicket {
  return {
    serial: over.id.toUpperCase(),
    status: 'ACTIVE',
    holderName: null,
    ticketType: 'General',
    event: { title: 'DevConf India 2026', slug: 'devconf-india-2026' },
    startsAt: '2026-09-01T10:00:00.000Z',
    qrDataUrl: 'data:image/png;base64,QR',
    bookingId: 'bk_1',
    ...over,
  };
}

const counts = (over: Partial<GroupCounts>): GroupCounts => ({
  total: 0,
  active: 0,
  checkedIn: 0,
  refunded: 0,
  cancelled: 0,
  other: 0,
  ...over,
});

describe('groupWalletTickets', () => {
  it('renders a one-ticket booking as a single group', () => {
    const groups = groupWalletTickets([ticket({ id: 't1', bookingId: 'bk_1' })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].tickets).toHaveLength(1);
    expect(groups[0].counts.total).toBe(1);
    expect(groups[0].bookingId).toBe('bk_1');
  });

  it('collapses a ten-ticket booking into ONE group', () => {
    const tickets = Array.from({ length: 10 }, (_, i) =>
      ticket({ id: `t${i}`, serial: `S${i}`, bookingId: 'bk_big' }),
    );
    const groups = groupWalletTickets(tickets);
    expect(groups).toHaveLength(1);
    expect(groups[0].counts.total).toBe(10);
    expect(groups[0].summary).toBe('10 active');
  });

  it('keeps two separate bookings for the same event as separate groups', () => {
    const groups = groupWalletTickets([
      ticket({ id: 'a1', bookingId: 'bk_a' }),
      ticket({ id: 'a2', bookingId: 'bk_a' }),
      ticket({ id: 'b1', bookingId: 'bk_b' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.bookingId)).toEqual(['bk_a', 'bk_b']);
    expect(groups[0].counts.total).toBe(2);
    expect(groups[1].counts.total).toBe(1);
  });

  it('summarizes a mix of active and checked-in tickets', () => {
    const groups = groupWalletTickets([
      ticket({ id: 't1', status: 'CHECKED_IN' }),
      ticket({ id: 't2', status: 'CHECKED_IN' }),
      ...Array.from({ length: 6 }, (_, i) => ticket({ id: `a${i}`, status: 'ACTIVE' })),
    ]);
    expect(groups[0].summary).toBe('2 checked in · 6 remaining');
    expect(groups[0].checkInProgress).toBe('2 of 8 checked in');
    expect(groups[0].statusTone).toBe('success');
  });

  it('summarizes a partial refund', () => {
    const groups = groupWalletTickets([
      ticket({ id: 'r1', status: 'REFUNDED' }),
      ticket({ id: 'a1', status: 'ACTIVE' }),
      ticket({ id: 'a2', status: 'ACTIVE' }),
      ticket({ id: 'a3', status: 'ACTIVE' }),
    ]);
    expect(groups[0].summary).toBe('1 refunded · 3 active');
    expect(groups[0].counts.refunded).toBe(1);
    expect(groups[0].statusTone).toBe('success'); // still has active tickets
  });

  it('sorts movie seats naturally and summarizes seat labels', () => {
    const groups = groupWalletTickets([
      ticket({ id: 's3', experienceType: 'MOVIE', seatLabel: 'A10', screenName: 'Screen 2' }),
      ticket({ id: 's1', experienceType: 'MOVIE', seatLabel: 'A2', screenName: 'Screen 2' }),
      ticket({ id: 's2', experienceType: 'MOVIE', seatLabel: 'A1', screenName: 'Screen 2' }),
      ticket({ id: 's4', experienceType: 'MOVIE', seatLabel: 'B1', screenName: 'Screen 2' }),
    ]);
    expect(groups[0].isMovie).toBe(true);
    expect(groups[0].seatLabels).toEqual(['A1', 'A2', 'A10', 'B1']);
    expect(groups[0].screenName).toBe('Screen 2');
  });

  it('does not merge tickets from different bookings even when everything else matches', () => {
    const groups = groupWalletTickets([
      ticket({ id: 'x', bookingId: 'bk_1', ticketType: 'VIP', seatLabel: null }),
      ticket({ id: 'y', bookingId: 'bk_2', ticketType: 'VIP', seatLabel: null }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('falls back to per-ticket groups when bookingId is absent (older payload)', () => {
    const groups = groupWalletTickets([
      ticket({ id: 't1', bookingId: undefined }),
      ticket({ id: 't2', bookingId: undefined }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].bookingRef).toBe('T1'); // derived from the ticket id
  });
});

describe('summarizeBookingGroup', () => {
  it('reports all-checked-in', () => {
    expect(summarizeBookingGroup(counts({ total: 8, checkedIn: 8 }))).toEqual({
      summary: 'All checked in',
      tone: 'info',
    });
  });

  it('reports a fully cancelled booking', () => {
    expect(summarizeBookingGroup(counts({ total: 3, cancelled: 3 }))).toEqual({
      summary: 'Booking cancelled',
      tone: 'error',
    });
  });

  it('reports a plain active booking', () => {
    expect(summarizeBookingGroup(counts({ total: 8, active: 8 })).summary).toBe('8 active');
  });
});

describe('countByStatus', () => {
  it('buckets VOID as cancelled and unknown states as other', () => {
    const c = countByStatus([
      ticket({ id: '1', status: 'VOID' }),
      ticket({ id: '2', status: 'TRANSFERRED' }),
    ]);
    expect(c.cancelled).toBe(1);
    expect(c.other).toBe(1);
  });
});

describe('compareSeatLabels', () => {
  it('orders numerically within a row and by row across rows', () => {
    const sorted = ['B1', 'A10', 'A2', 'A1'].sort(compareSeatLabels);
    expect(sorted).toEqual(['A1', 'A2', 'A10', 'B1']);
  });
});

describe('pickInitialTicketIndex', () => {
  it('prefers the first ACTIVE ticket', () => {
    const idx = pickInitialTicketIndex([
      ticket({ id: '1', status: 'CHECKED_IN' }),
      ticket({ id: '2', status: 'ACTIVE' }),
      ticket({ id: '3', status: 'ACTIVE' }),
    ]);
    expect(idx).toBe(1);
  });

  it('falls back to first not-checked-in when no ACTIVE exists', () => {
    const idx = pickInitialTicketIndex([
      ticket({ id: '1', status: 'CHECKED_IN' }),
      ticket({ id: '2', status: 'REFUNDED' }),
    ]);
    expect(idx).toBe(1);
  });

  it('falls back to the first ticket when all are checked in', () => {
    const idx = pickInitialTicketIndex([
      ticket({ id: '1', status: 'CHECKED_IN' }),
      ticket({ id: '2', status: 'CHECKED_IN' }),
    ]);
    expect(idx).toBe(0);
  });
});

describe('isTicketInactive', () => {
  it('marks checked-in, refunded, cancelled and void as inactive', () => {
    expect(['CHECKED_IN', 'REFUNDED', 'CANCELLED', 'VOID'].every(isTicketInactive)).toBe(true);
    expect(isTicketInactive('ACTIVE')).toBe(false);
  });
});
