import {
  financeClaimedEvents,
  readCurrency,
  type FinanceEntry,
  type FinanceState,
} from '@eticketsgo/shared-types';
import type { FinanceIntegrityFinding } from './platform-finance.producer';

/**
 * Composing two independently certified producers into one organizer-facing view.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────────────
 * Not a third ledger. Not a settlement calculator. Not a payout calculator. Not a reconciliation
 * engine. Financial truth stays in the underlying domains; this filters, groups, orders, separates
 * currencies and attaches evidence-quality warnings. It performs no source arithmetic, so there is
 * no second opinion about money for the first one to disagree with.
 *
 * ── THE ONE THING IT MUST GET RIGHT ────────────────────────────────────────────────
 * Not double counting. Both paths can describe the same event's revenue, and the ledger keeps them
 * apart at write time - `SETTLEMENT_CLAIMED_STATUSES` excludes provider-claimed events from payout
 * generation. But a READER handed both sets could still add them together, and the result would
 * look entirely plausible.
 *
 * So composition checks the one-path invariant over what it was given and reports any event
 * claimed by both. It does NOT silently drop one side: dropping the platform entry would hide a
 * payout that really was raised, and dropping the provider entry would hide money that really
 * moved. A double claim is a fact about our data, and the caller is told.
 */

/** Which financial path an entry came from, kept visible rather than flattened away. */
export type FinancePath = 'PLATFORM' | 'PROVIDER';

/**
 * Why part of this view is less than fully known.
 *
 * ── TWO CATEGORIES, DELIBERATELY ───────────────────────────────────────────────────
 * A legacy payout whose decomposition was never stored is a HISTORICAL LIMITATION: nothing is
 * broken, and showing it as a financial emergency would train an organizer to ignore the ones
 * that matter. A payout whose allocations disagree with its own totals is an INTEGRITY problem and
 * somebody has to look. The severity is what separates them.
 */
export type FinanceWarningCategory = 'HISTORICAL_LIMITATION' | 'FINANCIAL_INTEGRITY';

export interface FinanceWarning {
  category: FinanceWarningCategory;
  code:
    /** A legacy payout records no event membership. Its amount is still authoritative. */
    | 'EVENT_ATTRIBUTION_UNAVAILABLE'
    /** A legacy payout never stored its discount or organizer fee. */
    | 'DEDUCTION_DETAIL_UNAVAILABLE'
    /** Stored totals and immutable component evidence disagree. */
    | 'EVIDENCE_DISAGREEMENT'
    /** One event is claimed by both settlement paths. */
    | 'DOUBLE_CLAIM'
    /** Reconciliation or an unresolved reversal needs a person. */
    | 'NEEDS_RECONCILIATION'
    /** A settlement cannot say what moved, because the original transfer was never recorded. */
    | 'MOVEMENT_DETAIL_UNAVAILABLE';
  /** The entries this concerns, by sourceId, so a warning can be chased to a row. */
  sourceIds: string[];
  detail: string;
}

/** One entry plus the path it came from. The entry itself is never rewritten. */
export interface ComposedEntry {
  path: FinancePath;
  entry: FinanceEntry;
}

/**
 * Everything for ONE currency. There is no cross-currency container on purpose.
 *
 * An organization with INR and USD gets two of these. Nothing in this type can hold a total
 * spanning both, so `INR + USD` is not a mistake somebody can make here - it is unrepresentable.
 */
export interface FinanceCurrencyGroup {
  currency: string;
  entries: ComposedEntry[];
  /** Both paths together. The only figure that answers "what is this organization owed". */
  summary: FinanceSummary;
  /**
   * The same figures per path, for a screen that shows the two settlement routes separately.
   *
   * One entry per path PRESENT - a platform-only organization gets one, not two with a zeroed
   * provider. A zero would assert something about a route this organization does not use.
   */
  paths: FinancePathSummary[];
  warnings: FinanceWarning[];
}

/**
 * The summary, with every field's meaning fixed and documented.
 *
 * ── WHY SO FEW NUMBERS ─────────────────────────────────────────────────────────────
 * Only concepts both paths compute the same way are summed. Where they do not, the number is
 * absent rather than approximated - a clean but false total is worse than a missing one, because
 * nobody questions a number that looks reasonable.
 */
export interface FinanceSummary {
  /**
   * Total organizer entitlement across every entry in this currency.
   *
   * Additive across entries and across lifecycle states, because both paths define it the same
   * way: what the organizer is owed from that financial record. Platform payouts contribute
   * `Payout.netMinor`; settlements contribute `Settlement.grossSalesMinor`. Neither is a
   * money-movement figure, so adding them does not mix entitlement with cash.
   */
  entitlementMinor: number;
  /**
   * Entitlement whose record says the money has landed.
   *
   * Only entries in PAID contribute. Deliberately NOT "money the organizer holds": a provider
   * settlement can be PAID and have had money clawed back since, which `movement` describes and
   * this does not.
   */
  paidMinor: number;
  /** Entitlement still waiting: PENDING or IN_PROGRESS. */
  pendingMinor: number;
  /** Entitlement whose record needs a person before it can be read as anything. */
  attentionMinor: number;
  /**
   * Provider money movement, summed only over entries that HAVE movement.
   *
   * Absent when no entry in this currency moved money through a provider - the platform ledger
   * has no equivalent, so a zero would assert something about a path that does not report it.
   */
  movement?: {
    transferredOutMinor: number;
    recoveredMinor: number;
    stillOutMinor: number;
  };
  /**
   * Refund accounting, summed only where proven.
   *
   * Absent when no entry proves a refund figure. NOT a money-recovered number: a refund can be
   * recorded while nothing has come back. See `movement.recoveredMinor` for that.
   */
  refundsMinor?: number;
  /**
   * Deductions that actually came out of entitlement.
   *
   * Sums only fee lines with `deducted: true`, which is why that flag exists. Summing every line
   * would include customer-borne booking and payment fees and understate what the organizer is
   * owed. Absent when no entry proves a deducted fee.
   */
  deductedFeesMinor?: number;
  /** Entry counts by path, so a reader can see the view is mixed without inspecting entries. */
  counts: { platform: number; provider: number };
}

/**
 * One path's share of a currency group.
 *
 * ── WHY THE SERVER PROVIDES THIS AND NOT THE UI ────────────────────────────────────
 * The organizer Finance page shows a platform ladder from `/payouts/summary` and needs the
 * provider side beside it. Summing provider entries in a component would be a second financial
 * opinion in the browser, and the whole point of this projection is that there is one.
 *
 * It is produced by the SAME `buildSummary` the total uses, over a filtered subset, so a path
 * figure cannot drift from the total it is part of - and a test asserts the paths add back to it.
 */
export interface FinancePathSummary extends FinanceSummary {
  path: FinancePath;
}

export interface ComposeInput {
  platform: ReadonlyArray<{ entry: FinanceEntry; integrity: FinanceIntegrityFinding[] }>;
  provider: ReadonlyArray<{ entry: FinanceEntry; integrity: FinanceIntegrityFinding[] }>;
}

export interface ComposedFinance {
  /** One per currency, ordered by currency code. Never a combined total. */
  currencies: FinanceCurrencyGroup[];
}

const PAID_STATES: ReadonlySet<FinanceState> = new Set<FinanceState>(['PAID']);
const PENDING_STATES: ReadonlySet<FinanceState> = new Set<FinanceState>(['PENDING', 'IN_PROGRESS']);

/**
 * Compose platform and provider entries into per-currency groups.
 *
 * Pure. No database, no provider, no writes. The caller fetched and produced; this arranges and
 * reports.
 */
export function composeFinance(input: ComposeInput): ComposedFinance {
  const all: Array<{
    path: FinancePath;
    entry: FinanceEntry;
    integrity: FinanceIntegrityFinding[];
  }> = [
    ...input.platform.map((p) => ({ path: 'PLATFORM' as const, ...p })),
    ...input.provider.map((p) => ({ path: 'PROVIDER' as const, ...p })),
  ];

  /** currency -> the entries in it. Folded exactly as the producers folded it. */
  const byCurrency = new Map<string, typeof all>();
  for (const item of all) {
    const currency = readCurrency(item.entry.currency) ?? item.entry.currency;
    byCurrency.set(currency, [...(byCurrency.get(currency) ?? []), item]);
  }

  const currencies: FinanceCurrencyGroup[] = [];
  for (const [currency, items] of [...byCurrency.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    currencies.push(buildGroup(currency, items));
  }
  return { currencies };
}

function buildGroup(
  currency: string,
  items: Array<{ path: FinancePath; entry: FinanceEntry; integrity: FinanceIntegrityFinding[] }>,
): FinanceCurrencyGroup {
  const warnings: FinanceWarning[] = [];

  // ── double claim, the one thing composition must not let through ─────────────────
  const claims = new Map<string, Map<FinancePath, string[]>>();
  for (const item of items) {
    for (const eventId of financeClaimedEvents(item.entry)) {
      const byPath = claims.get(eventId) ?? new Map<FinancePath, string[]>();
      byPath.set(item.path, [...(byPath.get(item.path) ?? []), item.entry.sourceId]);
      claims.set(eventId, byPath);
    }
  }
  for (const [eventId, byPath] of claims) {
    if (byPath.size < 2) continue;
    /*
      Reported, never resolved by dropping a side. Dropping the platform entry would hide a payout
      that really was raised; dropping the provider entry would hide money that really moved. The
      ledger keeps the paths apart at write time, so this means something went wrong upstream.
    */
    warnings.push({
      category: 'FINANCIAL_INTEGRITY',
      code: 'DOUBLE_CLAIM',
      sourceIds: [...byPath.values()].flat().sort(),
      detail: `event ${eventId} is claimed by both the platform and provider paths`,
    });
  }

  /*
    ── EVIDENCE QUALITY, SPLIT BY WHAT THE FINDING ACTUALLY MEANS ───────────────────
    Not every integrity finding is a disagreement. MOVEMENT_NOT_RECORDED says a figure was never
    stored, which is a gap in what we keep - not two sources contradicting each other. Lumping it
    in would raise a financial alarm about every released settlement, and an alarm that is always
    on is an alarm nobody reads.
  */
  const disagreeing = items.filter((i) =>
    i.integrity.some((f) => f.code !== 'MOVEMENT_NOT_RECORDED'),
  );
  if (disagreeing.length > 0) {
    warnings.push({
      category: 'FINANCIAL_INTEGRITY',
      code: 'EVIDENCE_DISAGREEMENT',
      sourceIds: disagreeing.map((i) => i.entry.sourceId).sort(),
      detail: 'stored totals and their supporting evidence do not agree',
    });
  }

  const movementMissing = items.filter((i) =>
    i.integrity.some((f) => f.code === 'MOVEMENT_NOT_RECORDED'),
  );
  if (movementMissing.length > 0) {
    warnings.push({
      category: 'HISTORICAL_LIMITATION',
      code: 'MOVEMENT_DETAIL_UNAVAILABLE',
      sourceIds: movementMissing.map((i) => i.entry.sourceId).sort(),
      detail: 'the amount originally transferred was never recorded, so what moved cannot be shown',
    });
  }

  const unknownAttribution = items.filter((i) => i.entry.attribution === 'UNKNOWN_LEGACY');
  if (unknownAttribution.length > 0) {
    /*
      HISTORICAL_LIMITATION, not an emergency. These payouts are real and their amounts are
      authoritative; only their event membership was never recorded. Flagging them at the same
      severity as a disagreement would teach an organizer to ignore both.
    */
    warnings.push({
      category: 'HISTORICAL_LIMITATION',
      code: 'EVENT_ATTRIBUTION_UNAVAILABLE',
      sourceIds: unknownAttribution.map((i) => i.entry.sourceId).sort(),
      detail: 'these payouts predate allocations, so which events they covered was never recorded',
    });
  }

  /*
    A platform entry with no deducted fee line proves no organizer fee - the row never stored one.
    Distinct from attribution: an event-scoped legacy payout knows its event and still cannot
    explain its deductions, which is why these two warnings are independent.
  */
  const noDecomposition = items.filter(
    (i) => i.path === 'PLATFORM' && !(i.entry.money.fees ?? []).some((f) => f.key === 'PLATFORM'),
  );
  if (noDecomposition.length > 0) {
    warnings.push({
      category: 'HISTORICAL_LIMITATION',
      code: 'DEDUCTION_DETAIL_UNAVAILABLE',
      sourceIds: noDecomposition.map((i) => i.entry.sourceId).sort(),
      detail: 'these payouts never stored their discount or organizer fee, so it cannot be shown',
    });
  }

  const needsPerson = items.filter(
    (i) => i.entry.state === 'ATTENTION_REQUIRED' && i.integrity.length === 0,
  );
  if (needsPerson.length > 0) {
    warnings.push({
      category: 'FINANCIAL_INTEGRITY',
      code: 'NEEDS_RECONCILIATION',
      sourceIds: needsPerson.map((i) => i.entry.sourceId).sort(),
      detail: 'reconciliation or an unresolved reversal needs a person before these can be read',
    });
  }

  return {
    currency,
    // Deterministic: path, then sourceId. Ordering carries no financial meaning.
    entries: [...items]
      .sort((a, b) =>
        a.path !== b.path
          ? a.path < b.path
            ? -1
            : 1
          : a.entry.sourceId < b.entry.sourceId
            ? -1
            : 1,
      )
      .map(({ path, entry }) => ({ path, entry })),
    summary: buildSummary(items),
    /*
      Only paths that actually appear, in a fixed order so a response is stable. `buildSummary`
      is reused rather than reimplemented, which is what makes the parts add up to the whole by
      construction instead of by agreement.
    */
    paths: (['PLATFORM', 'PROVIDER'] as const)
      .map((path) => ({ path, items: items.filter((i) => i.path === path) }))
      .filter(({ items: subset }) => subset.length > 0)
      .map(({ path, items: subset }) => ({ path, ...buildSummary(subset) })),
    warnings,
  };
}

function buildSummary(items: Array<{ path: FinancePath; entry: FinanceEntry }>): FinanceSummary {
  let entitlement = 0;
  let paid = 0;
  let pending = 0;
  let attention = 0;
  let platform = 0;
  let provider = 0;

  let movedAny = false;
  let transferredOut = 0;
  let recovered = 0;
  let stillOut = 0;

  let refundsAny = false;
  let refunds = 0;

  let deductedAny = false;
  let deducted = 0;

  for (const { path, entry } of items) {
    if (path === 'PLATFORM') platform += 1;
    else provider += 1;

    const net = entry.money.organizerNetMinor;
    entitlement += net;
    if (PAID_STATES.has(entry.state)) paid += net;
    else if (PENDING_STATES.has(entry.state)) pending += net;
    else attention += net;

    if (entry.movement !== undefined) {
      movedAny = true;
      transferredOut += entry.movement.transferredOutMinor;
      recovered += entry.movement.recoveredMinor;
      stillOut += entry.movement.stillOutMinor;
    }

    if (entry.money.refundsMinor !== undefined) {
      refundsAny = true;
      refunds += entry.money.refundsMinor;
    }

    for (const fee of entry.money.fees ?? []) {
      // ONLY deducted lines. Summing all of them would include customer-borne fees.
      if (fee.deducted) {
        deductedAny = true;
        deducted += fee.amountMinor;
      }
    }
  }

  return {
    entitlementMinor: entitlement,
    paidMinor: paid,
    pendingMinor: pending,
    attentionMinor: attention,
    counts: { platform, provider },
    // Absent rather than zero where no entry in this currency proves the concept at all.
    ...(movedAny
      ? {
          movement: {
            transferredOutMinor: transferredOut,
            recoveredMinor: recovered,
            stillOutMinor: stillOut,
          },
        }
      : {}),
    ...(refundsAny ? { refundsMinor: refunds } : {}),
    ...(deductedAny ? { deductedFeesMinor: deducted } : {}),
  };
}
