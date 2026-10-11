import { describe, expect, it } from 'vitest';
import type {
  NotificationFeedGroup,
  OrganizerAction,
  OrganizerAnalytics,
  OrganizerCalendarSession,
  PayoutSummary,
} from '@eticketsgo/web-kit';
import {
  KPI_DEFINITIONS,
  latestDraft,
  moneyPanels,
  needsAction,
  notYetOnSale,
  upcomingMode,
  upcomingPublishedCount,
  upcomingPublishedShows,
} from './overview-model';

const NOW = new Date('2026-10-11T08:00:00Z');
const inDays = (d: number) => new Date(NOW.getTime() + d * 864e5).toISOString();

const show = (id: string, status: string, startsAt: string): OrganizerCalendarSession => ({
  id: `s-${id}`,
  startsAt,
  endsAt: startsAt,
  status: 'SCHEDULED',
  event: { id, title: id, category: 'Music', status, experienceType: 'EVENT' },
  venue: { id: 'v', name: 'V', city: 'C', country: 'IN', timezone: 'Asia/Kolkata' },
  cinemaTimezone: null,
  sold: 0,
  capacity: 10,
});

const ev = (
  id: string,
  status: string,
  over: { createdAt?: string; upcoming?: number; last?: string | null } = {},
) => ({
  id,
  title: id,
  status,
  createdAt: over.createdAt ?? '2026-10-01T00:00:00Z',
  schedule: {
    firstStartsAt: null,
    lastStartsAt: over.last === undefined ? inDays(20) : over.last,
    upcomingSessions: over.upcoming ?? 1,
  },
});

describe('upcoming events are published events; drafts are a separate group', () => {
  it('leaves a draft and an in-review event out of the upcoming shows', () => {
    const shows = upcomingPublishedShows(
      [
        show('draft', 'DRAFT', inDays(1)),
        show('review', 'UNDER_REVIEW', inDays(2)),
        show('live', 'PUBLISHED', inDays(3)),
        show('paused', 'PAUSED', inDays(4)),
        show('sold', 'SOLD_OUT', inDays(5)),
      ],
      NOW,
    );
    expect(shows.map((s) => s.event.id)).toEqual(['live', 'paused', 'sold']);
  });

  it('counts only published events that still have a show to come', () => {
    expect(
      upcomingPublishedCount([
        ev('a', 'PUBLISHED'),
        ev('b', 'DRAFT'),
        ev('c', 'UNDER_REVIEW'),
        ev('d', 'PUBLISHED', { upcoming: 0 }),
        ev('e', 'CANCELLED'),
        ev('f', 'SOLD_OUT'),
      ]),
    ).toBe(2);
  });

  it('lists drafts and in-review events newest first, and drops ones whose dates have all passed', () => {
    const rows = notYetOnSale(
      [
        ev('old', 'DRAFT', { createdAt: '2026-09-01T00:00:00Z' }),
        ev('new', 'UNDER_REVIEW', { createdAt: '2026-10-09T00:00:00Z' }),
        ev('stale', 'DRAFT', { last: inDays(-3) }),
        ev('undated', 'DRAFT', { last: null, createdAt: '2026-10-05T00:00:00Z' }),
        ev('live', 'PUBLISHED'),
      ],
      NOW,
    );
    expect(rows.map((r) => r.id)).toEqual(['new', 'undated', 'old']);
  });

  it('offers the newest DRAFT to continue, never an in-review event', () => {
    expect(
      latestDraft(
        [
          ev('review', 'UNDER_REVIEW', { createdAt: '2026-10-10T00:00:00Z' }),
          ev('d1', 'DRAFT', { createdAt: '2026-10-02T00:00:00Z' }),
          ev('d2', 'DRAFT', { createdAt: '2026-10-04T00:00:00Z' }),
        ],
        NOW,
      )?.id,
    ).toBe('d2');
    expect(latestDraft([ev('r', 'UNDER_REVIEW')], NOW)).toBeNull();
  });
});

describe('the upcoming block adapts to what there is', () => {
  const art = (n: number, without = 0) =>
    Array.from({ length: n }, (_, i) => ({ hasImage: i >= without }));

  it('0 -> empty, 1 -> one featured card', () => {
    expect(upcomingMode([])).toBe('empty');
    expect(upcomingMode(art(1))).toBe('featured');
    // One event with no artwork is still featured: it is one card, not a repeated placeholder.
    expect(upcomingMode(art(1, 1))).toBe('featured');
  });

  it('2-3 with their own artwork -> image cards', () => {
    expect(upcomingMode(art(2))).toBe('cards');
    expect(upcomingMode(art(3))).toBe('cards');
  });

  it('2-3 where several lack artwork -> compact rows, so the same placeholder is not repeated', () => {
    expect(upcomingMode(art(2, 2))).toBe('rows');
    expect(upcomingMode(art(3, 2))).toBe('rows');
    // One placeholder among real pictures is fine.
    expect(upcomingMode(art(3, 1))).toBe('cards');
  });

  it('4 or more -> compact rows even with artwork', () => {
    expect(upcomingMode(art(4))).toBe('rows');
    expect(upcomingMode(art(9))).toBe('rows');
  });
});

describe('needs action is ranked by severity', () => {
  const action = (over: Partial<OrganizerAction>): OrganizerAction => ({
    key: 'k',
    category: 'BUSINESS',
    severity: 'SUGGESTED',
    scope: 'ORGANIZATION',
    organizationId: 'o',
    blocking: false,
    title: 'T',
    consequence: 'C',
    fixPath: '/fix',
    actionLabel: 'Fix this',
    done: false,
    ...over,
  });
  const group = (key: string, severity: NotificationFeedGroup['severity'], lastAt: string) =>
    ({
      key,
      category: 'ACTION_REQUIRED',
      severity,
      type: 't',
      title: `title ${key}`,
      summary: `summary ${key}`,
      ownerNote: null,
      action: { label: 'Open it', href: `/x/${key}` },
      lastAt,
      resolved: false,
    }) as unknown as NotificationFeedGroup;

  it('puts every blocker before every warning, from both sources', () => {
    const n = needsAction(
      [
        action({ key: 'profile', severity: 'IMPORTANT', title: 'Profile' }),
        action({ key: 'bank', severity: 'BLOCKING', blocking: true, title: 'Bank' }),
      ],
      [
        group('w', 'WARNING', '2026-10-10T00:00:00Z'),
        group('c', 'CRITICAL', '2026-10-09T00:00:00Z'),
      ],
    );
    expect(n.items.map((i) => [i.key, i.severity])).toEqual([
      ['setup:bank', 'blocking'],
      ['feed:c', 'blocking'],
      ['setup:profile', 'warning'],
      ['feed:w', 'warning'],
    ]);
    expect(n.blocking).toBe(2);
    expect(n.warnings).toBe(2);
  });

  it('orders notices of one severity newest first', () => {
    const n = needsAction(undefined, [
      group('old', 'CRITICAL', '2026-10-01T00:00:00Z'),
      group('new', 'CRITICAL', '2026-10-09T00:00:00Z'),
    ]);
    expect(n.items.map((i) => i.key)).toEqual(['feed:new', 'feed:old']);
  });

  it('counts suggestions and optional steps without listing them', () => {
    const n = needsAction(
      [
        action({ key: 'photo', severity: 'SUGGESTED' }),
        action({ key: 'extra', severity: 'IMPORTANT', optional: true }),
        action({ key: 'done', severity: 'BLOCKING', blocking: true, done: true }),
      ],
      [],
    );
    expect(n.items).toEqual([]);
    expect(n.suggestions).toBe(2);
  });

  it('is empty when nothing is open', () => {
    const n = needsAction([], []);
    expect(n).toEqual({ items: [], blocking: 0, warnings: 0, suggestions: 0 });
  });
});

describe('every KPI has a one-line definition', () => {
  it('says what Tickets sold and Upcoming events count, and that drafts are not upcoming', () => {
    expect(KPI_DEFINITIONS.tickets).toMatch(/active or checked in/);
    expect(KPI_DEFINITIONS.upcoming).toMatch(/Published/);
    expect(KPI_DEFINITIONS.upcoming).toMatch(/Drafts are not counted/);
    for (const text of Object.values(KPI_DEFINITIONS)) {
      expect(text.length).toBeGreaterThan(10);
      // ASCII only, one sentence-ish line.
      expect(/^[\x20-\x7e]+$/.test(text)).toBe(true);
    }
  });
});

describe('the money panel keeps sold and ledger apart and never mixes currencies', () => {
  const analytics = {
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
      {
        currency: 'CAD',
        grossMinor: 0,
        bookingFeesMinor: 0,
        paymentFeesMinor: 0,
        organizerFeesMinor: 0,
        discountMinor: 0,
        netMinor: 0,
        confirmedBookings: 0,
      },
    ],
    refunds: [{ currency: 'INR', count: 1, amountMinor: 5_000, refundRate: 5 }],
  } as unknown as OrganizerAnalytics;

  const ledger = {
    currencies: [
      {
        currency: 'INR',
        gross: 70_000,
        discount: 0,
        bookingFee: 0,
        paymentFee: 0,
        organizerFee: 0,
        refund: 0,
        net: 11_111,
        paid: 22_222,
        pending: 33_333,
        held: 44_444,
      },
    ],
    heldRevenue: [],
    excluded: { providerSettledEvents: 0 },
  } as unknown as PayoutSummary;

  it('draws one panel per currency that has money, the home market first, and none for an empty one', () => {
    const panels = moneyPanels(analytics, ledger, 'INR', ['INR', 'USD', 'CAD']);
    expect(panels.map((p) => p.currency)).toEqual(['INR', 'USD']);
    const usdFirst = moneyPanels(analytics, ledger, 'USD', ['INR', 'USD', 'CAD']);
    expect(usdFirst.map((p) => p.currency)).toEqual(['USD', 'INR']);
  });

  it('maps held, payable, in a payout and paid from their own ledger fields, never conflated', () => {
    const inr = moneyPanels(analytics, ledger, 'INR', ['INR'])[0];
    expect(inr.payout).toEqual({
      heldMinor: 44_444,
      payableMinor: 11_111,
      inPayoutMinor: 33_333,
      paidMinor: 22_222,
    });
    // Proceeds are the analytics net, and are not any of the ledger stages.
    expect(inr.sales).toEqual({
      grossMinor: 100_000,
      organizerFeesMinor: 2_000,
      refundsMinor: 5_000,
      proceedsMinor: 93_000,
      buyerFeesMinor: 3_000,
    });
    const stages = Object.values(inr.payout!);
    expect(stages).not.toContain(inr.sales.proceedsMinor);
    expect(stages).not.toContain(inr.sales.grossMinor);
  });

  it("never carries one currency's figures into another's panel", () => {
    const usd = moneyPanels(analytics, ledger, 'INR', ['INR', 'USD']).find(
      (p) => p.currency === 'USD',
    )!;
    expect(usd.sales.grossMinor).toBe(5_000);
    expect(usd.sales.refundsMinor).toBe(0);
    // The ledger has nothing in USD: zeros, not INR's numbers.
    expect(usd.payout).toEqual({ heldMinor: 0, payableMinor: 0, inPayoutMinor: 0, paidMinor: 0 });
  });

  it('has no ledger half when the ledger was not read (a role without financial access)', () => {
    const panels = moneyPanels(analytics, undefined, 'INR', ['INR']);
    expect(panels[0].payout).toBeNull();
  });

  it('shows the home market empty when nothing has sold anywhere', () => {
    const none = { revenue: [], refunds: [] } as unknown as OrganizerAnalytics;
    const panels = moneyPanels(none, undefined, 'INR', ['USD', 'INR']);
    expect(panels).toHaveLength(1);
    expect(panels[0].currency).toBe('INR');
    expect(panels[0].sales.grossMinor).toBe(0);
  });
});
