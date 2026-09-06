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

/** Currencies the platform seeds bands for. Editing never changes a rule's currency. */
const CURRENCY_LABELS: Record<string, string> = {
  INR: 'India (INR)',
  USD: 'United States (USD)',
  CAD: 'Canada (CAD)',
  AUD: 'Australia (AUD)',
};

/** Draft state for the edit dialog. Kept as strings so a half-typed value does not fight the input. */
interface Draft {
  label: string;
  minMinor: string;
  maxMinor: string;
  feeMinor: string;
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
      feeMinor: Number(draft.feeMinor),
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
  const invalid =
    !draft ||
    draft.label.trim() === '' ||
    !Number.isInteger(Number(draft.minMinor)) ||
    !Number.isInteger(Number(draft.feeMinor)) ||
    (draft.maxMinor.trim() !== '' && !Number.isInteger(Number(draft.maxMinor)));

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
    { key: 'fee', header: 'Booking fee', render: (r) => money(r.feeMinor, currency) },
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

  // The dialog serves both modes, so it reads its currency from whichever is active rather
  // than assuming an existing rule. Amounts are minor units, and the labels/preview must
  // name the right currency or an admin can enter cents thinking they are paise.
  const dialogCurrency = creatingCurrency ?? editing?.currency ?? null;

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Platform fee configuration." />

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
            A band naming a <strong>state</strong> beats one naming only a country, which beats{' '}
            <code>*</code>. The winning scope supplies the <strong>whole</strong> schedule — a
            state&rsquo;s bands replace the national ones rather than mixing with them, so a partial
            state schedule does not silently inherit a national band.
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
            <Input
              label={`Booking fee (minor units, ${dialogCurrency})`}
              inputMode="numeric"
              value={draft.feeMinor}
              onChange={(e) => setDraft({ ...draft, feeMinor: e.target.value })}
            />
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
              → fee {money(Number(draft.feeMinor) || 0, dialogCurrency)}
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
