'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  Card,
  PageHeader,
  ButtonLink,
  DataTable,
  money,
  MARKETS,
  type Column,
  type FeeRule,
} from '@eticketsgo/web-kit';
import { NO_READ_ACCESS, READ_ONLY_NOTE, useConfigAccess } from '@/lib/capabilities';
import { bandName, bandPlace, bandStatus, describeCharge } from '@/lib/fee-bands';

/**
 * A readable name for each market currency. Editing never changes a rule's currency.
 *
 * Built from MARKETS rather than listed by hand: the hand-written list had four currencies, so
 * the other markets had no name here - and no way to add their first band either.
 */
const CURRENCY_LABELS: Record<string, string> = Object.fromEntries(
  MARKETS.map((m) => [m.currency, `${m.name} (${m.currency})`]),
);

export default function AdminSettings() {
  // Deleted bands price nothing and are hidden unless an admin asks to see them.
  const [showDeleted, setShowDeleted] = useState(false);
  /*
    The page opens with PLATFORM_CONFIG_READ; changing a schedule needs PLATFORM_CONFIG.

    ── CHANGED AS A DRAFT, NOT ONE BAND AT A TIME ───────────────────────────────────
    Bands used to be edited and deleted here one by one, each change checked against the live
    schedule. A reorganisation could not be done that way (every intermediate step was a gap or
    an overlap), each refused attempt stacked another error, and amounts were typed in minor
    units. Changes now go through a draft of the whole schedule (`/admin/settings/schedule`),
    checked as a whole and published in one step.
  */
  const access = useConfigAccess();
  const mayEdit = access.mayEdit;

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'fee-rules', { showDeleted }],
    queryFn: () => api.admin.feeRules({ includeDeleted: showDeleted }),
    enabled: access.mayRead,
  });

  const allColumns = (currency: string): Column<FeeRule>[] => [
    // Written from the boundaries, so an edited band is renamed with it.
    { key: 'label', header: 'Band', render: (r) => bandName(r) },
    {
      key: 'scope',
      header: 'Applies',
      render: (r) => (
        <span className={r.region !== '*' ? 'font-medium' : 'text-text-secondary'}>
          {bandPlace(r)}
        </span>
      ),
    },
    { key: 'min', header: 'From', render: (r) => money(r.minMinor, currency) },
    {
      key: 'max',
      header: 'To',
      render: (r) => (r.maxMinor == null ? 'and above' : money(r.maxMinor, currency)),
    },
    { key: 'fee', header: 'Booking fee', render: (r) => describeCharge(r, currency) },
    { key: 'active', header: 'Active', render: (r) => bandStatus(r) },
  ];

  const columns = allColumns;

  // Group by currency: bands only make sense compared against others in the same currency,
  // and fees are resolved per currency at booking time.
  const byCurrency = (data ?? []).reduce<Record<string, FeeRule[]>>((acc, rule) => {
    (acc[rule.currency] ??= []).push(rule);
    return acc;
  }, {});
  const currencies = Object.keys(byCurrency).sort();
  /*
    Market currencies with no bands yet. Bands could only be added inside a currency that
    already had one, so a market with none - four of the eight - could never be given a fee
    schedule at all. Listed here so the first band for any market is one click away.
  */
  const unconfigured = Array.from(new Set(MARKETS.map((m) => m.currency))).filter(
    (c) => !byCurrency[c],
  );

  // Until the operator is known nothing is fetched, so say so rather than show an empty list.
  if (!access.known || !access.mayRead) {
    return (
      <div className="space-y-6">
        <PageHeader title="Booking fees" />
        <Card>
          <p className="text-sm text-text-secondary">
            {access.known ? NO_READ_ACCESS : 'Loading...'}
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/*
        Named for what it holds. "Settings" said nothing about the fee bands inside it, and
        an admin looking for what the platform charges had no reason to open it.
      */}
      <PageHeader
        title="Booking fees"
        description="What this platform adds to a ticket price, per market."
        action={
          <ButtonLink href="/admin/fee-policies" variant="outline">
            Fee policies for one event or organizer
          </ButtonLink>
        }
      />

      <label className="flex items-center gap-2 text-sm text-text-secondary">
        <input
          type="checkbox"
          checked={showDeleted}
          onChange={(e) => setShowDeleted(e.target.checked)}
        />
        Show deleted bands
      </label>

      {isLoading && <Card title="Booking fee rules">Loading…</Card>}

      {!isLoading &&
        currencies.map((currency) => (
          <Card
            key={currency}
            title={`Booking fee rules — ${CURRENCY_LABELS[currency] ?? currency}`}
          >
            <DataTable
              columns={columns(currency)}
              rows={byCurrency[currency]}
              rowKey={(r) => r.id}
            />
            {mayEdit && (
              <div className="mt-3 flex justify-end">
                <ButtonLink
                  size="sm"
                  variant="secondary"
                  href={`/admin/settings/schedule?currency=${currency}`}
                >
                  Change this schedule
                </ButtonLink>
              </div>
            )}
          </Card>
        ))}

      {!mayEdit && <p className="text-sm text-text-secondary">{READ_ONLY_NOTE}</p>}

      {mayEdit && !isLoading && unconfigured.length > 0 && (
        <Card title="Set up fees for another market">
          <p className="mb-3 text-sm text-text-secondary">
            These markets have no fee bands of their own yet, so they use the built-in defaults.
            Start a draft to give one its own schedule.
          </p>
          <div className="flex flex-wrap gap-2">
            {unconfigured.map((c) => (
              <ButtonLink
                key={c}
                size="sm"
                variant="secondary"
                href={`/admin/settings/schedule?currency=${c}`}
              >
                Set up {CURRENCY_LABELS[c] ?? c}
              </ButtonLink>
            ))}
          </div>
        </Card>
      )}

      {!isLoading && currencies.length === 0 && (
        <Card title="Booking fee rules">
          <p className="text-sm text-text-secondary">
            No fee rules configured. The booking engine falls back to the built-in India defaults
            until rules exist.
          </p>
        </Card>
      )}

      <Card title="How booking fees resolve">
        <ul className="list-disc space-y-1 pl-5 text-xs text-text-muted">
          <li>
            Fees are matched per <strong>currency</strong>, then by the first band whose range
            contains the order subtotal.
          </li>
          <li>
            To change a schedule, start a <strong>draft</strong>. A draft can have gaps and overlaps
            while you work; it is checked as a whole and published in one step, only when every
            order amount has exactly one band. Amounts are typed in the currency, for example
            100.00.
          </li>
          <li>Leave the upper bound empty for the top band (&ldquo;and above&rdquo;).</li>
          <li>
            A band charges either a <strong>fixed amount</strong> or a <strong>percentage</strong>{' '}
            of the order, and one schedule can mix both - for example a fixed fee for small orders
            and 5% above a set amount. A percentage band can have a minimum and a maximum fee. The
            percentage is of the order after any discount, rounded to the nearest paisa or cent.
          </li>
          <li>
            A <strong>combined</strong> band charges a percentage of the order plus a fixed amount
            for each paid ticket. For example 3% + Rs 5 on one Rs 1,000 ticket is Rs 35, and on
            three such tickets Rs 105. Free tickets do not pay the fixed amount. A combined band has
            no minimum or maximum fee.
          </li>
          <li>
            A band naming a <strong>state</strong> beats one naming only a country, which beats{' '}
            <code>*</code>, for any amount they both cover. An amount that only the broader schedule
            covers keeps the broader band, so adding one band for one place changes that range and
            nothing else. The schedule around it is not deleted.
          </li>
          <li>
            Bands may only overlap <em>across</em> scopes. Two bands covering the same amount in the
            same place is still refused, because the charge would depend on row order.
          </li>
          <li>A band&apos;s name is written from its range, so changing the range renames it.</li>
          <li>
            A band removed in a draft is switched off and kept on file for the audit log when the
            draft is published. Bookings already made keep the fee they were charged.
          </li>
          <li>Every change is recorded in the audit log with its before and after values.</li>
        </ul>
      </Card>
    </div>
  );
}
