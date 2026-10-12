'use client';

import { MARKETS, SectionLink, money } from '@eticketsgo/web-kit';
import type { MoneyPanel } from './overview-model';

/** "India - INR": the market named by its country, so a panel says where, not only which unit. */
export function marketTitle(currency: string, country?: string | null): string {
  const byCountry = country ? MARKETS.find((m) => m.code === country)?.name : undefined;
  const names = byCountry
    ? [byCountry]
    : MARKETS.filter((m) => m.currency === currency).map((m) => m.name);
  return names.length ? `${names.join(' / ')} - ${currency}` : currency;
}

/**
 * Sales and proceeds for ONE currency, in one panel, as two separate groups.
 *
 * ── TWO QUESTIONS, NEVER ONE BLENDED ROW ───────────────────────────────────────────
 * "What did I sell, and what is mine of it" is the analytics: gross ticket sales, less the fees
 * taken from the organizer, less refunds, is the proceeds. "Where is that money" is the payout
 * ledger: held until the shows finish, payable now, in a payout, paid. They are separate
 * measures (held is a gross, the other three are nets), so they sit side by side and are never
 * added to each other. Proceeds are what was earned; they are NOT said to be payable - only the
 * ledger says what is.
 *
 * Fees the buyer paid on top of the ticket price are shown on their own line and are not part of
 * the proceeds. Nothing is computed here: every figure is the API's.
 */
export function MoneyPanelCard({
  panel,
  excludedProviderEvents,
  showFinanceLink,
}: {
  panel: MoneyPanel;
  /** Events that settle through a connected provider; the ledger leaves them out by design. */
  excludedProviderEvents: number;
  showFinanceLink: boolean;
}) {
  const fmt = (minor: number) => money(minor, panel.currency);
  const { sales, payout } = panel;
  const headingId = `money-${panel.currency}`;
  const stages: { label: string; hint: string; value: number; dot: string }[] = payout
    ? [
        {
          label: 'Held',
          hint: 'shows not finished',
          value: payout.heldMinor,
          dot: 'bg-status-warning',
        },
        {
          label: 'Payable now',
          hint: 'not in a payout yet',
          value: payout.payableMinor,
          dot: 'bg-action-primary',
        },
        {
          label: 'In a payout',
          hint: 'raised, not sent',
          value: payout.inPayoutMinor,
          dot: 'bg-status-info',
        },
        {
          label: 'Paid',
          hint: 'sent to you',
          value: payout.paidMinor,
          dot: 'bg-text-muted',
        },
      ]
    : [];
  return (
    <section
      aria-labelledby={headingId}
      className="min-w-0 overflow-hidden rounded-lg border border-border bg-background-surface shadow-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border px-4 py-2.5">
        <h2 id={headingId} className="font-display text-ui font-bold text-text-primary">
          Sales and proceeds
          <span className="ml-2 text-caption font-semibold text-text-muted">
            {marketTitle(panel.currency)}
          </span>
        </h2>
        {showFinanceLink && (
          <SectionLink href="/organizer/finance" srLabel="finance">
            Finance
          </SectionLink>
        )}
      </div>
      <div className="grid gap-px bg-border md:grid-cols-2">
        <div className="bg-background-surface p-4">
          <h3 className="text-micro font-semibold uppercase tracking-[0.08em] text-text-muted">
            What you sold
          </h3>
          <dl className="mt-2 text-ui">
            <div className="flex items-baseline justify-between gap-3 py-1.5">
              <dt className="text-text-secondary">Gross ticket sales</dt>
              <dd className="tabular-nums text-text-primary">{fmt(sales.grossMinor)}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3 py-1.5">
              <dt className="text-text-secondary">Less your fees</dt>
              <dd className="whitespace-nowrap tabular-nums text-text-primary">
                {sales.organizerFeesMinor !== 0 ? '- ' : ''}
                {fmt(sales.organizerFeesMinor)}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3 py-1.5">
              <dt className="text-text-secondary">Less refunds</dt>
              <dd className="whitespace-nowrap tabular-nums text-text-primary">
                {sales.refundsMinor !== 0 ? '- ' : ''}
                {fmt(sales.refundsMinor)}
              </dd>
            </div>
            <div className="mt-1 flex items-baseline justify-between gap-3 rounded-md bg-tint-primary px-3 py-2 font-semibold">
              <dt className="text-text-primary">Your proceeds</dt>
              <dd className="font-display tabular-nums text-text-primary">
                {fmt(sales.proceedsMinor)}
              </dd>
            </div>
          </dl>
          <p className="mt-2 text-micro text-text-muted">
            Buyer-paid fees, on top of the ticket price:{' '}
            <span className="tabular-nums">{fmt(sales.buyerFeesMinor)}</span>. They are not part of
            your proceeds.
          </p>
        </div>
        <div className="bg-background-surface p-4">
          <h3 className="text-micro font-semibold uppercase tracking-[0.08em] text-text-muted">
            Where the money is
          </h3>
          {payout ? (
            <>
              <dl className="mt-2 text-ui">
                {stages.map((s) => (
                  <div key={s.label} className="flex items-baseline justify-between gap-3 py-1.5">
                    <dt className="flex min-w-0 items-center gap-2 text-text-secondary">
                      <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${s.dot}`} />
                      <span className="min-w-0">
                        {s.label}
                        <span className="ml-1.5 text-micro text-text-muted">{s.hint}</span>
                      </span>
                    </dt>
                    <dd className="shrink-0 font-semibold tabular-nums text-text-primary">
                      {fmt(s.value)}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="mt-2 text-micro text-text-muted">
                From the payout ledger. Held is before fees and refunds, the rest after them. These
                are separate stages, not parts of your proceeds.
                {excludedProviderEvents > 0
                  ? ` ${excludedProviderEvents} ${excludedProviderEvents === 1 ? 'event is' : 'events are'} paid through a connected provider and shown on the Finance page.`
                  : ''}
              </p>
            </>
          ) : (
            <p className="mt-2 text-caption text-text-muted">
              Payout figures are not available for your role.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
