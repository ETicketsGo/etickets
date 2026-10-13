'use client';

import { RefreshCcw } from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * What the organizer has promised about refunds, shown on the payment screen.
 *
 * The screen carried a "Refundable per policy" tile and nothing else: the policy itself sat
 * on the event page, one step back, and for an event with refunds switched off the tile still
 * said "Refundable". Buyers decide whether to pay on this screen, so the terms are here, in
 * the organizer's own words when they wrote some, and as a plain rule when they did not.
 *
 * Drawn on the brand layer: Review & pay, its only caller, sits inside data-brand="customer".
 */
export function RefundTerms({
  refundsEnabled,
  refundCutoffHours,
  refundPolicy,
}: {
  refundsEnabled?: boolean;
  refundCutoffHours?: number;
  refundPolicy?: string | null;
}) {
  const k = useTranslations('storefront.checkout');
  // An older API sends none of these; showing a rule we cannot vouch for would be worse than
  // showing nothing.
  if (refundsEnabled === undefined && !refundPolicy) return null;
  const rule =
    refundsEnabled === false
      ? k('refundNone')
      : refundCutoffHours === undefined
        ? null
        : refundCutoffHours === 0
          ? k('refundUntilStart')
          : k('refundCutoff', { hours: refundCutoffHours });
  return (
    <section
      aria-labelledby="refund-terms-heading"
      data-testid="refund-terms"
      className="rounded-brand-card border border-brand-line bg-brand-surface p-4 text-left"
    >
      <h3
        id="refund-terms-heading"
        className="flex items-center gap-2 text-brand-ui font-semibold text-brand-ink"
      >
        <RefreshCcw className="h-4 w-4 text-brand-ink-3" aria-hidden="true" />
        {k('refundTermsHeading')}
      </h3>
      {rule && <p className="mt-1 text-brand-ui text-brand-ink-2">{rule}</p>}
      {refundPolicy && <p className="mt-1 text-brand-meta text-brand-ink-3">{refundPolicy}</p>}
    </section>
  );
}
