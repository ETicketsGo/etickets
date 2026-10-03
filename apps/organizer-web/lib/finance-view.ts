import type {
  FinanceCurrencyGroupDto,
  FinanceWarningDto,
  UnifiedFinanceDto,
} from '@eticketsgo/web-kit';

/**
 * How Finance should be PRESENTED. Not what it means - the server decided that.
 *
 * ── WHY THIS IS A PURE FUNCTION AND NOT JSX ────────────────────────────────────────
 * Every claim worth testing on a money page is a decision made here: whether a figure appears at
 * all, whether a historical gap reads as a warning or an emergency, which fees are shown as
 * deductions. Keeping those in a component would mean the only way to check "a failed request
 * never shows a zero" is to render a tree, and this console has no renderer in its test setup.
 *
 * ── THE RULE THIS EXISTS TO ENFORCE ────────────────────────────────────────────────
 * Three different situations must never look the same:
 *
 *   UNAVAILABLE   the request failed. We do not know what the organizer has.
 *   NO_RECORDS    the request succeeded and there is genuinely nothing yet.
 *   RECORDS       there are records - and one of them may legitimately be zero.
 *
 * A zero is a FACT about money. "We could not load it" and "there is nothing yet" are not facts
 * about money at all, and rendering either as a currency figure tells an organizer something
 * false. So `amountsShown` is false for both, and no view carries a figure it cannot support.
 *
 * ── IT RECALCULATES NOTHING ────────────────────────────────────────────────────────
 * Every amount is passed through from the server. Deductions come from `deducted`, never from
 * summing fee lines. The frontend presents Finance; it does not become a second financial engine.
 */

export type FinanceLoad =
  | { kind: 'LOADING' }
  /** The request failed. `reason` is for support, never shown as a money figure. */
  | { kind: 'FAILED'; reason?: string }
  | { kind: 'LOADED'; data: UnifiedFinanceDto };

export type FinanceViewKind = 'LOADING' | 'UNAVAILABLE' | 'NO_RECORDS' | 'RECORDS';

/** One warning, translated out of our vocabulary into something an organizer can act on. */
export interface FinanceNoticeView {
  /** `info` is a limitation of old records. `attention` is something somebody must look at. */
  tone: 'info' | 'attention';
  message: string;
}

export interface FinanceFeeView {
  key: string;
  amountMinor: number;
  /** True when it came out of the organizer's money. Drives the wording, not a colour. */
  deducted: boolean;
}

export interface FinanceCurrencyView {
  currency: string;
  /** Null where the server could not prove the concept. NEVER 0 as a stand-in. */
  entitlementMinor: number;
  paidMinor: number;
  pendingMinor: number;
  attentionMinor: number;
  deductedFeesMinor: number | null;
  refundsMinor: number | null;
  movement: { transferredOutMinor: number; recoveredMinor: number; stillOutMinor: number } | null;
  notices: FinanceNoticeView[];
  entryCount: number;
}

export interface FinanceView {
  kind: FinanceViewKind;
  heading: string;
  explanation: string;
  /**
   * Whether this view may display money at all.
   *
   * False for LOADING, UNAVAILABLE and NO_RECORDS. A screen that shows a currency figure while
   * this is false is showing a number the server did not give it.
   */
  amountsShown: boolean;
  currencies: FinanceCurrencyView[];
}

/**
 * Warnings in organizer language.
 *
 * `UNKNOWN_LEGACY` and `DEDUCTION_DETAIL_UNAVAILABLE` are our words for "this record predates the
 * detail we now keep". An organizer reading an enum name learns nothing, so the vocabulary stops
 * here. Tone follows the server's category rather than being guessed per code: a historical gap
 * is not an emergency, and showing it as one teaches people to ignore the real ones.
 */
function notice(warning: FinanceWarningDto): FinanceNoticeView {
  const tone = warning.category === 'FINANCIAL_INTEGRITY' ? 'attention' : 'info';
  switch (warning.code) {
    case 'EVENT_ATTRIBUTION_UNAVAILABLE':
      return {
        tone,
        message:
          'Some older payouts do not record which events they covered, so they are shown at the organisation level only.',
      };
    case 'DEDUCTION_DETAIL_UNAVAILABLE':
      return {
        tone,
        message:
          'Some older payouts do not record their fee breakdown. The amounts paid are correct; only the breakdown is unavailable.',
      };
    case 'EVIDENCE_DISAGREEMENT':
      return {
        tone,
        message:
          'We found a record whose figures do not add up and are checking it. Nothing has been changed.',
      };
    case 'DOUBLE_CLAIM':
      return {
        tone,
        message: 'An event appears in two payment routes at once. We are checking it.',
      };
    case 'NEEDS_RECONCILIATION':
      return {
        tone,
        message: 'We are still confirming a refund or reversal with the payment provider.',
      };
  }
}

function currencyView(group: FinanceCurrencyGroupDto): FinanceCurrencyView {
  return {
    currency: group.currency,
    // Passed through. Not recomputed, not re-derived from entries.
    entitlementMinor: group.summary.entitlementMinor,
    paidMinor: group.summary.paidMinor,
    pendingMinor: group.summary.pendingMinor,
    attentionMinor: group.summary.attentionMinor,
    /*
      Null rather than 0 where the server omitted it. The server omits these when NO record in
      this currency proves the concept, so a 0 here would be the UI inventing a fact.
    */
    deductedFeesMinor: group.summary.deductedFeesMinor ?? null,
    refundsMinor: group.summary.refundsMinor ?? null,
    movement: group.summary.movement ?? null,
    notices: group.warnings.map(notice),
    entryCount: group.entries.length,
  };
}

/** What the Finance page should show, for each of the four situations it can be in. */
export function financeView(load: FinanceLoad): FinanceView {
  if (load.kind === 'LOADING') {
    return {
      kind: 'LOADING',
      heading: 'Loading your finances',
      explanation: '',
      amountsShown: false,
      currencies: [],
    };
  }

  if (load.kind === 'FAILED') {
    /*
      THE CASE THIS FILE EXISTS FOR. A failed request must never render as a figure. An organizer
      who sees a confident zero has been told their money is gone; an organizer who sees "we could
      not load this" has been told the truth and can retry.
    */
    return {
      kind: 'UNAVAILABLE',
      heading: 'We could not load your finances',
      explanation: 'This is a problem at our end, not a change to your money. Please try again.',
      amountsShown: false,
      currencies: [],
    };
  }

  if (load.data.currencies.length === 0) {
    /*
      Succeeded, and there is genuinely nothing. Distinct from a failure, and still not a zero:
      "no records yet" is a different sentence from "you are owed nothing", and only the first is
      supported by an empty result.
    */
    return {
      kind: 'NO_RECORDS',
      heading: 'No finances yet',
      explanation: 'Once you sell tickets and a payment lands, your money appears here.',
      amountsShown: false,
      currencies: [],
    };
  }

  return {
    kind: 'RECORDS',
    heading: 'Your finances',
    explanation: '',
    amountsShown: true,
    // One section per currency. Never combined - see UnifiedFinanceDto.
    currencies: load.data.currencies.map(currencyView),
  };
}

/**
 * The fee lines of one entry, split by whether they were actually taken out.
 *
 * Exists so a component never has to decide. Summing every line and subtracting it from gross is
 * the plausible-looking mistake: booking and payment fees are borne by the customer on top of the
 * ticket price, so including them understates what the organizer is owed.
 */
export function splitFees(fees: FinanceFeeView[] | undefined): {
  deducted: FinanceFeeView[];
  reported: FinanceFeeView[];
  deductedTotalMinor: number;
} {
  const all = fees ?? [];
  const deducted = all.filter((f) => f.deducted);
  return {
    deducted,
    reported: all.filter((f) => !f.deducted),
    deductedTotalMinor: deducted.reduce((t, f) => t + f.amountMinor, 0),
  };
}

/**
 * One currency's provider-settled figures, ready to render.
 *
 * ── WHY THIS IS NOT IN THE COMPONENT ───────────────────────────────────────────────
 * Every decision worth testing is here: which currencies have a provider route at all, which
 * figures the route can support, and when a dash must appear instead of a number. In JSX none of
 * it is checkable without a renderer this console does not have in its test setup.
 *
 * Nothing is computed. `entitlementMinor` and the movement figures are fields from the certified
 * per-route subtotal, which the server provides precisely so no component adds money up.
 */
export interface ProviderSectionView {
  currency: string;
  /** What these events earned the organizer. Always present on a route that exists. */
  entitlementMinor: number;
  /** Null where the route reports no movement - NOT zero. */
  transferredOutMinor: number | null;
  recoveredMinor: number | null;
  stillOutMinor: number | null;
  /** Refund ACCOUNTING. Null when unproven. Never "money taken back". */
  refundsMinor: number | null;
  notices: FinanceNoticeView[];
}

/**
 * The provider-settled sections, one per currency that has a provider route.
 *
 * Empty when the organization settles entirely through the platform ledger, so a screen can show
 * nothing at all rather than a section full of dashes about a route it does not use.
 *
 * Returns empty for LOADING and FAILED too: those are not "no provider money", and a caller must
 * render its own loading or failure state rather than an absence that looks like an answer.
 */
export function providerSections(load: FinanceLoad): ProviderSectionView[] {
  if (load.kind !== 'LOADED') return [];
  const view = financeView(load);

  return load.data.currencies.flatMap((group) => {
    const provider = group.paths.find((p) => p.path === 'PROVIDER');
    if (provider === undefined) return [];
    return [
      {
        currency: group.currency,
        entitlementMinor: provider.entitlementMinor,
        transferredOutMinor: provider.movement?.transferredOutMinor ?? null,
        recoveredMinor: provider.movement?.recoveredMinor ?? null,
        stillOutMinor: provider.movement?.stillOutMinor ?? null,
        refundsMinor: provider.refundsMinor ?? null,
        notices: view.currencies.find((c) => c.currency === group.currency)?.notices ?? [],
      },
    ];
  });
}
