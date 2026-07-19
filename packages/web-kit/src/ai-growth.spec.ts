import { describe, it, expect } from 'vitest';
import {
  redactPii,
  containsPii,
  redactRecord,
  deriveEventSummary,
  deriveGrowthRecommendations,
  deriveRiskSignals,
  parseSearchQuery,
  emptyResultSuggestions,
  type EventSummaryInput,
} from '@eticketsgo/shared-types';

// ── WS1/WS10: PII redaction ──
describe('redactPii', () => {
  it('redacts emails, phones, long digit runs and booking references', () => {
    const r = redactPii(
      'Contact a@b.com or +91 98765 43210, card 4111 1111 1111 1111, ref ETG-IN-2026-000123',
    );
    expect(r.text).not.toContain('a@b.com');
    expect(r.text).toContain('[EMAIL]');
    expect(r.text).toContain('[REF]');
    expect(r.counts.email).toBe(1);
    expect(r.counts.reference).toBe(1);
    expect(r.counts.longDigits + r.counts.phone).toBeGreaterThan(0);
  });
  it('leaves clean text unchanged and reports no PII', () => {
    expect(containsPii('How are ticket sales performing?')).toBe(false);
  });
  it('redactRecord sanitises string fields only', () => {
    const { record, redacted } = redactRecord({ q: 'mail me at x@y.com', limit: 5 });
    expect(record.q).toContain('[EMAIL]');
    expect(record.limit).toBe(5);
    expect(redacted).toBe(true);
  });
});

// ── WS3: event summary (deterministic, hallucination-proof) ──
const baseSummary: EventSummaryInput = {
  title: 'Summer Fest',
  currency: 'INR',
  grossTicketSalesMinor: 5_000_00,
  netOrganizerRevenueMinor: 4_500_00,
  refundsMinor: 0,
  ticketsSold: 80,
  ticketsRemaining: 20,
  checkInCount: 0,
  salesByTicketType: [
    { ticketType: 'GA', quantity: 60, grossMinor: 3_000_00 },
    { ticketType: 'VIP', quantity: 20, grossMinor: 2_000_00 },
  ],
  salesByDay: [
    { day: '2026-07-01', bookings: 40, grossMinor: 2_500_00 },
    { day: '2026-07-02', bookings: 40, grossMinor: 2_500_00 },
  ],
  daysToEvent: 30,
};

describe('deriveEventSummary', () => {
  it('reports capacity utilization from the metrics (no invented numbers)', () => {
    const s = deriveEventSummary(baseSummary);
    const cap = s.sections.find((x) => x.key === 'capacity');
    expect(cap?.text).toContain('80%');
    expect(cap?.text).toContain('20 remaining');
    expect(s.headline).toContain('80%');
  });
  it('flags a high refund rate as a warning risk', () => {
    const s = deriveEventSummary({ ...baseSummary, refundsMinor: 1_000_00 });
    const refunds = s.sections.find((x) => x.key === 'refunds');
    expect(refunds?.level).toBe('warning');
    expect(refunds?.text).toContain('20%');
  });
});

// ── WS4: growth recommendations (explainable, advisory) ──
describe('deriveGrowthRecommendations', () => {
  it('recommends promotion for slow sales near the event with evidence', () => {
    const recs = deriveGrowthRecommendations({
      currency: 'INR',
      ticketsSold: 10,
      ticketsRemaining: 90,
      grossTicketSalesMinor: 500_00,
      refundsMinor: 0,
      daysToEvent: 5,
      salesByTicketType: [{ ticketType: 'GA', quantity: 10, grossMinor: 500_00 }],
    });
    const promo = recs.find((r) => r.key === 'PROMOTE_SLOW');
    expect(promo).toBeTruthy();
    expect(promo?.metric).toBeTruthy();
    expect(promo?.action).toBeTruthy();
    expect(promo?.evidence).toBe('strong');
  });
  it('flags nearly sold-out inventory', () => {
    const recs = deriveGrowthRecommendations({
      currency: 'INR',
      ticketsSold: 95,
      ticketsRemaining: 5,
      grossTicketSalesMinor: 9_500_00,
      refundsMinor: 0,
      daysToEvent: 10,
      salesByTicketType: [{ ticketType: 'GA', quantity: 95, grossMinor: 9_500_00 }],
    });
    expect(recs.some((r) => r.key === 'NEARLY_SOLD_OUT')).toBe(true);
  });
});

// ── WS8: risk signals (advisory, evidence-backed) ──
describe('deriveRiskSignals', () => {
  it('raises booking-velocity and refund signals with evidence', () => {
    const signals = deriveRiskSignals({
      windowLabel: 'last 24h',
      topBuyerBookings: { label: 'buyer#1', count: 25 },
      refunds: { refundedMinor: 3_000_00, grossMinor: 10_000_00, count: 8 },
    });
    const velocity = signals.find((s) => s.key === 'BOOKING_VELOCITY');
    expect(velocity?.severity).toBe('high');
    expect(velocity?.evidence).toContain('25');
    expect(signals.some((s) => s.key === 'EXCESSIVE_REFUNDS')).toBe(true);
  });
  it('stays silent below thresholds', () => {
    expect(
      deriveRiskSignals({ windowLabel: 'last 24h', topBuyerBookings: { label: 'x', count: 2 } }),
    ).toHaveLength(0);
  });
});

// ── WS6: smart search parsing ──
describe('parseSearchQuery', () => {
  const opts = {
    categories: ['Concert', 'Sports', 'Comedy'],
    cities: ['Mumbai', 'Delhi', 'Bengaluru'],
    now: new Date('2026-07-15T00:00:00Z'), // Wednesday
  };
  it('extracts category synonym, city (typo-tolerant) and free filter', () => {
    const i = parseSearchQuery('free music in Mumbay', opts);
    expect(i.category).toBe('Concert');
    expect(i.city).toBe('Mumbai'); // typo tolerated
    expect(i.freeOnly).toBe(true);
    expect(i.text).toBe('');
  });
  it('resolves "this weekend" to a Sat–Sun range', () => {
    const i = parseSearchQuery('comedy this weekend', opts);
    expect(i.dateFrom).toBe('2026-07-18');
    expect(i.dateTo).toBe('2026-07-19');
    expect(i.category).toBe('Comedy');
  });
  it('suggests recovery tips on empty results', () => {
    const i = parseSearchQuery('sports in Delhi', opts);
    const tips = emptyResultSuggestions(i, ['Concerts', 'Comedy nights']);
    expect(tips.length).toBeGreaterThan(0);
  });
});
