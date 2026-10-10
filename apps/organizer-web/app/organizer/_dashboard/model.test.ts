import { describe, expect, it } from 'vitest';
import type {
  NotificationFeed,
  NotificationFeedGroup,
  OrganizerAnalytics,
  OrganizerCalendarSession,
} from '@eticketsgo/web-kit';
import {
  comingUp,
  comingUpWindow,
  moneyFor,
  nextShowByEvent,
  startingWithin,
  pendingActions,
  performanceFor,
  pickCurrency,
  recentActivity,
  eventsStartingWithin,
  homeWindow,
  showsOnDay,
  showsPerDay,
  showsToday,
  upcomingEventCount,
  upcomingEventShows,
  viewerToday,
} from './model';

const analytics = {
  organizationId: 'o1',
  attendance: { issued: 10, checkedIn: 2, checkInRate: 20 },
  conversion: { total: 12, confirmed: 10, rate: 83 },
  repeatVisitors: { totalCustomers: 5, repeatCustomers: 1, rate: 20 },
  topTicketType: null,
  capacity: { sold: 10, capacity: 100, utilization: 10 },
  revenue: [
    {
      currency: 'INR',
      grossMinor: 100_000,
      bookingFeesMinor: 3_000,
      paymentFeesMinor: 0,
      organizerFeesMinor: 2_000,
      discountMinor: 0,
      netMinor: 93_000,
      confirmedBookings: 9,
    },
    {
      currency: 'USD',
      grossMinor: 5_000,
      bookingFeesMinor: 100,
      paymentFeesMinor: 0,
      organizerFeesMinor: 0,
      discountMinor: 0,
      netMinor: 5_000,
      confirmedBookings: 1,
    },
  ],
  refunds: [{ currency: 'INR', count: 1, amountMinor: 5_000, refundRate: 5 }],
  topEvents: [
    { eventId: 'a', title: 'A', currency: 'INR', grossMinor: 60_000, bookings: 6 },
    { eventId: 'u', title: 'U', currency: 'USD', grossMinor: 5_000, bookings: 1 },
    { eventId: 'b', title: 'B', currency: 'INR', grossMinor: 30_000, bookings: 3 },
  ],
} as OrganizerAnalytics;

describe('the market the dashboard opens on', () => {
  const choices = [
    { currency: 'USD', label: 'United States · USD' },
    { currency: 'INR', label: 'India · INR' },
  ];
  it('is the home market, not whichever came back first', () => {
    expect(pickCurrency(choices, 'INR', null)).toBe('INR');
  });
  it('is the one the organizer picked, once they pick', () => {
    expect(pickCurrency(choices, 'INR', 'USD')).toBe('USD');
  });
  it('falls back to the first market when home has none', () => {
    expect(pickCurrency(choices, 'CAD', null)).toBe('USD');
    expect(pickCurrency([], 'INR', null)).toBeNull();
  });
});

describe('money for one market', () => {
  it('takes every figure from that currency only, never a sum across', () => {
    const inr = moneyFor(analytics, 'INR');
    expect(inr).toMatchObject({
      grossMinor: 100_000,
      organizerFeesMinor: 2_000,
      refundsMinor: 5_000,
      netMinor: 93_000,
      bookingFeesMinor: 3_000,
    });
    // The USD booking must not leak into rupees.
    expect(inr.grossMinor).not.toBe(105_000);
  });

  it('shows the breakdown the API computed: gross less fees less refunds is net', () => {
    const inr = moneyFor(analytics, 'INR');
    expect(inr.grossMinor - inr.organizerFeesMinor - inr.refundsMinor).toBe(inr.netMinor);
  });

  it('is zero, not borrowed, for a market with no refunds row', () => {
    expect(moneyFor(analytics, 'USD').refundsMinor).toBe(0);
  });
});

describe('event performance', () => {
  it('ranks within the selected currency and scales bars to the best event', () => {
    const rows = performanceFor(analytics, 'INR');
    expect(rows.map((r) => r.eventId)).toEqual(['a', 'b']);
    expect(rows.map((r) => r.relative)).toEqual([100, 50]);
  });
  it('is empty for a market with no sales', () => {
    expect(performanceFor(analytics, 'CAD')).toEqual([]);
  });
});

function group(over: Partial<NotificationFeedGroup>): NotificationFeedGroup {
  return {
    key: 'k',
    category: 'BOOKINGS_AND_SALES',
    severity: 'INFO',
    type: 't',
    title: 't',
    summary: '',
    detail: null,
    ownerNote: null,
    action: null,
    eventId: null,
    notificationIds: [],
    unreadIds: [],
    read: false,
    firstAt: '2026-10-01T00:00:00Z',
    lastAt: '2026-10-01T00:00:00Z',
    sessions: [],
    affectedSessions: 0,
    resolved: null,
    dismissible: true,
    ...over,
  };
}

const feed: NotificationFeed = {
  unreadCount: 0,
  scanned: 4,
  truncated: false,
  sections: [
    {
      category: 'ACTION_REQUIRED',
      label: 'Action required',
      groups: [
        group({ key: 'fixed', category: 'ACTION_REQUIRED', resolved: true }),
        group({ key: 'open-old', category: 'ACTION_REQUIRED', lastAt: '2026-10-02T00:00:00Z' }),
        group({ key: 'open-new', category: 'ACTION_REQUIRED', lastAt: '2026-10-05T00:00:00Z' }),
      ],
    },
    {
      category: 'BOOKINGS_AND_SALES',
      label: 'Bookings',
      groups: [
        group({ key: 'sale-1', lastAt: '2026-10-03T00:00:00Z' }),
        group({ key: 'sale-2', lastAt: '2026-10-06T00:00:00Z' }),
      ],
    },
  ],
};

describe('pending actions and recent activity', () => {
  it('lists only problems still open, newest first', () => {
    expect(pendingActions(feed).map((g) => g.key)).toEqual(['open-new', 'open-old']);
  });
  it('lists activity from the other sections, so nothing appears twice on the page', () => {
    expect(recentActivity(feed).map((g) => g.key)).toEqual(['sale-2', 'sale-1']);
  });
  it('copes with no feed at all', () => {
    expect(pendingActions(undefined)).toEqual([]);
    expect(recentActivity(undefined)).toEqual([]);
  });
});

function show(id: string, startsAt: string, over: Partial<OrganizerCalendarSession> = {}) {
  return {
    id,
    startsAt,
    endsAt: startsAt,
    status: 'SCHEDULED',
    event: { id: 'e', title: id, category: 'MUSIC', status: 'PUBLISHED', experienceType: 'EVENT' },
    venue: { id: 'v', name: 'V', city: 'C', country: 'IN', timezone: 'Asia/Kolkata' },
    cinemaTimezone: null,
    sold: 1,
    capacity: 10,
    ...over,
  } as OrganizerCalendarSession;
}

describe('coming up', () => {
  const now = new Date('2026-10-09T12:00:00Z');
  it('looks a week ahead from now', () => {
    expect(comingUpWindow(now)).toEqual({
      from: '2026-10-09T12:00:00.000Z',
      to: '2026-10-16T12:00:00.000Z',
    });
  });
  it('lists the soonest live shows, and nothing that has started or will not happen', () => {
    const rows = [
      show('later', '2026-10-12T10:00:00Z'),
      show('started', '2026-10-09T11:00:00Z'),
      show('soon', '2026-10-10T10:00:00Z'),
      show('cancelled-show', '2026-10-10T11:00:00Z', { status: 'CANCELLED' }),
      show('cancelled-event', '2026-10-10T12:00:00Z', {
        event: { id: 'x', title: 'x', category: 'M', status: 'CANCELLED', experienceType: 'EVENT' },
      }),
    ];
    expect(comingUp(rows, now).map((s) => s.id)).toEqual(['soon', 'later']);
  });
});

describe('the next show per event', () => {
  const at = (id: string, eventId: string, startsAt: string, status = 'SCHEDULED') =>
    ({
      id,
      startsAt,
      endsAt: startsAt,
      status,
      event: {
        id: eventId,
        title: eventId,
        category: 'MUSIC',
        status: 'PUBLISHED',
        experienceType: 'EVENT',
      },
      venue: { id: 'v', name: 'V', city: 'C', country: 'IN', timezone: 'Asia/Kolkata' },
      cinemaTimezone: null,
      sold: 0,
      capacity: 10,
    }) as OrganizerCalendarSession;
  const now = new Date('2026-10-10T00:00:00Z');

  it('is the earliest show still to come, skipping cancelled and started ones', () => {
    const next = nextShowByEvent(
      [
        at('late', 'e1', '2026-10-20T10:00:00Z'),
        at('gone', 'e1', '2026-10-09T10:00:00Z'),
        at('off', 'e1', '2026-10-11T10:00:00Z', 'CANCELLED'),
        at('soon', 'e1', '2026-10-12T10:00:00Z'),
        at('other', 'e2', '2026-10-15T10:00:00Z'),
      ],
      now,
    );
    expect(next.get('e1')?.id).toBe('soon');
    expect(next.get('e2')?.id).toBe('other');
  });

  it('keeps the week out of a longer window', () => {
    const rows = [at('a', 'e1', '2026-10-12T10:00:00Z'), at('b', 'e1', '2026-10-30T10:00:00Z')];
    expect(startingWithin(rows, 7, now).map((s) => s.id)).toEqual(['a']);
  });
});

describe('the premium Overview', () => {
  const ev = (id: string, status = 'PUBLISHED') => ({
    id,
    title: id,
    category: 'MUSIC',
    status,
    experienceType: 'EVENT',
  });
  // 10 Oct 2026, 12:00 UTC = 17:30 in Kolkata; 06:00 in Boise (America/Boise, MDT).
  const now = new Date('2026-10-10T12:00:00Z');

  it('reads this month and the next four weeks, inside the API 62-day ceiling', () => {
    for (const today of ['2026-10-01', '2026-10-10', '2026-10-31', '2026-02-28', '2026-12-31']) {
      const w = homeWindow(today);
      const days = (Date.parse(w.to) - Date.parse(w.from)) / 86_400_000;
      expect(days).toBeLessThanOrEqual(62);
      expect(w.from <= `${today.slice(0, 8)}01T00:00:00.000Z`).toBe(true);
      // Four weeks ahead are always covered, so "Upcoming events" never goes blank on the 30th.
      expect(Date.parse(w.to)).toBeGreaterThanOrEqual(
        Date.parse(`${today}T00:00:00Z`) + 27 * 86_400_000,
      );
    }
  });

  it("names today in the viewer's zone, not UTC", () => {
    const late = new Date('2026-10-10T20:00:00Z');
    expect(viewerToday(late, 'UTC')).toBe('2026-10-10');
    expect(viewerToday(late, 'Asia/Kolkata')).toBe('2026-10-11');
  });

  it('puts a show on the date AT ITS VENUE, and never counts a cancelled one', () => {
    const rows = [
      // 23:30 in Kolkata on the 10th is 18:00 UTC: still the 10th at the venue.
      show('late-kolkata', '2026-10-10T18:00:00Z'),
      show('next-day', '2026-10-10T19:00:00Z'),
      show('off', '2026-10-10T14:00:00Z', { status: 'CANCELLED' }),
    ];
    const perDay = showsPerDay(rows);
    expect(perDay.get('2026-10-10')).toBe(1);
    expect(perDay.get('2026-10-11')).toBe(1);
    expect(showsOnDay(rows, '2026-10-11').map((s) => s.id)).toEqual(['next-day']);
  });

  it('lists today the shows still to start, each judged by the date at its own venue', () => {
    const rows = [
      show('evening', '2026-10-10T14:00:00Z'),
      show('started', '2026-10-10T11:00:00Z'),
      show('tomorrow-in-kolkata', '2026-10-10T19:00:00Z'),
      // 18:00 in Boise on the 10th: tomorrow in Kolkata and in UTC, but today at the venue.
      show('boise', '2026-10-11T00:00:00Z', {
        venue: { id: 'b', name: 'B', city: 'Boise', country: 'US', timezone: 'America/Boise' },
      }),
    ];
    expect(showsToday(rows, now).map((s) => s.id)).toEqual(['evening', 'boise']);
  });

  it('shows one card per event: its next show still to start, soonest first', () => {
    const rows = [
      show('a-2', '2026-10-12T10:00:00Z', { event: ev('a') }),
      show('b-1', '2026-10-11T10:00:00Z', { event: ev('b') }),
      show('a-1', '2026-10-10T13:00:00Z', { event: ev('a') }),
      show('c-running', '2026-10-10T11:00:00Z', { event: ev('c') }),
      show('d-1', '2026-10-13T10:00:00Z', { event: ev('d') }),
    ];
    expect(upcomingEventShows(rows, now, 3).map((s) => s.id)).toEqual(['a-1', 'b-1', 'd-1']);
    expect(eventsStartingWithin(rows, 7, now)).toBe(3);
    expect(eventsStartingWithin(rows, 1, now)).toBe(2);
  });

  it('counts upcoming events from the event list, however far ahead, never a cancelled one', () => {
    expect(
      upcomingEventCount([
        { status: 'PUBLISHED', schedule: { upcomingSessions: 2 } },
        { status: 'DRAFT', schedule: { upcomingSessions: 1 } },
        { status: 'CANCELLED', schedule: { upcomingSessions: 3 } },
        { status: 'PUBLISHED', schedule: { upcomingSessions: 0 } },
        { status: 'PUBLISHED' },
      ]),
    ).toBe(2);
  });
});
