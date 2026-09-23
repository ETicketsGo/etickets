'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  Button,
  Card,
  Dialog,
  Input,
  PageHeader,
  Select,
  DataTable,
  money,
  useToast,
  MARKETS,
  marketFor,
  type Column,
  type FeeRule,
} from '@eticketsgo/web-kit';

/**
 * A readable name for each market currency. Editing never changes a rule's currency.
 *
 * Built from MARKETS rather than listed by hand: the hand-written list had four currencies, so
 * the other markets had no name here - and no way to add their first band either.
 */
const CURRENCY_LABELS: Record<string, string> = Object.fromEntries(
  MARKETS.map((m) => [m.currency, `${m.name} (${m.currency})`]),
);

/** Draft state for the edit dialog. Kept as strings so a half-typed value does not fight the input. */
interface Draft {
  label: string;
  minMinor: string;
  maxMinor: string;
  feeMinor: string;
  /** A fixed amount, or a percentage of the order. */
  feeType: 'FLAT' | 'PERCENT';
  /** PERCENT: typed as a person says it - "5" or "2.5" - and stored as basis points. */
  percent: string;
  /** PERCENT, optional limits, in minor units like every other amount on this form. */
  minFeeMinor: string;
  maxFeeMinor: string;
  country: string;
  region: string;
  active: boolean;
  /** True once an admin types their own label, so the derived one stops overwriting it. */
  labelEdited?: boolean;
}

const toDraft = (r: FeeRule): Draft => ({
  label: r.label,
  minMinor: String(r.minMinor),
  maxMinor: r.maxMinor === null ? '' : String(r.maxMinor),
  feeMinor: String(r.feeMinor),
  feeType: r.feeType === 'PERCENT' ? 'PERCENT' : 'FLAT',
  percent: r.feePercentBps == null ? '' : String(r.feePercentBps / 100),
  minFeeMinor: r.minFeeMinor == null ? '' : String(r.minFeeMinor),
  maxFeeMinor: r.maxFeeMinor == null ? '' : String(r.maxFeeMinor),
  /*
    An existing rule keeps whatever scope it has. A NEW one defaults to the country whose
    currency it is in — see `defaultCountryFor`. Editing a USD band and being shown an empty
    country box is an invitation to type "USA", which is not the spelling venues store.
  */
  country: r.country ?? '*',
  region: r.region ?? '*',
  active: r.active,
  // An existing label is the admin's, whatever produced it.
  labelEdited: true,
});

/** The country whose currency this is — unambiguous across the platform's eight markets. */
const defaultCountryFor = (currency: string): string =>
  MARKETS.find((m) => m.currency === currency)?.name ?? '*';

/** What a country calls its subdivisions, for the label on the second dropdown. */
const regionLabelFor = (country: string): string =>
  country === '*' ? 'State / province' : (marketFor(country)?.regionLabel ?? 'State / province');

/**
 * The label a band would be given, from the band itself.
 *
 * Ranges are written the way a person reads money, not in minor units: an admin typing 5000
 * and 9999 into a USD band means "$50 – $99.99", and writing that out by hand is how a label
 * comes to describe a range the rule no longer has.
 */
const bandLabel = (
  draft: Pick<Draft, 'minMinor' | 'maxMinor'>,
  currency: string | null,
): string => {
  if (!currency) return '';
  const min = Number(draft.minMinor);
  if (!Number.isFinite(min)) return '';
  const from = money(min || 0, currency);
  const rawMax = draft.maxMinor.trim();
  if (rawMax === '') return `${from} and above`;
  const max = Number(rawMax);
  if (!Number.isFinite(max)) return '';
  return `${from} – ${money(max, currency)}`;
};

/** Keeps the label in step with the bounds, unless the admin has taken it over. */
const withDerivedLabel = (draft: Draft, currency: string | null): Draft =>
  draft.labelEdited ? draft : { ...draft, label: bandLabel(draft, currency) };

/**
 * What a band charges, in words: "Rs 10.00", or "5% (min Rs 20.00, max Rs 500.00)".
 *
 * One function for the table and the dialog preview, so the admin reads the same sentence in
 * both places and cannot be shown one charge while saving another.
 */
const describeCharge = (
  band: {
    feeType?: 'FLAT' | 'PERCENT';
    feeMinor: number;
    feePercentBps?: number | null;
    minFeeMinor?: number | null;
    maxFeeMinor?: number | null;
  },
  currency: string,
): string => {
  if (band.feeType !== 'PERCENT') return money(band.feeMinor, currency);
  const limits = [
    band.minFeeMinor != null ? `min ${money(band.minFeeMinor, currency)}` : null,
    band.maxFeeMinor != null ? `max ${money(band.maxFeeMinor, currency)}` : null,
  ].filter(Boolean);
  const pct = `${(band.feePercentBps ?? 0) / 100}% of the order`;
  return limits.length ? `${pct} (${limits.join(', ')})` : pct;
};

/** A typed percentage as basis points, or null when it is not a usable percentage. */
const percentToBps = (raw: string): number | null => {
  const value = Number(raw.trim());
  if (raw.trim() === '' || !Number.isFinite(value)) return null;
  const bps = Math.round(value * 100);
  // Two decimal places at most: 2.55% is 255 basis points; 2.555% cannot be stored exactly.
  if (Math.abs(bps - value * 100) > 1e-6 || bps < 1 || bps > 10_000) return null;
  return bps;
};

/** An optional minor-unit amount: empty is "no limit". */
const optionalMinor = (raw: string): number | null =>
  raw.trim() === '' ? null : Number(raw.trim());

/** Where a band applies, for the list. */
const scopeOf = (r: FeeRule): string =>
  r.region && r.region !== '*'
    ? `${r.region}, ${r.country}`
    : r.country && r.country !== '*'
      ? r.country
      : 'Everywhere';

export default function AdminSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<FeeRule | null>(null);
  // Non-null while adding a band; holds the currency the new band belongs to.
  const [creatingCurrency, setCreatingCurrency] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'fee-rules'],
    queryFn: () => api.admin.feeRules(),
  });

  const save = useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: Parameters<typeof api.admin.updateFeeRule>[1];
    }) => api.admin.updateFeeRule(id, patch),
    onSuccess: () => {
      toast.push('Fee rule updated.', 'success');
      void qc.invalidateQueries({ queryKey: ['admin', 'fee-rules'] });
      setEditing(null);
      setDraft(null);
    },
    // The API rejects inverted and overlapping bands; surface its reason rather than a generic
    // failure, because "why was this refused" is the whole value of those checks.
    onError: (err: unknown) =>
      toast.push(err instanceof Error ? err.message : 'Could not update the fee rule.', 'error'),
  });

  const create = useMutation({
    mutationFn: (input: Parameters<typeof api.admin.createFeeRule>[0]) =>
      api.admin.createFeeRule(input),
    onSuccess: () => {
      toast.push('Fee band added.', 'success');
      void qc.invalidateQueries({ queryKey: ['admin', 'fee-rules'] });
      setCreatingCurrency(null);
      setDraft(null);
    },
    onError: (err: unknown) =>
      toast.push(err instanceof Error ? err.message : 'Could not add the fee band.', 'error'),
  });

  const openCreator = (currency: string) => {
    setCreatingCurrency(currency);
    // Blank draft; the API validates the band against the existing ones in this currency.
    setDraft({
      label: '',
      minMinor: '',
      maxMinor: '',
      feeMinor: '',
      feeType: 'FLAT',
      percent: '',
      minFeeMinor: '',
      maxFeeMinor: '',
      /*
        Opens on the country this currency belongs to rather than "Anywhere". A USD band that
        applies everywhere is not what anybody means — it would match an Indian venue selling
        in rupees only if the fee resolver ignored currency, which it does not.
      */
      country: defaultCountryFor(currency),
      region: '*',
      active: true,
    });
  };

  const openEditor = (rule: FeeRule) => {
    setEditing(rule);
    setDraft(toDraft(rule));
  };

  const submit = () => {
    if (!draft) return;
    const trimmedMax = draft.maxMinor.trim();
    // Empty means "and above" — a real value, distinct from leaving the field alone.
    const fields = {
      label: draft.label.trim(),
      minMinor: Number(draft.minMinor),
      maxMinor: trimmedMax === '' ? null : Number(trimmedMax),
      // A percentage band sends its percentage and limits; the fixed amount is stored as 0.
      // A fixed band sends its amount, and the API clears any percentage it used to have.
      ...(draft.feeType === 'PERCENT'
        ? {
            feeType: 'PERCENT' as const,
            feeMinor: 0,
            feePercentBps: percentToBps(draft.percent),
            minFeeMinor: optionalMinor(draft.minFeeMinor),
            maxFeeMinor: optionalMinor(draft.maxFeeMinor),
          }
        : { feeType: 'FLAT' as const, feeMinor: Number(draft.feeMinor) }),
      country: draft.country.trim() || '*',
      region: draft.region.trim() || '*',
      active: draft.active,
    };
    if (creatingCurrency) {
      create.mutate({ currency: creatingCurrency, ...fields });
      return;
    }
    if (editing) save.mutate({ id: editing.id, patch: fields });
  };

  /** Numeric fields are minor units; block a submit that would send NaN to a money endpoint. */
  const optionalInteger = (raw: string) => raw.trim() === '' || Number.isInteger(Number(raw));
  const floorAboveCeiling =
    !!draft &&
    draft.minFeeMinor.trim() !== '' &&
    draft.maxFeeMinor.trim() !== '' &&
    Number(draft.minFeeMinor) > Number(draft.maxFeeMinor);
  const invalid =
    !draft ||
    draft.label.trim() === '' ||
    !Number.isInteger(Number(draft.minMinor)) ||
    (draft.maxMinor.trim() !== '' && !Number.isInteger(Number(draft.maxMinor))) ||
    (draft.feeType === 'FLAT'
      ? draft.feeMinor.trim() === '' || !Number.isInteger(Number(draft.feeMinor))
      : percentToBps(draft.percent) === null ||
        !optionalInteger(draft.minFeeMinor) ||
        !optionalInteger(draft.maxFeeMinor) ||
        floorAboveCeiling);

  const columns = (currency: string): Column<FeeRule>[] => [
    { key: 'label', header: 'Band', render: (r) => r.label },
    {
      key: 'scope',
      header: 'Applies',
      render: (r) => (
        <span className={r.region !== '*' ? 'font-medium' : 'text-text-secondary'}>
          {scopeOf(r)}
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
    { key: 'active', header: 'Active', render: (r) => (r.active ? 'Yes' : 'No') },
    {
      key: 'actions',
      header: '',
      render: (r) => (
        <Button size="sm" variant="secondary" onClick={() => openEditor(r)}>
          Edit
        </Button>
      ),
    },
  ];

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
  const [newCurrency, setNewCurrency] = useState('');

  // The dialog serves both modes, so it reads its currency from whichever is active rather
  // than assuming an existing rule. Amounts are minor units, and the labels/preview must
  // name the right currency or an admin can enter cents thinking they are paise.
  const dialogCurrency = creatingCurrency ?? editing?.currency ?? null;

  return (
    <div className="space-y-6">
      {/*
        Named for what it holds. "Settings" said nothing about the fee bands inside it, and
        an admin looking for what the platform charges had no reason to open it.
      */}
      <PageHeader
        title="Booking fees"
        description="What this platform adds to a ticket price, per market."
      />

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
            <div className="mt-3 flex justify-end">
              <Button size="sm" variant="secondary" onClick={() => openCreator(currency)}>
                Add band
              </Button>
            </div>
          </Card>
        ))}

      {!isLoading && unconfigured.length > 0 && (
        <Card title="Set up fees for another market">
          <p className="mb-3 text-sm text-text-secondary">
            These markets have no fee bands of their own yet, so they use the built-in defaults. Add
            a first band to give one its own schedule.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <Select
              label="Market"
              value={newCurrency}
              onChange={(e) => setNewCurrency(e.target.value)}
            >
              <option value="">Choose a market</option>
              {unconfigured.map((c) => (
                <option key={c} value={c}>
                  {CURRENCY_LABELS[c] ?? c}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              variant="secondary"
              disabled={!newCurrency}
              onClick={() => {
                openCreator(newCurrency);
                setNewCurrency('');
              }}
            >
              Add first band
            </Button>
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
            All amounts are <strong>minor units</strong> — paise for INR, cents for USD/CAD/AUD.
            Enter 500 for ₹5 or $5.00.
          </li>
          <li>
            Bands within a currency must not overlap while active. The API refuses an overlapping
            edit, because first-match resolution would make the fee depend on row order.
          </li>
          <li>Leave the upper bound empty for the top band (&ldquo;and above&rdquo;).</li>
          <li>
            A band charges either a <strong>fixed amount</strong> or a <strong>percentage</strong>{' '}
            of the order, and one schedule can mix both - for example a fixed fee for small orders
            and 5% above a set amount. A percentage band can have a minimum and a maximum fee. The
            percentage is of the order after any discount, rounded to the nearest paisa or cent.
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
          <li>Every change is recorded in the audit log with its before and after values.</li>
        </ul>
      </Card>

      <Dialog
        open={!!editing || !!creatingCurrency}
        onClose={() => {
          setEditing(null);
          setCreatingCurrency(null);
          setDraft(null);
        }}
        title={
          creatingCurrency
            ? `Add fee band — ${creatingCurrency}`
            : editing
              ? `Edit fee rule — ${editing.currency}`
              : 'Fee rule'
        }
      >
        {draft && dialogCurrency && (
          <div className="space-y-3">
            {/*
              The label writes itself from the band it describes.

              It is what an admin reads in the table, and it was typed by hand next to the two
              numbers it is meant to describe — so "$0–$9.99" outlived an edit to the bounds and
              went on describing a band that no longer existed. Derived, it cannot disagree;
              still editable, because a band sometimes deserves a name rather than a range.
            */}
            <Input
              label="Label"
              value={draft.label}
              hint={
                draft.label === bandLabel(draft, dialogCurrency)
                  ? 'Written from the amounts below. Type here to name it yourself.'
                  : 'Custom. Clear it to go back to the amounts below.'
              }
              onChange={(e) => setDraft({ ...draft, label: e.target.value, labelEdited: true })}
            />
            <Input
              label={`From (minor units, ${dialogCurrency})`}
              inputMode="numeric"
              value={draft.minMinor}
              onChange={(e) =>
                setDraft(withDerivedLabel({ ...draft, minMinor: e.target.value }, dialogCurrency))
              }
            />
            <Input
              label={`To (minor units — leave empty for "and above")`}
              inputMode="numeric"
              value={draft.maxMinor}
              onChange={(e) =>
                setDraft(withDerivedLabel({ ...draft, maxMinor: e.target.value }, dialogCurrency))
              }
            />
            <Select
              label="How this band charges"
              value={draft.feeType}
              onChange={(e) =>
                setDraft({ ...draft, feeType: e.target.value === 'PERCENT' ? 'PERCENT' : 'FLAT' })
              }
            >
              <option value="FLAT">A fixed amount</option>
              <option value="PERCENT">A percentage of the order</option>
            </Select>
            {draft.feeType === 'FLAT' ? (
              <Input
                label={`Booking fee (minor units, ${dialogCurrency})`}
                inputMode="numeric"
                value={draft.feeMinor}
                onChange={(e) => setDraft({ ...draft, feeMinor: e.target.value })}
              />
            ) : (
              <>
                <Input
                  label="Percentage of the order (%)"
                  inputMode="decimal"
                  value={draft.percent}
                  hint="For example 5 for 5%, or 2.5 for 2.5%. Up to two decimal places."
                  onChange={(e) => setDraft({ ...draft, percent: e.target.value })}
                />
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    label={`Minimum fee (minor units, optional)`}
                    inputMode="numeric"
                    value={draft.minFeeMinor}
                    hint="Leave empty for no minimum."
                    onChange={(e) => setDraft({ ...draft, minFeeMinor: e.target.value })}
                  />
                  <Input
                    label={`Maximum fee (minor units, optional)`}
                    inputMode="numeric"
                    value={draft.maxFeeMinor}
                    hint={
                      floorAboveCeiling
                        ? 'The minimum is above the maximum.'
                        : 'Leave empty for no maximum.'
                    }
                    onChange={(e) => setDraft({ ...draft, maxFeeMinor: e.target.value })}
                  />
                </div>
              </>
            )}
            {/*
              Where the band applies.

              Fees were scoped by currency alone, which is not the unit anybody regulates —
              several Indian states cap what may be charged for booking a cinema ticket
              online. A rule naming a state replaces the national schedule where it applies,
              so a national default can stay exactly as it is.
            */}
            {/*
              ── PICKED, NOT TYPED ─────────────────────────────────────────────────────
              These were free-text boxes holding a country name and a region name that have to
              match what a VENUE stores, exactly, for the rule to ever apply. A typo does not
              fail here — it saves a rule that silently matches nothing, and the fee quietly
              falls back to a broader band. That is the worst kind of configuration bug: it
              looks like it worked.

              The country also defaults to the market whose currency this band is in. Editing
              a USD rule and being shown a blank country box invites somebody to type
              "USA" — which is not what venues store.
            */}
            <div className="grid grid-cols-2 gap-3">
              <Select
                label="Country"
                value={draft.country}
                hint="Where the band applies. Anywhere is the national/global default."
                onChange={(e) => setDraft({ ...draft, country: e.target.value, region: '*' })}
              >
                <option value="*">Anywhere</option>
                {MARKETS.map((m) => (
                  <option key={m.code} value={m.name}>
                    {m.name}
                  </option>
                ))}
              </Select>
              <Select
                label={regionLabelFor(draft.country)}
                value={draft.region}
                disabled={draft.country === '*'}
                hint={
                  draft.country === '*'
                    ? 'Pick a country first — a state has to belong to one.'
                    : 'A band naming a state replaces the national schedule where it applies.'
                }
                onChange={(e) => setDraft({ ...draft, region: e.target.value })}
              >
                <option value="*">
                  All of {draft.country === '*' ? 'the country' : draft.country}
                </option>
                {(marketFor(draft.country)?.regions ?? []).map((r) => (
                  <option key={r.name} value={r.name}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </div>
            <Select
              label="Active"
              value={draft.active ? 'yes' : 'no'}
              onChange={(e) => setDraft({ ...draft, active: e.target.value === 'yes' })}
            >
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </Select>

            <p className="text-xs text-text-muted">
              Preview: {money(Number(draft.minMinor) || 0, dialogCurrency)} –{' '}
              {draft.maxMinor.trim() === ''
                ? 'and above'
                : money(Number(draft.maxMinor) || 0, dialogCurrency)}{' '}
              → fee{' '}
              {describeCharge(
                draft.feeType === 'PERCENT'
                  ? {
                      feeType: 'PERCENT',
                      feeMinor: 0,
                      feePercentBps: percentToBps(draft.percent) ?? 0,
                      minFeeMinor: optionalMinor(draft.minFeeMinor),
                      maxFeeMinor: optionalMinor(draft.maxFeeMinor),
                    }
                  : { feeType: 'FLAT', feeMinor: Number(draft.feeMinor) || 0 },
                dialogCurrency,
              )}
            </p>

            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setEditing(null);
                  setCreatingCurrency(null);
                  setDraft(null);
                }}
              >
                Cancel
              </Button>
              <Button onClick={submit} disabled={invalid || save.isPending || create.isPending}>
                {save.isPending || create.isPending
                  ? 'Saving…'
                  : creatingCurrency
                    ? 'Add band'
                    : 'Save changes'}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
