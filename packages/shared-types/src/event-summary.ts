/**
 * Deterministic event performance summary (v2.0 WS3). Built entirely from the
 * existing organizer event report + commerce report + insights — no AI, no new data.
 * This IS the product when AI is disabled; when a provider is configured it may only
 * rephrase these facts, never invent new ones. Money is integer minor units.
 */
import { deriveEventInsights, type EventInsight, type EventInsightInput } from './event-insights';

export type SummaryLevel = 'positive' | 'info' | 'warning';

export interface EventSummarySection {
  key: string;
  label: string;
  /** One-line, factual, sourced from the metrics. */
  text: string;
  level: SummaryLevel;
}

export interface EventSummary {
  headline: string;
  sections: EventSummarySection[];
  /** A short factual paragraph joining the section lines. */
  narrative: string;
  /** The deterministic insights the summary drew on (advisory). */
  insights: EventInsight[];
}

export interface EventSummaryInput {
  title: string;
  currency: string;
  grossTicketSalesMinor: number;
  netOrganizerRevenueMinor: number;
  refundsMinor: number;
  ticketsSold: number;
  ticketsRemaining: number;
  checkInCount: number;
  salesByTicketType: { ticketType: string; quantity: number; grossMinor: number }[];
  salesByDay: { day: string; bookings: number; grossMinor: number }[];
  daysToEvent: number | null;
  couponCount?: number;
  couponRedemptions?: number;
  commerce?: {
    addOnRevenueMinor: number;
    bundleRevenueMinor: number;
    donationTotalMinor: number;
  };
}

/** Deterministic minor→major formatting with a fixed locale so output is testable. */
export function formatMinor(minor: number, currency = 'INR'): string {
  const major = Math.round(minor) / 100;
  return `${currency} ${major.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function pct(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 100) : 0;
}

export function deriveEventSummary(input: EventSummaryInput): EventSummary {
  const capacity = input.ticketsSold + input.ticketsRemaining;
  const utilization = pct(input.ticketsSold, capacity);
  const refundRate = pct(input.refundsMinor, input.grossTicketSalesMinor);
  const checkInRate = pct(input.checkInCount, input.ticketsSold);

  const sections: EventSummarySection[] = [];

  // Sales performance
  const topType = [...input.salesByTicketType].sort((a, b) => b.quantity - a.quantity)[0];
  sections.push({
    key: 'sales',
    label: 'Sales performance',
    text: `${input.ticketsSold} ticket${input.ticketsSold === 1 ? '' : 's'} sold for ${formatMinor(
      input.grossTicketSalesMinor,
      input.currency,
    )} gross${topType ? `; "${topType.ticketType}" is the best seller (${topType.quantity})` : ''}.`,
    level: input.ticketsSold > 0 ? 'positive' : 'info',
  });

  // Capacity utilization
  sections.push({
    key: 'capacity',
    label: 'Capacity utilization',
    text:
      capacity > 0
        ? `${utilization}% of ${capacity} capacity sold, ${input.ticketsRemaining} remaining.`
        : 'No ticket capacity configured yet.',
    level: utilization >= 90 ? 'positive' : utilization < 40 ? 'warning' : 'info',
  });

  // Revenue trend (compare last day vs previous days average)
  sections.push({
    key: 'revenue',
    label: 'Revenue trend',
    text: revenueTrendText(input),
    level: 'info',
  });

  // Coupon performance
  if ((input.couponCount ?? 0) > 0) {
    sections.push({
      key: 'coupons',
      label: 'Coupon performance',
      text: `${input.couponRedemptions ?? 0} redemption${
        (input.couponRedemptions ?? 0) === 1 ? '' : 's'
      } across ${input.couponCount} active coupon${input.couponCount === 1 ? '' : 's'}.`,
      level: 'info',
    });
  }

  // Refund trend
  sections.push({
    key: 'refunds',
    label: 'Refund trend',
    text:
      input.refundsMinor > 0
        ? `${formatMinor(input.refundsMinor, input.currency)} refunded (${refundRate}% of gross).`
        : 'No refunds so far.',
    level: refundRate >= 10 ? 'warning' : 'positive',
  });

  // Check-in progress
  sections.push({
    key: 'checkin',
    label: 'Check-in progress',
    text:
      input.checkInCount > 0
        ? `${input.checkInCount} checked in (${checkInRate}% of sold).`
        : 'Check-in has not started.',
    level: 'info',
  });

  // Commerce performance
  if (input.commerce) {
    const c = input.commerce;
    const total = c.addOnRevenueMinor + c.bundleRevenueMinor;
    sections.push({
      key: 'commerce',
      label: 'Commerce performance',
      text:
        total + c.donationTotalMinor > 0
          ? `${formatMinor(total, input.currency)} from add-ons & bundles${
              c.donationTotalMinor > 0
                ? `, plus ${formatMinor(c.donationTotalMinor, input.currency)} in donations`
                : ''
            }.`
          : 'No add-on, bundle or donation sales yet.',
      level: total + c.donationTotalMinor > 0 ? 'positive' : 'info',
    });
  }

  // Operational risks (from deterministic insights)
  const insightInput: EventInsightInput = {
    ticketsSold: input.ticketsSold,
    ticketsRemaining: input.ticketsRemaining,
    grossMinor: input.grossTicketSalesMinor,
    refundsMinor: input.refundsMinor,
    salesByTicketType: input.salesByTicketType,
    salesByDay: input.salesByDay,
    daysToEvent: input.daysToEvent,
  };
  const insights = deriveEventInsights(insightInput);
  const risks = insights.filter((i) => i.level === 'warning');
  sections.push({
    key: 'risks',
    label: 'Operational risks',
    text: risks.length
      ? risks.map((r) => r.title).join('; ') + '.'
      : 'No operational risks flagged.',
    level: risks.length ? 'warning' : 'positive',
  });

  const headline =
    input.ticketsSold === 0
      ? `${input.title} has not sold tickets yet.`
      : `${input.title}: ${utilization}% sold, ${formatMinor(input.grossTicketSalesMinor, input.currency)} gross${
          risks.length ? `, ${risks.length} risk${risks.length === 1 ? '' : 's'} to review` : ''
        }.`;

  return {
    headline,
    sections,
    narrative: sections.map((s) => s.text).join(' '),
    insights,
  };
}

function revenueTrendText(input: EventSummaryInput): string {
  const days = input.salesByDay;
  if (days.length < 2) return 'Not enough sales history to show a trend yet.';
  const last = days[days.length - 1];
  const prior = days.slice(0, -1);
  const priorAvg = prior.reduce((s, d) => s + d.grossMinor, 0) / prior.length;
  if (priorAvg === 0) return `Latest day brought ${formatMinor(last.grossMinor, input.currency)}.`;
  const change = Math.round(((last.grossMinor - priorAvg) / priorAvg) * 100);
  const dir = change > 5 ? 'up' : change < -5 ? 'down' : 'flat';
  return `Most recent day is ${dir}${dir === 'flat' ? '' : ` ${Math.abs(change)}%`} versus the prior daily average.`;
}
