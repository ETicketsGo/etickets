'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Banknote,
  CalendarClock,
  Clock,
  Info,
  Percent,
  ReceiptText,
  Ticket,
  Undo2,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import {
  api,
  ButtonLink,
  DataTable,
  ErrorState,
  IconTile,
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
 * ── THE SAME WORDS AS THE DASHBOARD ────────────────────────────────────────────────
 * Gross sales, fees, refunds and what is left lead each currency in that order, in the
 * dashboard's words, so an organizer reading both screens is not left wondering whether "gross
 * ticket value" and "gross sales" are two different things. Here they cover the money the payout
 * ledger is settling, which the caption on each figure says.
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
  { key: 'gross', label: 'Gross sales' },
  { key: 'discount', label: 'Less discounts', negative: true },
  { key: 'organizerFee', label: 'Less your platform fee', negative: true },
  { key: 'refund', label: 'Less refunds', negative: true },
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

function CurrencyBlock({ row }: { row: PayoutSummaryCurrency }) {
  const where: { label: string; value: number; hint: string; icon: LucideIcon; tile: TileTone }[] =
    [
      {
        label: 'Paid',
        value: row.paid,
        hint: 'Already sent to you.',
        icon: Banknote,
        tile: 'teal',
      },
      {
        label: 'Pending',
        value: row.pending,
        hint: 'Raised, not yet sent.',
        icon: Clock,
        tile: 'blue',
      },
      {
        label: 'Held',
        value: row.held,
        hint: 'Not payable until the show has finished.',
        icon: CalendarClock,
        tile: 'amber',
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

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Gross sales"
          value={money(row.gross, row.currency)}
          icon={Ticket}
          tile="blue"
          hint="Ticket value in these figures"
        />
        <StatCard
          label="Your fees"
          value={<Amount value={row.organizerFee} currency={row.currency} negative />}
          icon={Percent}
          tile="purple"
          hint="Your platform fee"
        />
        <StatCard
          label="Refunds"
          value={<Amount value={row.refund} currency={row.currency} negative />}
          icon={Undo2}
          tile="rose"
          hint="Returned to buyers"
        />
        <StatCard
          label="Ready to pay out now"
          value={money(row.net, row.currency)}
          icon={Wallet}
          tile="teal"
          hint="What a payout raised today would come to"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <SectionCard
          title="How it adds up"
          description="From the payout ledger, in the order amounts come off."
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
            ── WHY THIS SENTENCE IS HERE ──────────────────────────────────────────────────
            Browser QA showed the real failure mode of the old label. The ladder read "Your net 0"
            directly above "Pending 1,598" and "Held 4,596" - every figure correct, and the page
            appearing to say the organizer has nothing while naming two amounts they do have.

            The endpoint answers "what would a payout raised right now come to", so a zero means
            everything is ALREADY raised or still held, not that there is no money. The heading
            says which question it answers, and this line says where the rest of it went.
          */}
          <p className="mt-3 text-caption text-text-muted">
            What a payout raised today would come to. Money already raised, or still held until a
            show finishes, is under &quot;Where the rest is&quot; rather than here.
          </p>

          <h4 className="mb-2 mt-5 text-caption font-semibold text-text-secondary">
            Paid by the buyer, not taken from you
          </h4>
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

        <SectionCard title="Where the rest is" headingLevel={3}>
          <ul className="grid gap-3 md:grid-cols-3 xl:grid-cols-1">
            {where.map((b) => (
              <li
                key={b.label}
                className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-3"
              >
                <IconTile icon={b.icon} tone={b.tile} />
                <div className="min-w-[8rem] flex-1">
                  <p className="text-ui font-medium text-text-primary">{b.label}</p>
                  <p className="text-caption text-text-muted">{b.hint}</p>
                </div>
                <p className="ml-auto shrink-0 font-display text-title font-bold tabular-nums text-text-primary">
                  {money(b.value, row.currency)}
                </p>
              </li>
            ))}
          </ul>
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
    header: 'Gross sales',
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
