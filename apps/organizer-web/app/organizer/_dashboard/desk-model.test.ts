import { describe, expect, it } from 'vitest';
import type { PayoutSummary } from '@eticketsgo/web-kit';
import type { EventListRow } from '@/components/events/event-list-model';
import {
  comingUpRows,
  comingUpTotal,
  isTodayAtVenue,
  moneyFigures,
  needsContext,
  nextStepWhenClear,
  pickNextStep,
  soldShare,
  venueWhen,
} from './desk-model';
import type { MoneyPanel } from './overview-model';

const NOW = new Date('2026-10-12T08:00:00Z');
const inDays = (d: number) => new Date(NOW.getTime() + d * 864e5).toISOString();

const ev = (
  id: string,
  status: string,
  next: string | null,
  over: Partial<EventListRow> = {},
): EventListRow =>
  ({
    id,
    title: `Event ${id}`,
    slug: id,
    category: 'Music',
    status,
    createdAt: inDays(-10),
    venue: { name: 'Hall', city: 'Bengaluru', country: 'IN', timezone: 'Asia/Kolkata' },
    _count: { sessions: 1, bookings: 0 },
    schedule: {
      firstStartsAt: next,
      lastStartsAt: next,
      nextStartsAt: next,
      upcomingSessions: next ? 1 : 0,
    },
    ...over,
  }) as EventListRow;

const panel = (currency: string, grossMinor: number, payout: MoneyPanel['payout']): MoneyPanel => ({
  currency,
  sales: {
    grossMinor,
    organizerFeesMinor: 0,
    refundsMinor: 0,
    proceedsMinor: grossMinor,
    buyerFeesMinor: 0,
  },
  payout,
});

describe('comingUpRows', () => {
  it('lists events on sale soonest first, however far ahead, then drafts', () => {
    const rows = comingUpRows(
      [
        ev('late', 'PUBLISHED', inDays(60)),
        ev('draft', 'DRAFT', inDays(5)),
        ev('soon', 'PUBLISHED', inDays(2)),
        ev('over', 'PUBLISHED', inDays(-1)),
        ev('gone', 'CANCELLED', inDays(3)),
      ],
      NOW,
    );
    expect(rows.map((r) => [r.event.id, r.kind])).toEqual([
      ['soon', 'on-sale'],
      ['late', 'on-sale'],
      ['draft', 'not-yet'],
    ]);
  });

  it('never lets drafts crowd out events on sale, and caps drafts', () => {
    const onSale = Array.from({ length: 7 }, (_, i) => ev(`p${i}`, 'PUBLISHED', inDays(i + 1)));
    const drafts = Array.from({ length: 4 }, (_, i) => ev(`d${i}`, 'DRAFT', null));
    expect(comingUpRows([...drafts, ...onSale], NOW).every((r) => r.kind === 'on-sale')).toBe(true);
    expect(comingUpRows(drafts, NOW).length).toBe(2);
    expect(comingUpTotal([...drafts, ...onSale], NOW)).toBe(11);
  });
});

describe('venueWhen', () => {
  it('says the time at the venue, with its zone', () => {
    expect(venueWhen('2026-11-21T13:00:00Z', 'Asia/Kolkata')).toBe('Sat 21 Nov, 6:30 PM IST');
    expect(venueWhen('2026-11-21T00:30:00Z', 'America/New_York')).toBe('Fri 20 Nov, 7:30 PM EST');
  });

  it('decides "today" at the venue, not in the browser', () => {
    // 23:00 in New York on the 11th is already the 12th in UTC.
    const ny = new Date('2026-10-12T03:00:00Z');
    expect(isTodayAtVenue('2026-10-12T02:30:00Z', 'America/New_York', ny)).toBe(true);
    expect(isTodayAtVenue('2026-10-12T05:00:00Z', 'America/New_York', ny)).toBe(false);
  });
});

describe('soldShare', () => {
  it('is a bounded percentage and never divides by zero', () => {
    expect(soldShare(44, 1660)).toBe(3);
    expect(soldShare(5, 0)).toBe(0);
    expect(soldShare(12, 10)).toBe(100);
  });
});

describe('moneyFigures', () => {
  it('shows one currency per figure and names the others in their own unit, never summed', () => {
    const f = moneyFigures(
      [
        panel('INR', 6075600, {
          heldMinor: 6075600,
          payableMinor: 0,
          inPayoutMinor: 0,
          paidMinor: 0,
        }),
        panel('USD', 12000, null),
      ],
      {
        heldRevenue: [
          {
            eventId: 'a',
            eventTitle: 'A',
            currency: 'INR',
            grossMinor: 1,
            payableFrom: '2026-12-05T12:00:00Z',
          },
          {
            eventId: 'b',
            eventTitle: 'B',
            currency: 'INR',
            grossMinor: 1,
            payableFrom: '2026-11-28T12:00:00Z',
          },
          {
            eventId: 'c',
            eventTitle: 'C',
            currency: 'USD',
            grossMinor: 1,
            payableFrom: '2026-10-20T12:00:00Z',
          },
        ],
      } as PayoutSummary,
    )!;
    expect(f.currency).toBe('INR');
    expect(f.gross.value).toMatch(/60,756/);
    expect(f.gross.context).toMatch(/^In INR\. Also \$120\.00 in USD\.$/);
    expect(f.payable!.value).toMatch(/0/);
    // The earliest release IN THIS CURRENCY, not the USD one.
    expect(f.payable!.context).toMatch(/held, first release 28 Nov$/);
  });

  it('never says "nothing waiting" beside money that is payable now', () => {
    const f = moneyFigures(
      [panel('INR', 99800, { heldMinor: 0, payableMinor: 99800, inPayoutMinor: 0, paidMinor: 0 })],
      { heldRevenue: [] } as unknown as PayoutSummary,
    )!;
    expect(f.payable!.value).toMatch(/998/);
    expect(f.payable!.context).toBe('Ready for your next payout');
  });

  it('has no payable figure without the ledger, and nothing at all without a panel', () => {
    expect(moneyFigures([panel('INR', 0, null)], undefined)!.payable).toBeNull();
    expect(moneyFigures([], undefined)).toBeNull();
  });
});

describe('nextStepWhenClear', () => {
  it('starts a new organizer with a first event, and only one who may create', () => {
    expect(nextStepWhenClear({ events: [], rows: [], canCreate: true })!.href).toBe(
      '/organizer/events/new',
    );
    expect(nextStepWhenClear({ events: [], rows: [], canCreate: false })).toBeNull();
  });

  it('prefers a draft to finish over the next event on sale', () => {
    const events = [ev('p', 'PUBLISHED', inDays(3)), ev('d', 'DRAFT', null)];
    const rows = comingUpRows(events, NOW);
    expect(nextStepWhenClear({ events, rows, canCreate: true })!.href).toBe('/organizer/events/d');
    const onSale = [events[0]];
    expect(
      nextStepWhenClear({ events: onSale, rows: comingUpRows(onSale, NOW), canCreate: true })!.href,
    ).toBe('/organizer/events/p/orders');
  });
});

describe('needsContext', () => {
  it('says what kind of items they are', () => {
    expect(needsContext({ items: [], blocking: 0, warnings: 0, suggestions: 0 })).toBe('All clear');
    const item = {
      key: 'k',
      severity: 'blocking' as const,
      title: 't',
      detail: '',
      href: '/',
      actionLabel: 'Fix',
      source: 'setup' as const,
    };
    expect(needsContext({ items: [item], blocking: 1, warnings: 0, suggestions: 0 })).toBe(
      '1 blocks sales or payouts',
    );
  });
});

describe('pickNextStep', () => {
  const bank = {
    key: 'setup:bank',
    severity: 'blocking' as const,
    title: 'Add the bank account',
    detail: '',
    href: '/organizer/settings',
    actionLabel: 'Fix this',
    source: 'setup' as const,
  };
  const needs = { items: [bank], blocking: 1, warnings: 0, suggestions: 0 };

  it('is the costliest open item once there are events, and says which item it is', () => {
    const events = [ev('p', 'PUBLISHED', inDays(3))];
    const next = pickNextStep({ needs, events, rows: comingUpRows(events, NOW), canCreate: true })!;
    expect(next.itemKey).toBe('setup:bank');
    expect(next.blocking).toBe(true);
  });

  it('starts an organization with no events on its first event, paperwork listed after', () => {
    const next = pickNextStep({ needs, events: [], rows: [], canCreate: true })!;
    expect(next.itemKey).toBeNull();
    expect(next.step.href).toBe('/organizer/events/new');
    // A member who cannot create events is still shown the open item.
    expect(pickNextStep({ needs, events: [], rows: [], canCreate: false })!.itemKey).toBe(
      'setup:bank',
    );
  });
});
