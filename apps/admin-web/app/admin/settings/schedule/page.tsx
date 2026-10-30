'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  api,
  Button,
  ButtonLink,
  Card,
  Dialog,
  Input,
  MARKETS,
  marketFor,
  money,
  PageHeader,
  Select,
  useToast,
  type FeeScheduleDraft,
  type FeeScheduleIssue,
} from '@eticketsgo/web-kit';
import { feeBandLabel } from '@eticketsgo/shared-types';
import { NO_READ_ACCESS, READ_ONLY_NOTE, useConfigAccess } from '@/lib/capabilities';
import { describeCharge } from '@/lib/fee-bands';
import {
  bandFromRow,
  bandsFromRows,
  failureMessage,
  issuesFromError,
  newRow,
  rowFromBand,
  sortRows,
  type DraftRow,
  type FeeType,
} from '@/lib/fee-schedule-draft';

/**
 * Change a market's booking-fee schedule as a draft, check it as a whole, and publish it in one
 * step. See FeeSchedulesService (API) for the rules. User copy is ASCII plain English.
 */

const CURRENCIES = Array.from(new Set(MARKETS.map((m) => m.currency))).sort();
const currencyName = (c: string) => {
  const m = MARKETS.find((x) => x.currency === c);
  return m ? `${m.name} (${c})` : c;
};
const homeCountry = (c: string) => MARKETS.find((m) => m.currency === c)?.name ?? '*';

const FEE_TYPES: { value: FeeType; label: string }[] = [
  { value: 'FLAT', label: 'A fixed amount per order' },
  { value: 'FIXED_PER_TICKET', label: 'A fixed amount per ticket' },
  { value: 'PERCENT', label: 'A percentage of the order' },
  { value: 'COMBINED', label: 'A percentage plus a fixed amount per ticket' },
];

export default function FeeScheduleDraftPage() {
  const access = useConfigAccess();
  const toast = useToast();
  const qc = useQueryClient();
  const [currency, setCurrency] = useState('USD');
  const [draft, setDraft] = useState<FeeScheduleDraft | null>(null);
  const [rows, setRows] = useState<DraftRow[]>([]);
  // True once a row changed after the last save: the check below is then out of date.
  const [dirty, setDirty] = useState(false);
  const [publishIssues, setPublishIssues] = useState<FeeScheduleIssue[] | null>(null);
  const [confirming, setConfirming] = useState(false);

  // The settings page links here with ?currency=USD. Read once, without a suspense boundary.
  useEffect(() => {
    const asked = new URLSearchParams(window.location.search).get('currency')?.toUpperCase();
    if (asked && CURRENCIES.includes(asked)) setCurrency(asked);
  }, []);

  const overview = useQuery({
    queryKey: ['admin', 'fee-schedule', currency],
    queryFn: () => api.admin.feeSchedules.overview(currency),
    enabled: access.mayRead,
  });

  const load = (d: FeeScheduleDraft) => {
    setDraft(d);
    setRows(
      sortRows(
        d.bands.map((b) => rowFromBand(b, d.currency)),
        d.currency,
      ),
    );
    setDirty(false);
    setPublishIssues(null);
  };

  // Changing market leaves any draft on screen behind; its rows belong to another currency.
  useEffect(() => {
    setDraft(null);
    setRows([]);
    setDirty(false);
    setPublishIssues(null);
  }, [currency]);

  /*
    One notification per failed operation: each mutation reports its own failure once, in
    plain words (`failureMessage`), and the shared toast list does not stack a repeat.
  */
  const start = useMutation({
    mutationFn: () => api.admin.feeSchedules.createDraft(currency),
    onSuccess: load,
    onError: (err) => toast.push(failureMessage(err, 'open the draft'), 'error'),
  });
  const openExisting = useMutation({
    mutationFn: (id: string) => api.admin.feeSchedules.draft(id),
    onSuccess: load,
    onError: (err) => toast.push(failureMessage(err, 'open the draft'), 'error'),
  });
  const save = useMutation({
    mutationFn: () => {
      const bands = bandsFromRows(rows, currency);
      if (!draft || !bands) throw new Error('unreadable rows');
      return api.admin.feeSchedules.saveDraft(draft.id, bands);
    },
    onSuccess: (d) => {
      load(d);
      toast.push(
        d.validation.valid
          ? 'Draft saved. It has no problems.'
          : 'Draft saved. See the problems below.',
        d.validation.valid ? 'success' : 'warning',
      );
    },
    onError: (err) => toast.push(failureMessage(err, 'save the draft'), 'error'),
  });
  const discard = useMutation({
    mutationFn: () => api.admin.feeSchedules.discardDraft(draft!.id),
    onSuccess: () => {
      setDraft(null);
      setRows([]);
      setDirty(false);
      toast.push('Draft discarded. The live schedule did not change.', 'success');
      void qc.invalidateQueries({ queryKey: ['admin', 'fee-schedule', currency] });
    },
    onError: (err) => toast.push(failureMessage(err, 'discard the draft'), 'error'),
  });
  const publish = useMutation({
    mutationFn: () => api.admin.feeSchedules.publish(draft!.id),
    onSuccess: (r) => {
      setConfirming(false);
      setDraft(null);
      setRows([]);
      toast.push(
        `Published. Version ${r.version} of the ${r.currency} schedule is now live for new orders.`,
        'success',
      );
      void qc.invalidateQueries({ queryKey: ['admin', 'fee-schedule', currency] });
      void qc.invalidateQueries({ queryKey: ['admin', 'fee-rules'] });
    },
    onError: (err) => {
      setConfirming(false);
      setPublishIssues(issuesFromError(err));
      toast.push(failureMessage(err, 'publish the schedule'), 'error');
    },
  });

  const update = (key: string, patch: Partial<DraftRow>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setDirty(true);
  };

  const readable = useMemo(() => bandsFromRows(rows, currency) !== null, [rows, currency]);
  const issues = publishIssues ?? draft?.validation.issues ?? [];
  const errors = issues.filter((i) => i.severity === 'error');
  const flagged = new Set(errors.flatMap((i) => i.bandKeys));
  const mayPublish =
    !!draft && !dirty && !draft.stale && draft.validation.valid && !publish.isPending;

  if (!access.known || !access.mayRead) {
    return (
      <div className="space-y-6">
        <PageHeader title="Change a fee schedule" />
        <Card>
          <p className="text-sm text-text-secondary">
            {access.known ? NO_READ_ACCESS : 'Loading...'}
          </p>
        </Card>
      </div>
    );
  }

  const live = overview.data;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Change a fee schedule"
        description="Edit a copy of the booking fees for one market, check it, then publish it in one step. Nothing changes for buyers until you publish."
        action={
          <ButtonLink href="/admin/settings" variant="outline">
            Back to booking fees
          </ButtonLink>
        }
      />

      <Card>
        <div className="flex flex-wrap items-end gap-4">
          <Select
            label="Market"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            disabled={dirty}
            hint={dirty ? 'Save or discard your changes before you change the market.' : undefined}
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {currencyName(c)}
              </option>
            ))}
          </Select>
          {live && (
            <p className="text-sm text-text-secondary">
              Live schedule: version {live.liveVersion === 0 ? 'before drafts' : live.liveVersion},{' '}
              {live.live.filter((b) => b.active).length} active bands.
            </p>
          )}
          {access.mayEdit && !draft && (
            <Button
              loading={start.isPending || openExisting.isPending}
              onClick={() =>
                live?.openDraft ? openExisting.mutate(live.openDraft.id) : start.mutate()
              }
            >
              {live?.openDraft ? 'Continue the open draft' : 'Start a draft from the live schedule'}
            </Button>
          )}
        </div>
        {!access.mayEdit && <p className="mt-3 text-sm text-text-secondary">{READ_ONLY_NOTE}</p>}
      </Card>

      {draft && (
        <>
          {draft.stale && (
            <Card>
              <p className="text-sm text-status-error" role="alert">
                The live {draft.currency} schedule was changed after this draft was started. This
                draft cannot be published. Discard it and start a new one from the live schedule.
              </p>
            </Card>
          )}

          <Card title={`Draft bands - ${currencyName(draft.currency)}`}>
            <p className="mb-3 text-sm text-text-secondary">
              Amounts are in {draft.currency}, for example 100.00. A band covers orders from its
              starting amount up to and including its end amount. Leave the end empty for &quot;and
              above&quot;. Gaps and overlaps are allowed while you edit; the check below lists them.
            </p>
            <div className="space-y-4">
              {rows.map((row, i) => {
                const { problems } = bandFromRow(row, draft.currency);
                const parsed = bandFromRow(row, draft.currency).band;
                const regions = marketFor(row.country)?.regions ?? [];
                return (
                  <fieldset
                    key={row.key}
                    className={`rounded-md border p-3 ${flagged.has(row.key) || problems.length ? 'border-status-error' : 'border-border'}`}
                  >
                    <legend className="px-1 text-sm font-medium">
                      Band {i + 1}
                      {parsed ? `: ${feeBandLabel(parsed, draft.currency)}` : ''}
                      {!row.active ? ' (switched off)' : ''}
                    </legend>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                      <Input
                        label={`From (${draft.currency})`}
                        inputMode="decimal"
                        value={row.from}
                        onChange={(e) => update(row.key, { from: e.target.value })}
                      />
                      <Input
                        label={`To (${draft.currency}, empty for "and above")`}
                        inputMode="decimal"
                        value={row.to}
                        onChange={(e) => update(row.key, { to: e.target.value })}
                      />
                      <Select
                        label="How this band charges"
                        value={row.feeType}
                        onChange={(e) => update(row.key, { feeType: e.target.value as FeeType })}
                      >
                        {FEE_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </Select>
                      {row.feeType !== 'PERCENT' && (
                        <Input
                          label={
                            row.feeType === 'FLAT'
                              ? `Fee per order (${draft.currency})`
                              : `Fee per paid ticket (${draft.currency})`
                          }
                          inputMode="decimal"
                          value={row.fee}
                          onChange={(e) => update(row.key, { fee: e.target.value })}
                        />
                      )}
                      {(row.feeType === 'PERCENT' || row.feeType === 'COMBINED') && (
                        <Input
                          label="Percentage of the order (%)"
                          inputMode="decimal"
                          value={row.percent}
                          onChange={(e) => update(row.key, { percent: e.target.value })}
                        />
                      )}
                      {row.feeType !== 'FLAT' && (
                        <>
                          <Input
                            label={`Minimum fee for the order (${draft.currency}, optional)`}
                            inputMode="decimal"
                            value={row.minFee}
                            onChange={(e) => update(row.key, { minFee: e.target.value })}
                          />
                          <Input
                            label={`Maximum fee for the order (${draft.currency}, optional)`}
                            inputMode="decimal"
                            value={row.maxFee}
                            onChange={(e) => update(row.key, { maxFee: e.target.value })}
                          />
                        </>
                      )}
                      <Select
                        label="Country"
                        value={row.country}
                        onChange={(e) => update(row.key, { country: e.target.value, region: '*' })}
                      >
                        <option value="*">Anywhere</option>
                        {MARKETS.map((m) => (
                          <option key={m.code} value={m.name}>
                            {m.name}
                          </option>
                        ))}
                      </Select>
                      <Select
                        label={marketFor(row.country)?.regionLabel ?? 'State / province'}
                        value={row.region}
                        disabled={row.country === '*'}
                        onChange={(e) => update(row.key, { region: e.target.value })}
                      >
                        <option value="*">All of the country</option>
                        {regions.map((r) => (
                          <option key={r.name} value={r.name}>
                            {r.name}
                          </option>
                        ))}
                      </Select>
                    </div>
                    {problems.length > 0 && (
                      <ul className="mt-2 list-disc pl-5 text-sm text-status-error">
                        {problems.map((p) => (
                          <li key={p}>{p}</li>
                        ))}
                      </ul>
                    )}
                    {parsed && (
                      <p className="mt-2 text-xs text-text-muted">
                        Charges {describeCharge(parsed, draft.currency)}.
                      </p>
                    )}
                    {access.mayEdit && (
                      <div className="mt-2 flex gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => update(row.key, { active: !row.active })}
                        >
                          {row.active ? 'Switch off' : 'Switch on'}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setRows((rs) => rs.filter((r) => r.key !== row.key));
                            setDirty(true);
                          }}
                        >
                          Remove band
                        </Button>
                      </div>
                    )}
                  </fieldset>
                );
              })}
              {rows.length === 0 && (
                <p className="text-sm text-text-secondary">
                  This draft has no bands. Add one that starts at {money(0, draft.currency)}.
                </p>
              )}
            </div>
            {access.mayEdit && (
              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  onClick={() => {
                    setRows((rs) => [
                      ...rs,
                      newRow(rs, draft.currency, homeCountry(draft.currency)),
                    ]);
                    setDirty(true);
                  }}
                >
                  Add band
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setRows((rs) => sortRows(rs, draft.currency))}
                >
                  Sort by amount
                </Button>
                <Button
                  onClick={() => save.mutate()}
                  loading={save.isPending}
                  disabled={!readable || save.isPending}
                >
                  Save draft and check
                </Button>
                <Button
                  variant="outline"
                  onClick={() => discard.mutate()}
                  loading={discard.isPending}
                >
                  Discard draft
                </Button>
              </div>
            )}
          </Card>

          {/* One consolidated list of problems, read out when it changes. */}
          <Card title="Check">
            <div aria-live="polite" aria-atomic="true" data-testid="fee-schedule-check">
              {dirty ? (
                <p className="text-sm text-text-secondary">
                  You have changes that are not saved. Save the draft to check it again.
                </p>
              ) : errors.length === 0 ? (
                <p className="text-sm text-status-success">
                  No problems. Every order amount has exactly one band.
                </p>
              ) : (
                <p className="text-sm text-status-error">
                  {errors.length === 1 ? '1 problem' : `${errors.length} problems`} to fix before
                  you can publish:
                </p>
              )}
              {!dirty && issues.length > 0 && (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                  {issues.map((issue, i) => (
                    <li
                      key={`${issue.code}-${i}`}
                      className={
                        issue.severity === 'error' ? 'text-status-error' : 'text-text-secondary'
                      }
                    >
                      {issue.severity === 'note' ? 'Note: ' : ''}
                      {issue.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>

          {!dirty && draft.preview.rows.length > 0 && (
            <Card title={`Fee preview - ${draft.preview.place}`}>
              <p className="mb-2 text-sm text-text-secondary">
                The booking fee for sample orders, worked out by the same calculation checkout uses.
                Payment processing and tax are not included. A fee policy for one event or organizer
                still replaces these where it applies.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">Booking fee now and after publish</caption>
                  <thead>
                    <tr className="text-left text-text-secondary">
                      <th scope="col" className="py-1 pr-4">
                        Order total
                      </th>
                      <th scope="col" className="py-1 pr-4">
                        Paid tickets
                      </th>
                      <th scope="col" className="py-1 pr-4">
                        Fee now
                      </th>
                      <th scope="col" className="py-1">
                        Fee after publish
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {draft.preview.rows.map((r) => (
                      <tr key={`${r.orderMinor}-${r.tickets}`} className="border-t border-border">
                        <td className="py-1 pr-4">{money(r.orderMinor, draft.currency)}</td>
                        <td className="py-1 pr-4">{r.tickets}</td>
                        <td className="py-1 pr-4">{money(r.liveFeeMinor, draft.currency)}</td>
                        <td
                          className={`py-1 ${r.draftFeeMinor !== r.liveFeeMinor ? 'font-medium' : ''}`}
                        >
                          {money(r.draftFeeMinor, draft.currency)}
                          {r.draftFeeMinor !== r.liveFeeMinor ? ' (changed)' : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {access.mayEdit && (
            <div className="flex justify-end">
              <Button onClick={() => setConfirming(true)} disabled={!mayPublish}>
                Publish this schedule
              </Button>
            </div>
          )}
        </>
      )}

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Publish the fee schedule"
        description="New quotes and bookings use it at once. Bookings already made keep the fee they were charged."
      >
        <div className="space-y-3">
          <p className="text-sm text-text-secondary">
            All bands are changed together in one step. If someone changed the live schedule after
            this draft was started, nothing is published.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button loading={publish.isPending} onClick={() => publish.mutate()}>
              Publish
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
