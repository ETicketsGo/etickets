'use client';

import { useQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import {
  api,
  ButtonLink,
  Card,
  ErrorState,
  PageHeader,
  Skeleton,
  money,
  dateOnly,
  type PayoutSummaryCurrency,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import { ProviderSettled } from './provider-settled';
import { FinanceNotices } from './finance-notices';

/**
 * Where this organizer's money is, in one place.
 *
 * ── WHY THIS PAGE EXISTS ───────────────────────────────────────────────────────────
 * Money was in four places - Payouts, Receipts, Refunds and a revenue panel on the dashboard -
 * and none of them answered the question an organizer actually asks at month end: what came in,
 * what came off it, what is owed to me, and what has been paid. Each screen answered a fragment,
 * and none of them added up to the others.
 *
 * ── WHERE THE NUMBERS COME FROM ────────────────────────────────────────────────────
 * One endpoint, `GET /payouts/summary`, which runs the payout ledger's OWN eligibility rules and
 * the one settlement calculation. Nothing on this page is computed in the browser, so a finance
 * screen and the payout the ledger would actually raise cannot disagree - which is the failure
 * this whole programme has been avoiding.
 *
 * ── WHAT IT DELIBERATELY DOES NOT SHOW ─────────────────────────────────────────────
 *   Tax. `Receipt.taxMinor` is buyer-side and its relationship to organizer proceeds is not
 *   modelled. In an inclusive-tax market like India it is not deducted from what the organizer
 *   is owed, so putting it in this ladder would state something false.
 *
 *   A promised next-payout date. The hold period and `payableFrom` say when revenue becomes
 *   ELIGIBLE; they do not say when a payout run happens. A date somebody plans around has to be
 *   a date, not an inference.
 *
 *   Provider-transfer money IN THE LADDER. Events settled through a connected provider are
 *   excluded from every figure the ladder shows, correctly - counting them would pay the same
 *   revenue twice. That money is no longer missing from the page: `ProviderSettled` below reads
 *   `GET /payouts/finance`, the certified read model over both settlement routes, and shows the
 *   provider route on its own. The two are never added together here, which is the double count
 *   that contract exists to prevent.
 */
const LADDER: { key: keyof PayoutSummaryCurrency; label: string; negative?: boolean }[] = [
  { key: 'gross', label: 'Gross ticket value' },
  { key: 'discount', label: 'Discounts', negative: true },
  { key: 'bookingFee', label: 'Booking fees' },
  { key: 'paymentFee', label: 'Payment fees' },
  { key: 'organizerFee', label: 'Your platform fee', negative: true },
  { key: 'refund', label: 'Refunds', negative: true },
];

function CurrencyCard({ row }: { row: PayoutSummaryCurrency }) {
  return (
    <Card title={`${row.currency}`}>
      {/*
        ── THE SCOPE, SAID BEFORE THE FIGURES, NOT AFTER ──────────────────────────────────
        Every row below counts only revenue that is PAYABLE NOW. The calculation is unchanged
        and correct; the presentation was not. An organizer holding money still inside the
        hold period read "Gross ticket value Rs 0" at the top of their finance page, which on
        its face says they have earned nothing - while their per-event Reports page showed
        real sales for the same events. Two screens appearing to contradict each other, when
        in fact they answer different questions.

        The scope now leads. The sentence that used to sit under "Ready to pay out now",
        explaining the exclusion, applied to the whole ladder all along - it was just placed
        where it read as a footnote to the last line.
      */}
      <div className="mb-3 border-b border-border pb-3">
        <p className="text-sm font-semibold text-text-primary">Ready to pay out now</p>
        <p className="mt-1 text-caption text-text-muted">
          How this figure is made up. It counts only money that is payable today - not money already
          sent to you, and not money still held until a show finishes. Those are in the three boxes
          below, and your per-event reports show each event&apos;s own sales in full.
        </p>
      </div>
      <dl className="divide-y divide-border">
        {LADDER.map(({ key, label, negative }) => (
          <div key={key} className="flex items-baseline justify-between gap-4 py-2">
            <dt className="text-sm text-text-secondary">
              {label}
              {/*
                Booking and payment fees are shown and NOT deducted, which is correct rather than
                an oversight: the gross is the ticket value net to the organizer and those two are
                borne by the customer on top of it. Said here so nobody reads the column and
                assumes the arithmetic is wrong.
              */}
              {(key === 'bookingFee' || key === 'paymentFee') && (
                <span className="ml-2 text-caption text-text-muted">paid by the buyer</span>
              )}
            </dt>
            <dd className="font-medium tabular-nums text-text-primary">
              {negative && row[key] !== 0 ? '−' : ''}
              {money(Math.abs(row[key] as number), row.currency)}
            </dd>
          </div>
        ))}
        <div className="flex items-baseline justify-between gap-4 py-3">
          <dt className="font-semibold text-text-primary">Ready to pay out now</dt>
          <dd className="text-lg font-semibold tabular-nums text-text-primary">
            {money(row.net, row.currency)}
          </dd>
        </div>
      </dl>

      {/*
        ── WHY THIS SENTENCE IS HERE ──────────────────────────────────────────────────
        Browser QA showed the real failure mode of the old label. The ladder read "Your net 0"
        directly above "Pending 1,598" and "Held 4,596" - every figure correct, and the page
        appearing to say the organizer has nothing while naming two amounts they do have.

        The endpoint answers "what would a payout raised right now come to", so a zero means
        everything is ALREADY raised or still held, not that there is no money. The heading now
        says which question it answers, and this line says where the rest of it went.
      */}
      <p className="mt-2 text-caption text-text-muted">
        The total of the lines above: what a payout raised today would come to.
      </p>

      <dl className="mt-3 grid gap-2 sm:grid-cols-3">
        {[
          { label: 'Paid', value: row.paid, hint: 'Already sent to you.' },
          { label: 'Pending', value: row.pending, hint: 'Raised, not yet sent.' },
          { label: 'Held', value: row.held, hint: 'Not payable until the show has finished.' },
        ].map((b) => (
          <div key={b.label} className="rounded-md border border-border px-3 py-2">
            <dt className="text-caption text-text-muted">{b.label}</dt>
            {/*
              The hint lives INSIDE the dd. A `p` as a direct child of a definition list's group
              is invalid, and axe flagged it serious - a screen reader meets a paragraph where it
              expects a description.
            */}
            <dd className="mt-0.5">
              <span className="font-medium tabular-nums text-text-primary">
                {money(b.value, row.currency)}
              </span>
              <span className="mt-0.5 block text-caption font-normal text-text-muted">
                {b.hint}
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

export default function FinancePage() {
  const { activeOrg, activeOrgSentenceName } = useOrg();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['organizer', 'payout-summary', activeOrg.id],
    queryFn: () => api.payouts.summary(activeOrg.id),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Finance"
        description={`What ${activeOrgSentenceName} has earned, what has been paid, and what is still to come.`}
      />

      {isLoading && <Skeleton className="h-64 w-full" />}

      {/*
        A failure is not a financial state. Showing an empty ladder because a request failed
        would be a reassuring lie about money.
      */}
      {isError && !isLoading && (
        <ErrorState
          message="We couldn't read your finance figures. Nothing about your money has changed."
          onRetry={() => void refetch()}
        />
      )}

      {data && !isLoading && (
        <>
          {/*
            Said before the numbers, not after, because for an organization settled through a
            connected provider these totals understate reality - possibly to zero.
          */}
          {data.excluded.providerSettledEvents > 0 && (
            <Card className="border-status-warning/30">
              <div className="flex items-start gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-tint-warning text-status-warning">
                  <Info className="h-4 w-4" aria-hidden />
                </span>
                <p className="text-sm text-text-secondary">
                  <span className="font-medium text-text-primary">
                    {data.excluded.providerSettledEvents === 1
                      ? 'One event is settled through your connected payment provider'
                      : `${data.excluded.providerSettledEvents} events are settled through your connected payment provider`}
                    .
                  </span>{' '}
                  That money is paid to you by the provider directly, so these figures are lower
                  than your full position. It is shown separately below.
                </p>
              </div>
            </Card>
          )}

          {data.currencies.length === 0 ? (
            <Card>
              <p className="text-sm text-text-secondary">
                Nothing has been sold yet, so there is nothing to settle.{' '}
                <span className="text-text-muted">
                  Figures appear here once an event has finished and its holding period has passed.
                </span>
              </p>
            </Card>
          ) : (
            /*
              One card per currency, never a combined total. A rupee and a dollar do not add up,
              and a dashboard that summed them was a real defect in this product once.
            */
            <div className="grid gap-4 lg:grid-cols-2">
              {data.currencies.map((row) => (
                <CurrencyCard key={row.currency} row={row} />
              ))}
            </div>
          )}

          {/*
            Its own query and its own failure state. If the provider read fails the platform
            figures above are still true, and blanking the page would hide money we do have.
          */}
          <ProviderSettled organizationId={activeOrg.id} />

          {/*
            Limitations of the records behind EVERY figure above, not just the provider ones, so
            they are shown once and outside any route-specific card. They used to live inside the
            provider section, where an organization with no provider route never saw them at all.
          */}
          <FinanceNotices organizationId={activeOrg.id} />

          {data.heldRevenue.length > 0 && (
            <Card title="Held until the show has finished">
              <p className="-mt-2 mb-3 text-caption text-text-secondary">
                An event&rsquo;s revenue becomes payable once it has finished and its holding period
                of {data.holdDays} day{data.holdDays === 1 ? '' : 's'} has passed.
              </p>
              <ul className="divide-y divide-border">
                {data.heldRevenue.map((h) => (
                  <li
                    key={`${h.eventId}-${h.currency}`}
                    className="flex flex-wrap items-baseline justify-between gap-2 py-2"
                  >
                    <span className="text-sm text-text-primary">{h.eventTitle}</span>
                    <span className="text-sm text-text-muted">
                      {money(h.grossMinor, h.currency)} &middot; payable from{' '}
                      {dateOnly(h.payableFrom)}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <div className="flex flex-wrap gap-2">
            <ButtonLink href="/organizer/payouts" variant="outline">
              Payouts
            </ButtonLink>
            <ButtonLink href="/organizer/receipts" variant="outline">
              Receipts
            </ButtonLink>
            <ButtonLink href="/organizer/refunds" variant="outline">
              Refunds
            </ButtonLink>
          </div>
        </>
      )}
    </div>
  );
}
