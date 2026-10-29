import { describe, expect, it } from 'vitest';
import type { DiscrepancyRow } from '@eticketsgo/web-kit';
import {
  ageWords,
  auditActionWords,
  countByType,
  describeGrant,
  exposureByCurrency,
  oldest,
  priceSpans,
  rejectionReasonError,
  riskSignals,
  type Preset,
} from './proposal-model';

const NOW = new Date('2026-10-13T12:00:00Z');

function row(p: Partial<DiscrepancyRow>): DiscrepancyRow {
  return {
    id: Math.random().toString(36),
    env: 'TEST' as DiscrepancyRow['env'],
    type: 'AMOUNT_MISMATCH',
    provider: 'razorpay',
    entityRef: 'pay_1',
    amountMinor: 1000,
    currency: 'INR',
    detail: null,
    status: 'OPEN',
    assignedToUserId: null,
    resolutionNotes: null,
    createdAt: '2026-10-10T00:00:00Z',
    ...p,
  };
}

describe('ageWords', () => {
  it('says hours under two days and days after', () => {
    expect(ageWords('2026-10-13T11:30:00Z', NOW)).toBe('under an hour');
    expect(ageWords('2026-10-13T11:00:00Z', NOW)).toBe('1 hour');
    expect(ageWords('2026-10-12T00:00:00Z', NOW)).toBe('36 hours');
    expect(ageWords('2026-10-01T12:00:00Z', NOW)).toBe('12 days');
  });
  it('never prints a negative age', () => {
    expect(ageWords('2026-10-14T00:00:00Z', NOW)).toBe('just now');
  });
});

describe('oldest', () => {
  it('ignores empties and returns null for none', () => {
    expect(oldest([null, '2026-10-02T00:00:00Z', '2026-10-01T00:00:00Z'])).toBe(
      '2026-10-01T00:00:00Z',
    );
    expect(oldest([])).toBeNull();
  });
});

describe('exposureByCurrency', () => {
  it('never adds two currencies together', () => {
    const g = exposureByCurrency([
      row({ currency: 'INR', amountMinor: 1000 }),
      row({ currency: 'inr', amountMinor: -500 }),
      row({ currency: 'USD', amountMinor: 700 }),
    ]);
    expect(g).toHaveLength(2);
    expect(g[0]).toMatchObject({ currency: 'INR', count: 2, amountMinor: 1500 });
    expect(g[1]).toMatchObject({ currency: 'USD', count: 1, amountMinor: 700 });
  });
  it('keeps rows without a currency apart, and counts rows without an amount', () => {
    const g = exposureByCurrency([
      row({ currency: null, amountMinor: 900 }),
      row({ currency: 'INR', amountMinor: null }),
    ]);
    expect(g.find((x) => x.currency === null)).toMatchObject({ count: 1, amountMinor: 900 });
    expect(g.find((x) => x.currency === 'INR')).toMatchObject({
      amountMinor: 0,
      rowsWithoutAmount: 1,
    });
  });
  it('leaves resolved and ignored rows out, and finds the oldest open one', () => {
    const g = exposureByCurrency([
      row({ status: 'RESOLVED', createdAt: '2026-01-01T00:00:00Z' }),
      row({ status: 'IGNORED' }),
      row({ status: 'ASSIGNED', createdAt: '2026-10-05T00:00:00Z' }),
      row({ createdAt: '2026-10-09T00:00:00Z' }),
    ]);
    expect(g).toEqual([expect.objectContaining({ count: 2, oldestAt: '2026-10-05T00:00:00Z' })]);
  });
});

describe('countByType', () => {
  it('counts unresolved rows by type, most first', () => {
    expect(
      countByType([
        row({ type: 'CHARGEBACK' }),
        row({ type: 'AMOUNT_MISMATCH' }),
        row({ type: 'AMOUNT_MISMATCH' }),
        row({ type: 'CHARGEBACK', status: 'RESOLVED' }),
      ]),
    ).toEqual([
      { type: 'AMOUNT_MISMATCH', count: 2 },
      { type: 'CHARGEBACK', count: 1 },
    ]);
  });
});

const session = (prices: [number, string][]) => ({
  id: 's',
  startsAt: '',
  endsAt: '',
  status: 'SCHEDULED',
  ticketTypes: prices.map(([priceMinor, currency], i) => ({
    id: `t${i}`,
    name: 'GA',
    priceMinor,
    currency,
    quantityTotal: 10,
    maxPerOrder: 4,
    salesStartAt: null,
    salesEndAt: null,
    status: 'ACTIVE',
  })),
});

describe('priceSpans', () => {
  it('gives a range per currency, never one range across currencies', () => {
    expect(
      priceSpans({
        sessions: [
          session([
            [50000, 'INR'],
            [15000, 'INR'],
          ]),
          session([[2000, 'USD']]),
        ],
      }),
    ).toEqual([
      { currency: 'INR', minMinor: 15000, maxMinor: 50000 },
      { currency: 'USD', minMinor: 2000, maxMinor: 2000 },
    ]);
  });
});

describe('riskSignals', () => {
  const detail = {
    sessions: [session([[50000, 'INR']])],
    imagePath: '/img.jpg',
    isFree: false,
    reviewNote: null,
    description: 'A show',
  };
  it('flags a first date in the past as critical', () => {
    const s = riskSignals({ firstSessionAt: '2026-09-17T10:00:00Z', sessionCount: 1 }, detail, NOW);
    expect(s.map((x) => x.key)).toEqual(['past']);
    expect(s[0].tone).toBe('critical');
  });
  it('flags an event with no session', () => {
    expect(riskSignals({ firstSessionAt: null, sessionCount: 0 }, null, NOW)[0].key).toBe(
      'no-session',
    );
  });
  it('says what the listing is missing', () => {
    const keys = riskSignals(
      { firstSessionAt: '2026-11-01T10:00:00Z', sessionCount: 1 },
      {
        ...detail,
        imagePath: null,
        description: '',
        reviewNote: 'fix the date',
        sessions: [session([[0, 'INR']])],
      },
      NOW,
    ).map((x) => x.key);
    expect(keys).toEqual(['zero-price', 'no-image', 'no-description', 'resubmitted']);
  });
  it('a clean future listing has no signals', () => {
    expect(
      riskSignals({ firstSessionAt: '2026-11-01T10:00:00Z', sessionCount: 1 }, detail, NOW),
    ).toEqual([]);
  });
});

describe('rejectionReasonError', () => {
  it('requires a reason the organizer can act on', () => {
    expect(rejectionReasonError('  ')).toMatch(/Write the reason/);
    expect(rejectionReasonError('bad')).toMatch(/Say a little more/);
    expect(rejectionReasonError('The first date is in the past.')).toBeNull();
  });
});

describe('describeGrant', () => {
  const presets: Preset[] = [
    {
      key: 'SUPPORT',
      label: 'Support',
      description: '',
      grants: ['BOOKING_READ', 'SUPPORT_MANAGE'],
    },
    {
      key: 'FINANCE',
      label: 'Finance',
      description: '',
      grants: ['BOOKING_READ', 'FINANCE_READ', 'PAYOUT_MANAGE'],
    },
  ];
  it('names a super admin, an empty grant and an exact preset', () => {
    expect(describeGrant({ isSuperAdmin: true, permissions: [] }, presets)).toEqual({
      kind: 'super',
    });
    expect(describeGrant({ isSuperAdmin: false, permissions: [] }, presets)).toEqual({
      kind: 'none',
    });
    expect(
      describeGrant(
        { isSuperAdmin: false, permissions: ['SUPPORT_MANAGE', 'BOOKING_READ'] },
        presets,
      ),
    ).toEqual({ kind: 'preset', label: 'Support' });
  });
  it('names the largest preset held plus the extras', () => {
    expect(
      describeGrant(
        {
          isSuperAdmin: false,
          permissions: ['BOOKING_READ', 'FINANCE_READ', 'PAYOUT_MANAGE', 'BANK_VERIFY'],
        },
        presets,
      ),
    ).toEqual({ kind: 'preset-plus', label: 'Finance', extra: ['BANK_VERIFY'] });
  });
  it('calls anything else custom', () => {
    expect(describeGrant({ isSuperAdmin: false, permissions: ['OPS_READ'] }, presets)).toEqual({
      kind: 'custom',
      count: 1,
    });
  });
});

describe('auditActionWords', () => {
  it('says known access actions in words and spells out others', () => {
    expect(auditActionWords('AUTH_TOKEN_REUSE_DETECTED')).toBe('Sign-in token used twice');
    expect(auditActionWords('EVENT_APPROVED')).toBe('Event approved');
  });
});
