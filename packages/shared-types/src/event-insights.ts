/**
 * Pure, deterministic event insights derived entirely from an organizer's existing
 * event report (no AI, no new data). Given the report figures + days-to-event, it
 * surfaces actionable signals: nearly/sold out, slow sales, high refunds, popular
 * ticket types, and peak booking day. Framework-free so it can be unit-tested and
 * reused on the server or client.
 */
export type InsightLevel = 'positive' | 'info' | 'warning';

export interface EventInsight {
  key: string;
  level: InsightLevel;
  title: string;
  detail: string;
}

export interface EventInsightInput {
  ticketsSold: number;
  ticketsRemaining: number;
  grossMinor: number;
  refundsMinor: number;
  salesByTicketType: { ticketType: string; quantity: number; grossMinor: number }[];
  salesByDay: { day: string; bookings: number; grossMinor: number }[];
  /** Whole days until the next session starts; null when unknown or already past. */
  daysToEvent: number | null;
}

const HIGH_REFUND_RATE = 0.1; // 10%
const NEARLY_SOLD_OUT = 0.9; // 90% of capacity
const SLOW_WINDOW_DAYS = 14; // "approaching" window for a slow-sales warning

export function deriveEventInsights(i: EventInsightInput): EventInsight[] {
  const out: EventInsight[] = [];
  const capacity = i.ticketsSold + i.ticketsRemaining;
  const utilization = capacity > 0 ? i.ticketsSold / capacity : 0;

  // Capacity signals
  if (capacity > 0 && i.ticketsRemaining === 0 && i.ticketsSold > 0) {
    out.push({
      key: 'SOLD_OUT',
      level: 'positive',
      title: 'Sold out',
      detail: `All ${capacity} tickets are gone. Consider adding capacity or a waitlist.`,
    });
  } else if (utilization >= NEARLY_SOLD_OUT && i.ticketsRemaining > 0) {
    out.push({
      key: 'NEARLY_SOLD_OUT',
      level: 'warning',
      title: 'Nearly sold out',
      detail: `${Math.round(utilization * 100)}% sold — only ${i.ticketsRemaining} ticket(s) left.`,
    });
  }

  // Refund health
  if (i.grossMinor > 0) {
    const refundRate = i.refundsMinor / i.grossMinor;
    if (refundRate >= HIGH_REFUND_RATE) {
      out.push({
        key: 'HIGH_REFUND_RATE',
        level: 'warning',
        title: 'High refund rate',
        detail: `${Math.round(refundRate * 100)}% of gross sales have been refunded — worth investigating.`,
      });
    }
  }

  // Slow sales — approaching the event with lots of unsold inventory and a soft recent pace.
  if (
    i.daysToEvent !== null &&
    i.daysToEvent >= 0 &&
    i.daysToEvent <= SLOW_WINDOW_DAYS &&
    i.ticketsRemaining > 0 &&
    utilization < 0.5
  ) {
    const recent = [...i.salesByDay].slice(-7).reduce((n, d) => n + d.bookings, 0);
    if (recent < i.ticketsRemaining / Math.max(1, i.daysToEvent)) {
      out.push({
        key: 'SLOW_SALES',
        level: 'warning',
        title: 'Sales are slow',
        detail: `${i.ticketsRemaining} ticket(s) left with ${i.daysToEvent} day(s) to go — consider a promotion or coupon.`,
      });
    }
  }

  // Popular ticket type
  const topType = [...i.salesByTicketType].sort((a, b) => b.quantity - a.quantity)[0];
  if (topType && topType.quantity > 0) {
    out.push({
      key: 'POPULAR_TICKET',
      level: 'info',
      title: 'Most popular ticket',
      detail: `"${topType.ticketType}" is your best seller with ${topType.quantity} sold.`,
    });
  }

  // Peak booking day
  const peak = [...i.salesByDay].sort((a, b) => b.bookings - a.bookings)[0];
  if (peak && peak.bookings > 0) {
    out.push({
      key: 'PEAK_DAY',
      level: 'info',
      title: 'Peak booking day',
      detail: `${peak.day} was your busiest day with ${peak.bookings} booking(s).`,
    });
  }

  return out;
}
