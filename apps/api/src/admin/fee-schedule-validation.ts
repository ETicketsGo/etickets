import { FeeMode, feeBandLabel, marketFor, MARKETS, money } from '@eticketsgo/shared-types';
import { AppException } from '../common/errors';
import {
  applicableTiers,
  calculateFees,
  scheduleTiers,
  type FeePlace,
} from '../pricing/fee-calculator';
import { assertBandShape, normaliseCharge, type FeeBandType } from './fee-band-charge';
import { coverageGaps, describeGap, majorUnitMinor, uncoveredRange } from './fee-band-coverage';

/**
 * A whole booking-fee schedule, checked before it is published.
 *
 * ── WHY THE WHOLE SCHEDULE AT ONCE ────────────────────────────────────────────────
 * The one-band editor checks each edit against the live schedule, so every intermediate step
 * of a reorganisation must itself be a whole schedule - and usually none is (see
 * `FeeScheduleDraft` in schema.prisma). A draft is checked as a whole instead: anything may be
 * broken while it is edited, and it is published only when the final state is whole.
 *
 * The rules are the ones checkout depends on, judged the same way pricing picks bands
 * (`applicableTiers`):
 *  - every band is well formed and charges in a supported way (`normaliseCharge`);
 *  - a band's country sells in the schedule's currency (a USD band for India prices nothing);
 *  - no two active bands in one place cover the same amount (first match would decide);
 *  - every place the schedule names, and the currency's own market, is priced from 0 upwards
 *    with no uncovered range (one major unit of slack, as the delete check allows: "Rs 0 - Rs
 *    199" then "Rs 200 - Rs 499" is how a person writes a range, and is shown as a note).
 */

export interface ScheduleBand {
  /** Stable within the draft; the editor's row key. */
  key: string;
  /** The live FeeRule this row was copied from, or null for a new band. */
  sourceId: string | null;
  minMinor: number;
  maxMinor: number | null;
  feeType: FeeBandType;
  feeMinor: number;
  feePercentBps: number | null;
  minFeeMinor: number | null;
  maxFeeMinor: number | null;
  country: string;
  region: string;
  active: boolean;
}

export type ScheduleIssueCode = 'BAND_INVALID' | 'WRONG_MARKET' | 'OVERLAP' | 'GAP' | 'NO_BAND';

export interface ScheduleIssue {
  code: ScheduleIssueCode;
  /** An error blocks a publish. A note is shown and does not. */
  severity: 'error' | 'note';
  /** One plain-English sentence, with amounts in the schedule's currency. */
  message: string;
  /** The draft rows involved (empty for a place with no band at all). */
  bandKeys: string[];
  /** Where: "United States", "California, United States", or "Everywhere". */
  place: string;
  /** The affected range, when there is one. `toMinor` null is "and above". */
  fromMinor?: number;
  toMinor?: number | null;
}

export interface ScheduleValidation {
  valid: boolean;
  issues: ScheduleIssue[];
}

const placeName = (country: string, region: string): string =>
  region !== '*' ? `${region}, ${country}` : country !== '*' ? country : 'Everywhere';

const bandName = (b: Pick<ScheduleBand, 'minMinor' | 'maxMinor'>, currency: string) =>
  `"${feeBandLabel(b, currency)}"`;

/** The market country whose sales this currency prices, when exactly one market uses it. */
export function marketCountryFor(currency: string): string | null {
  const markets = MARKETS.filter((m) => m.currency === currency);
  return markets.length === 1 ? markets[0].name : null;
}

/** Check a whole schedule. Pure: nothing is read or written. */
export function validateSchedule(
  currency: string,
  bands: readonly ScheduleBand[],
): ScheduleValidation {
  const issues: ScheduleIssue[] = [];
  const usable: ScheduleBand[] = [];

  // ── 1. Each band on its own ────────────────────────────────────────────────────
  for (const b of bands) {
    const where = placeName(b.country, b.region);
    try {
      assertBandShape(b.minMinor, b.maxMinor);
      const charge = normaliseCharge({
        feeType: b.feeType,
        feeMinor: b.feeMinor,
        feePercentBps: b.feePercentBps,
        minFeeMinor: b.minFeeMinor,
        maxFeeMinor: b.maxFeeMinor,
      });
      if (charge.feeMinor < 0) {
        throw new AppException('VALIDATION_FAILED', 'The fee cannot be below zero.');
      }
      usable.push({ ...b, ...charge });
    } catch (err) {
      const reason = err instanceof AppException ? err.message : 'This band is not valid.';
      issues.push({
        code: 'BAND_INVALID',
        severity: 'error',
        message: `${bandName(b, currency)} in ${where}: ${reason}`,
        bandKeys: [b.key],
        place: where,
      });
      continue;
    }
    if (b.country === '*' && b.region !== '*') {
      issues.push({
        code: 'BAND_INVALID',
        severity: 'error',
        message: `${bandName(b, currency)} names a state but no country. Choose the country first.`,
        bandKeys: [b.key],
        place: where,
      });
    }
    const market = b.country === '*' ? null : marketFor(b.country);
    if (b.country !== '*' && market && market.currency !== currency) {
      issues.push({
        code: 'WRONG_MARKET',
        severity: 'error',
        message: `${bandName(b, currency)} is for ${market.name}, which sells in ${market.currency}, not ${currency}. It would never be used. Change its country or remove it.`,
        bandKeys: [b.key],
        place: where,
      });
    }
  }

  const active = usable.filter((b) => b.active);

  // ── 2. Overlaps within one place ───────────────────────────────────────────────
  const scopes = new Map<string, ScheduleBand[]>();
  for (const b of active) {
    const k = `${b.country.trim().toUpperCase()}|${b.region.trim().toUpperCase()}`;
    scopes.set(k, [...(scopes.get(k) ?? []), b]);
  }
  const hi = (m: number | null) => (m === null ? Number.POSITIVE_INFINITY : m);
  for (const group of scopes.values()) {
    const sorted = [...group].sort((a, b) => a.minMinor - b.minMinor);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        if (b.minMinor > hi(a.maxMinor)) break;
        const from = b.minMinor;
        const to = Math.min(hi(a.maxMinor), hi(b.maxMinor));
        const toMinor = to === Number.POSITIVE_INFINITY ? null : to;
        const where = placeName(a.country, a.region);
        const range =
          toMinor === null
            ? `orders of ${money(from, currency)} and above`
            : `orders from ${money(from, currency)} to ${money(toMinor, currency)}`;
        issues.push({
          code: 'OVERLAP',
          severity: 'error',
          message: `${bandName(a, currency)} and ${bandName(b, currency)} both cover ${range} in ${where}. Change one so they do not overlap.`,
          bandKeys: [a.key, b.key],
          place: where,
          fromMinor: from,
          toMinor,
        });
      }
    }
  }

  // ── 3. Coverage from 0 in every place the schedule prices ─────────────────────
  const places = new Map<string, FeePlace & { name: string }>();
  const addPlace = (country: string, region: string) => {
    const k = `${country.trim().toUpperCase()}|${region.trim().toUpperCase()}`;
    if (places.has(k)) return;
    places.set(k, {
      country: country === '*' ? undefined : country,
      region: region === '*' ? undefined : region,
      name: placeName(country, region),
    });
  };
  const home = marketCountryFor(currency);
  addPlace(home ?? '*', '*');
  for (const b of active) if (b.country !== '*') addPlace(b.country, b.region);

  const step = majorUnitMinor(currency);
  for (const place of places.values()) {
    const tiers = applicableTiers(active, place);
    if (tiers.length === 0) {
      issues.push({
        code: 'NO_BAND',
        severity: 'error',
        message: `No active band prices ${currency} orders in ${place.name}. Those orders would be charged the built-in default fees. Add a band that starts at ${money(0, currency)}.`,
        bandKeys: [],
        place: place.name,
        fromMinor: 0,
        toMinor: null,
      });
      continue;
    }
    const keys = (from: number, to: number | null) =>
      tiers
        .filter(
          (t) =>
            (t.maxMinor !== null && t.maxMinor + 1 === from) ||
            (to !== null && t.minMinor === to + 1),
        )
        .map((t) => t.key);
    for (const gap of coverageGaps(tiers, currency)) {
      const { fromMinor, toMinor } = uncoveredRange(gap);
      issues.push({
        code: 'GAP',
        severity: 'error',
        message: `In ${place.name}, ${describeGap(gap, currency)} have no band. Add a band or widen a neighbour to cover them.`,
        bandKeys: keys(fromMinor, toMinor),
        place: place.name,
        fromMinor,
        toMinor,
      });
    }
    // Gaps smaller than one major unit are allowed (see above) but said out loud.
    for (const gap of coverageGaps(tiers, currency, 1)) {
      if (gap.afterMinor === null || gap.beforeMinor === null) continue;
      if (gap.beforeMinor - gap.afterMinor > step) continue;
      const { fromMinor, toMinor } = uncoveredRange(gap);
      issues.push({
        code: 'GAP',
        severity: 'note',
        message: `In ${place.name}, ${describeGap(gap, currency)} fall between two bands and are charged by the nearest band. This is allowed.`,
        bandKeys: keys(fromMinor, toMinor),
        place: place.name,
        fromMinor,
        toMinor,
      });
    }
  }

  return { valid: !issues.some((i) => i.severity === 'error'), issues };
}

export interface PreviewRow {
  /** The order's net total (after discount), which picks the band. */
  orderMinor: number;
  /** Paid tickets in the order; only per-ticket bands read it. */
  tickets: number;
  /** The booking fee the live schedule charges now. */
  liveFeeMinor: number;
  /** The booking fee this draft would charge once published. */
  draftFeeMinor: number;
}

/**
 * The booking fee for sample orders under the live schedule and under the draft, in one place.
 *
 * Priced by the checkout's own engine (`calculateFees` over `scheduleTiers`) - there is no
 * second pricing rule. Only the booking fee is shown: the payment fee and tax do not depend on
 * the schedule. Event and organizer fee policies still override the schedule where they apply.
 */
export function previewSchedule(
  currency: string,
  draft: readonly ScheduleBand[],
  live: readonly Omit<ScheduleBand, 'key' | 'sourceId'>[],
  place?: FeePlace,
): { place: string; rows: PreviewRow[] } {
  const home = marketCountryFor(currency);
  const at: FeePlace = place ?? (home ? { country: home } : {});
  const draftActive = draft.filter((b) => b.active);
  const liveActive = live.filter((b) => b.active);
  const unit = majorUnitMinor(currency);

  const amounts = new Set<number>([0]);
  for (const b of [...draftActive, ...liveActive]) {
    amounts.add(b.minMinor);
    if (b.minMinor > 0) amounts.add(b.minMinor - 1);
    if (b.maxMinor !== null) amounts.add(b.maxMinor);
  }
  for (const n of [10, 25, 50, 100, 500, 1000]) amounts.add(n * unit);
  const orders = [...amounts]
    .filter((a) => a >= 0)
    .sort((a, b) => a - b)
    .slice(0, 24);

  const withId = (rows: readonly Omit<ScheduleBand, 'key' | 'sourceId'>[]) =>
    rows.map((r, i) => ({ ...r, id: String(i) }));
  const draftTiers = draftActive.length ? scheduleTiers(withId(draftActive), at) : null;
  const liveTiers = liveActive.length ? scheduleTiers(withId(liveActive), at) : null;
  const fee = (tiers: ReturnType<typeof scheduleTiers> | null, order: number, tickets: number) =>
    calculateFees({
      subtotalMinor: order,
      feeMode: FeeMode.CUSTOMER_PAYS,
      currency,
      ticketCount: tickets,
      paymentFeeBps: 0,
      // No band at all is what checkout does too: the built-in defaults.
      ...(tiers ? { tiers } : {}),
    }).bookingFeeMinor;

  const rows: PreviewRow[] = [];
  for (const orderMinor of orders) {
    for (const tickets of orderMinor === 0 ? [1] : [1, 4]) {
      rows.push({
        orderMinor,
        tickets,
        liveFeeMinor: fee(liveTiers, orderMinor, tickets),
        draftFeeMinor: fee(draftTiers, orderMinor, tickets),
      });
    }
  }
  return { place: placeName(home ?? '*', '*'), rows };
}
