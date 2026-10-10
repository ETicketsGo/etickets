'use client';

import { useQuery } from '@tanstack/react-query';
import {
  api,
  ErrorState,
  SectionCard,
  Skeleton,
  money,
  moneyFractionDigits,
} from '@eticketsgo/web-kit';
import { providerSections } from '@/lib/finance-view';

/**
 * Money settled through a connected payment provider rather than by us.
 *
 * ── WHY THIS SECTION EXISTS ────────────────────────────────────────────────────────
 * The ladder above comes from `/payouts/summary`, which deliberately excludes any event a
 * provider transfer has claimed - counting it would pay the same revenue twice. Correct, and it
 * left this page telling the organizer their provider money "is not counted anywhere on this
 * page". For an organization settled mainly that way, the figures above understate reality,
 * possibly to zero.
 *
 * `GET /payouts/finance` is the certified read model over BOTH settlement routes, so that money
 * can finally be shown. This section renders only the provider route; the platform route is
 * already above, and showing it twice is the double count the whole contract exists to prevent.
 *
 * ── IT COMPUTES NOTHING ────────────────────────────────────────────────────────────
 * Every figure is a field from the response, including the per-route subtotals - the server
 * provides those precisely so a component never adds money up. Entitlement and movement are kept
 * apart because they answer different questions: what the organizer is owed, versus what actually
 * left, came back, and remains with them.
 *
 * ── ITS OWN LOADING AND FAILURE STATE ──────────────────────────────────────────────
 * A separate query from the ladder above, on purpose. If this request fails the platform figures
 * are still true and still shown; blanking the page because one of two sources is unavailable
 * would hide money we actually have.
 */

/** One figure, or an honest absence. Never a zero standing in for "we do not know". */
function Figure({
  label,
  amountMinor,
  currency,
  hint,
  fractionDigits,
}: {
  label: string;
  amountMinor: number | null;
  currency: string;
  hint: string;
  /** Decided once for the whole section, so the four figures can be read as a column. */
  fractionDigits: number;
}) {
  return (
    <div className="rounded-md border border-border bg-background-surface px-4 py-3">
      <dt className="text-caption font-medium text-text-secondary">{label}</dt>
      <dd className="mt-1">
        <span className="font-display text-title font-bold tabular-nums text-text-primary">
          {/*
            Null means the route does not report this concept - not that it is zero. A dash says
            so; a currency figure would state something the server declined to.
          */}
          {amountMinor === null ? '—' : money(amountMinor, currency, undefined, fractionDigits)}
        </span>
        <span className="mt-0.5 block text-caption font-normal text-text-muted">{hint}</span>
      </dd>
    </div>
  );
}

export function ProviderSettled({ organizationId }: { organizationId: string }) {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['organizer', 'unified-finance', organizationId],
    queryFn: () => api.payouts.finance(organizationId),
  });

  if (isLoading) return <Skeleton className="h-40 w-full" />;

  if (isError) {
    return (
      <ErrorState
        message="We couldn't read the money settled by your payment provider. Nothing about your money has changed."
        onRetry={() => void refetch()}
      />
    );
  }

  /*
    Every decision - which currencies have a provider route, which figures it can support, when a
    dash must appear - lives in `providerSections` so it is testable without a renderer.
  */
  const sections = providerSections({ kind: 'LOADED', data: data! });
  if (sections.length === 0) return null;

  return (
    <SectionCard
      title="Settled by your payment provider"
      description="Your provider pays this money to you directly, so it is not part of the figures above."
    >
      <div className="space-y-5">
        {sections.map((section) => {
          /*
            One decimal shape for everything this section shows, including the refund line below.
            Per-amount formatting put ₹832.50 next to ₹710 in the same four-up grid - figures
            meant to be compared, rendered as if they had different precision. `money` takes the
            override for exactly this reason; see `moneyFractionDigits`.
          */
          const fractionDigits = moneyFractionDigits(
            [
              section.entitlementMinor,
              section.transferredOutMinor,
              section.recoveredMinor,
              section.stillOutMinor,
              section.refundsMinor,
            ],
            section.currency,
          );
          return (
            <section key={section.currency} aria-labelledby={`provider-${section.currency}`}>
              <h3
                id={`provider-${section.currency}`}
                className="mb-2 text-micro font-semibold uppercase tracking-[0.08em] text-text-muted"
              >
                {section.currency}
              </h3>

              <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Figure
                  label="Yours from these events"
                  amountMinor={section.entitlementMinor}
                  currency={section.currency}
                  hint="What these events earned you, after your provider's fees."
                  fractionDigits={fractionDigits}
                />
                <Figure
                  label="Sent to you"
                  amountMinor={section.transferredOutMinor}
                  currency={section.currency}
                  hint="Paid out by your provider."
                  fractionDigits={fractionDigits}
                />
                <Figure
                  label="Taken back"
                  amountMinor={section.recoveredMinor}
                  currency={section.currency}
                  hint="Returned to us after a refund or a correction."
                  fractionDigits={fractionDigits}
                />
                <Figure
                  label="Still with you"
                  amountMinor={section.stillOutMinor}
                  currency={section.currency}
                  hint="Sent and not taken back."
                  fractionDigits={fractionDigits}
                />
              </dl>

              {/*
              Refund accounting is shown apart from "taken back" on purpose. A refund can be
              recorded while no money has moved at all, and presenting them as one number would
              tell the organizer money left when it has not.
            */}
              {section.refundsMinor !== null && (
                <p className="mt-2 text-caption text-text-secondary">
                  Refunds recorded against these events:{' '}
                  <span className="font-medium tabular-nums text-text-primary">
                    {money(section.refundsMinor, section.currency, undefined, fractionDigits)}
                  </span>
                  . This is the refund total, not money already taken back from you.
                </p>
              )}
            </section>
          );
        })}
      </div>
    </SectionCard>
  );
}
