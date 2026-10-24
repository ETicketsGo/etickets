import { groupSavedTickets } from '../offline-wallet';
import type { CachedTicket } from '@/services/ticket-cache';

jest.mock('@react-native-async-storage/async-storage', () =>
  // jest.mock factories run before imports, so the library mock is required here.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));

const ticket = (over: Partial<CachedTicket>): CachedTicket =>
  ({
    id: 't',
    serial: 'TKT-1',
    status: 'ACTIVE',
    holderName: null,
    ticketType: 'Standard',
    event: { title: 'Show', slug: 'show' },
    startsAt: '2026-11-15T05:00:00.000Z',
    qrDataUrl: 'data:image/png;base64,x',
    bookingId: 'b1',
    bookingRef: 'ETG-IND-2026-000070',
    experienceType: 'EVENT',
    seatLabel: null,
    venueName: null,
    screenName: null,
    cinemaName: null,
    assignmentStatus: 'ASSIGNED',
    attendeeName: null,
    ownedByViewer: true,
    assignedToViewer: true,
    ...over,
  }) as CachedTicket;

describe('groupSavedTickets', () => {
  it('makes one entry per booking, counting its tickets, soonest first', () => {
    const groups = groupSavedTickets([
      ticket({ id: 'a', bookingId: 'late', startsAt: '2026-12-01T00:00:00.000Z' }),
      ticket({ id: 'b', bookingId: 'soon', startsAt: '2026-11-01T00:00:00.000Z' }),
      ticket({ id: 'c', bookingId: 'late', startsAt: '2026-12-01T00:00:00.000Z' }),
    ]);
    expect(groups.map((g) => [g.bookingId, g.count])).toEqual([
      ['soon', 1],
      ['late', 2],
    ]);
  });
});
