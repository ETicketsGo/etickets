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
  pendingActions,
  performanceFor,
  pickCurrency,
  recentActivity,
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
