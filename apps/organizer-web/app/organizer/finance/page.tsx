'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  Banknote,
  CalendarClock,
  Clock,
  Info,
  ReceiptText,
  Undo2,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import {
  api,
  ButtonLink,
  DataTable,
  ErrorState,
  MARKETS,
  PageHeader,
  SectionCard,
  Skeleton,
  StatCard,
  money,
  dateOnly,
  type Column,
  type PayoutSummary,
  type PayoutSummaryCurrency,
  type TileTone,
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
 * ── NOT THE OVERVIEW'S SALES ───────────────────────────────────────────────────────
 * The Overview shows what was SOLD. This page follows that money through the payout ledger -
 * held, payable, in a payout, paid - so no figure here is labelled "Gross sales": the same words
 * over a different quantity read as a contradiction. Neither endpoint returns a total sold, and
 * none is computed here; the page points to the Overview for it instead.
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
  { key: 'gross', label: 'Gross from shows ready to pay out' },
  { key: 'discount', label: 'Less discounts', negative: true },
  { key: 'organizerFee', label: 'Less your platform fee', negative: true },
  { key: 'refund', label: 'Less refunds on these shows', negative: true },
];

/*
  Booking and payment fees are shown and NOT deducted, which is correct rather than an oversight:
  the gross is the ticket value net to the organizer and those two are borne by the customer on
  top of it. They sit in their own group, under a heading that says so, so nobody reads the
  column and assumes the arithmetic is wrong.
*/
const BUYER_FEES: { key: keyof PayoutSummaryCurrency; label: string }[] = [
  { key: 'bookingFee', label: 'Booking fees' },
  { key: 'paymentFee', label: 'Payment fees' },
];

/** "India - INR", from the market list, so a block names its market and not only its unit. */
function currencyTitle(currency: string): string {
  const names = MARKETS.filter((m) => m.currency === currency).map((m) => m.name);
  return names.length ? `${names.join(' / ')} - ${currency}` : currency;
}

/** An amount that comes off, written "- ₹55.82". Zero is never given a sign. */
function Amount({
  value,
  currency,
  negative,
}: {
  value: number;
  currency: string;
  negative?: boolean;
}) {
  return (
    <>
      {negative && value !== 0 ? '- ' : ''}
      {money(Math.abs(value), currency)}
    </>
  );
}

/*
  ── FOUR STAGES, NOT FOUR PARTS OF ONE TOTAL ─────────────────────────────────────
  Review caught the defect this layout replaces: the page led with "Gross sales ₹0" beside an
  Overview reading "Gross sales ₹19,787" and, lower down, "Held ₹20,187". Every number was right.
  `gross` here is not the organizer's sales: it is the gross of shows that have finished, passed
  the holding period and are NOT yet in a payout - the one input of the next payout. With the
  dashboard's label it read as a contradiction.

  So each currency now leads with where its money stands, in the order it moves (see the
  `PayoutSummaryCurrency` field docs in the payouts service):
    held     - ticket sales of shows not yet payable (gross, before fees and refunds)
    net      - payable now and not in a payout yet (after fees and refunds)
    pending  - in a payout that has not been sent (that payout's net)
    paid     - in a payout that has been sent (that payout's net)
  They are four separate buckets of the ledger, shown side by side and never added up here: held
  is a gross and the other three are nets, so a sum would mix the two.
*/
function CurrencyBlock({ row }: { row: PayoutSummaryCurrency }) {
  const stages: {
    label: string;
    value: number;
    hint: string;
    icon: LucideIcon;
    tile: TileTone;
  }[] = [
    {
      label: 'Held until shows finish',
      value: row.held,
      hint: 'Ticket sales, before fees and refunds. Not payable yet.',
      icon: CalendarClock,
      tile: 'amber',
    },
    {
      label: 'Ready to pay out now',
      value: row.net,
      hint: 'Payable, not in a payout yet. After fees and refunds.',
      icon: Wallet,
      tile: 'teal',
    },
    {
      label: 'In a payout, not sent',
      value: row.pending,
      hint: 'Raised and on its way to you.',
      icon: Clock,
      tile: 'blue',
    },
    {
      label: 'Paid to you',
      value: row.paid,
      hint: 'Payouts already sent.',
      icon: Banknote,
      tile: 'purple',
    },
  ];

  return (
    <section aria-labelledby={`finance-${row.currency}`} className="space-y-4">
      <h2
        id={`finance-${row.currency}`}
        className="flex items-center gap-2 text-micro font-semibold uppercase tracking-[0.08em] text-text-muted"
      >
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-action-primary" />
        {currencyTitle(row.currency)}
      </h2>

      <ol className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Where this money is">
        {stages.map((s) => (
          <li key={s.label} className="min-w-0">
            <StatCard
              label={s.label}
              value={money(s.value, row.currency)}
              icon={s.icon}
              tile={s.tile}
              hint={s.hint}
            />
          </li>
        ))}
      </ol>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <SectionCard
          title="How 'Ready to pay out now' is worked out"
          description="Only shows that have finished and passed the holding period, and are not in a payout yet."
          headingLevel={3}
        >
          <dl className="divide-y divide-border rounded-md border border-border text-ui">
            {LADDER.map(({ key, label, negative }) => (
              <div key={key} className="flex items-baseline justify-between gap-4 px-4 py-2.5">
                <dt className="text-text-secondary">{label}</dt>
                <dd className="tabular-nums text-text-primary">
                  <Amount value={row[key] as number} currency={row.currency} negative={negative} />
                </dd>
              </div>
            ))}
            <div className="flex items-baseline justify-between gap-4 rounded-b-md bg-background-subtle px-4 py-3">
              <dt className="font-semibold text-text-primary">Ready to pay out now</dt>
              <dd className="font-display text-title font-bold tabular-nums text-text-primary">
                {money(row.net, row.currency)}
              </dd>
            </div>
          </dl>

          {/*
            A zero here means everything is ALREADY in a payout or still held, not that there is
            no money - browser QA once showed "Your net 0" above "Pending 1,598" and "Held 4,596".
            This line says where the rest went.
          */}
          <p className="mt-3 text-caption text-text-muted">
            Money from shows that have not finished is under &quot;Held until shows finish&quot;.
            Money already in a payout is under &quot;In a payout, not sent&quot; or &quot;Paid to
            you&quot;.
          </p>
        </SectionCard>

        <SectionCard
          title="Paid by the buyer, not taken from you"
          description="Charged on top of the ticket price for the same shows. Not deducted above."
          headingLevel={3}
        >
          <dl className="divide-y divide-border rounded-md border border-border text-ui">
            {BUYER_FEES.map(({ key, label }) => (
              <div key={key} className="flex items-baseline justify-between gap-4 px-4 py-2.5">
                <dt className="text-text-secondary">{label}</dt>
                <dd className="tabular-nums text-text-primary">
                  {money(row[key] as number, row.currency)}
                </dd>
              </div>
            ))}
          </dl>
        </SectionCard>
      </div>
    </section>
  );
}

type HeldRow = PayoutSummary['heldRevenue'][number];

const HELD_COLUMNS: Column<HeldRow>[] = [
  {
    key: 'event',
    header: 'Event',
    render: (h) => <span className="font-medium">{h.eventTitle}</span>,
  },
  {
    key: 'gross',
    header: 'Ticket sales',
    className: 'whitespace-nowrap tabular-nums',
    render: (h) => money(h.grossMinor, h.currency),
  },
  {
    key: 'from',
    header: 'Payable from',
    className: 'whitespace-nowrap tabular-nums',
    render: (h) => dateOnly(h.payableFrom),
    sortable: true,
    sortValue: (h) => h.payableFrom,
  },
];

export default function FinancePage() {
  const { activeOrg, activeOrgSentenceName } = useOrg();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['organizer', 'payout-summary', activeOrg.id],
    queryFn: () => api.payouts.summary(activeOrg.id),
  });

  return (
    <div className="space-y-8">
      <PageHeader
        title="Finance"
        description={`What ${activeOrgSentenceName} has earned, what has been paid, and what is still to come.`}
        action={
          <nav aria-label="Finance pages" className="flex flex-wrap gap-2">
            <ButtonLink href="/organizer/payouts" variant="outline" size="sm" icon={Banknote}>
              Payouts
            </ButtonLink>
            <ButtonLink href="/organizer/receipts" variant="outline" size="sm" icon={ReceiptText}>
              Receipts
            </ButtonLink>
            <ButtonLink href="/organizer/refunds" variant="outline" size="sm" icon={Undo2}>
              Refunds
            </ButtonLink>
          </nav>
        }
      />

      {/*
        The bridge to the Overview, said before any figure: the Overview counts what was sold, and
        this page follows that same money through the ledger. Without it the two screens read as
        disagreeing about one number.
      */}
      <p className="-mt-4 rounded-lg border border-border bg-background-surface px-4 py-3 text-ui text-text-secondary">
        <span className="font-semibold text-text-primary">Sales so far:</span> see{' '}
        <Link
          href="/organizer"
          className="rounded-sm font-semibold text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Overview
        </Link>
        . This page follows that money from held, to payable, to paid.
      </p>

      {isLoading && (
        <div className="space-y-4" role="status" aria-busy="true" aria-label="Loading finance">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-28 w-full" />
            ))}
          </div>
          <Skeleton className="h-64 w-full" />
        </div>
      )}

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
            <div
              role="note"
              className="flex items-start gap-3 rounded-lg border border-border bg-tint-warning p-4"
            >
              <Info className="mt-0.5 h-5 w-5 shrink-0 text-status-warning" aria-hidden />
              <p className="text-ui text-text-secondary">
                <span className="font-semibold text-text-primary">
                  {data.excluded.providerSettledEvents === 1
                    ? 'One event is settled through your connected payment provider'
                    : `${data.excluded.providerSettledEvents} events are settled through your connected payment provider`}
                  .
                </span>{' '}
                That money is paid to you by the provider directly, so these figures are lower than
                your full position. It is shown separately below.
              </p>
            </div>
          )}

          {data.currencies.length === 0 ? (
            <SectionCard title="Nothing to settle yet">
              <p className="text-ui text-text-secondary">
                Nothing has been sold yet, so there is nothing to settle.{' '}
                <span className="text-text-muted">
                  Figures appear here once an event has finished and its holding period has passed.
                </span>
              </p>
            </SectionCard>
          ) : (
            /*
              One block per currency, never a combined total. A rupee and a dollar do not add up,
              and a dashboard that summed them was a real defect in this product once.
            */
            <div className="space-y-10">
              {data.currencies.map((row) => (
                <CurrencyBlock key={row.currency} row={row} />
              ))}
            </div>
          )}

          {data.heldRevenue.length > 0 && (
            <SectionCard
              title="Held until the show has finished"
              description={`An event's revenue becomes payable once it has finished and its holding period of ${data.holdDays} day${data.holdDays === 1 ? '' : 's'} has passed.`}
            >
              <DataTable
                caption="Revenue held until the show has finished"
                columns={HELD_COLUMNS}
                rows={data.heldRevenue}
                rowKey={(h) => `${h.eventId}-${h.currency}`}
                density="compact"
                // Three short columns read fine as a table on a phone; as cards, a busy season of
                // held events became a page several screens long.
                stickyHeader
              />
            </SectionCard>
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
        </>
      )}
    </div>
  );
}
