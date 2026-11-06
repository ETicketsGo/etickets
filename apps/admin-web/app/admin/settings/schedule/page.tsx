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
import { NO_READ_ACCESS, READ_ONLY_NOTE, useConfigAccess, useHolds } from '@/lib/capabilities';
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
 * Change a market's booking-fee schedule as a draft, check it as a whole, and submit it for
 * approval. Another administrator who holds FEE_SCHEDULE_APPROVE and did not work on the draft
 * approves it, which publishes it in one step. See FeeSchedulesService (API) for the rules.
 * User copy is ASCII plain English.
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
  const [confirming, setConfirming] = useState<null | 'submit' | 'approve' | 'reject'>(null);
  const [note, setNote] = useState('');
  const [rollback, setRollback] = useState<number | null>(null);
  const [rollbackReason, setRollbackReason] = useState('');
  const mayApprove = useHolds('FEE_SCHEDULE_APPROVE');

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
  const refreshLive = () => {
    void qc.invalidateQueries({ queryKey: ['admin', 'fee-schedule', currency] });
    void qc.invalidateQueries({ queryKey: ['admin', 'fee-rules'] });
  };
  const closeDialog = () => {
    setConfirming(null);
    setNote('');
  };
  const submit = useMutation({
    mutationFn: () => api.admin.feeSchedules.submit(draft!.id, note.trim() || undefined),
    onSuccess: (d) => {
      closeDialog();
      load(d);
      toast.push(
        'Submitted. Nothing changes for buyers until another administrator approves it.',
        'success',
      );
      refreshLive();
    },
    onError: (err) => {
      closeDialog();
      setPublishIssues(issuesFromError(err));
      toast.push(failureMessage(err, 'submit the schedule'), 'error');
    },
  });
  const withdraw = useMutation({
    mutationFn: () => api.admin.feeSchedules.withdraw(draft!.id),
    onSuccess: (d) => {
      load(d);
      toast.push('Withdrawn. The draft is open for changes again.', 'success');
      refreshLive();
    },
    onError: (err) => toast.push(failureMessage(err, 'withdraw the draft'), 'error'),
  });
  const approve = useMutation({
    mutationFn: () => api.admin.feeSchedules.approve(draft!.id, note.trim() || undefined),
    onSuccess: (r) => {
      closeDialog();
      setDraft(null);
      setRows([]);
      toast.push(
        `Approved. Version ${r.version} of the ${r.currency} schedule is now live for new orders.`,
        'success',
      );
      refreshLive();
    },
    onError: (err) => {
      closeDialog();
      setPublishIssues(issuesFromError(err));
      toast.push(failureMessage(err, 'approve the schedule'), 'error');
    },
  });
  const reject = useMutation({
    mutationFn: () => api.admin.feeSchedules.reject(draft!.id, note.trim()),
    onSuccess: (d) => {
      closeDialog();
      load(d);
      toast.push(
        'Rejected. The draft went back to its maker. Nothing changed for buyers.',
        'success',
      );
      refreshLive();
    },
    onError: (err) => {
      closeDialog();
      toast.push(failureMessage(err, 'reject the schedule'), 'error');
    },
  });
  const restore = useMutation({
    mutationFn: () =>
      api.admin.feeSchedules.emergencyRollback(currency, rollback!, rollbackReason.trim()),
    onSuccess: (r) => {
      setRollback(null);
      setRollbackReason('');
      setDraft(null);
      setRows([]);
      toast.push(
        `Rolled back. Version ${r.version} is live and charges what version ${r.restoredVersion} charged. The other approvers were told.`,
        'success',
      );
      refreshLive();
    },
    onError: (err) => {
      setRollback(null);
      toast.push(failureMessage(err, 'roll back the schedule'), 'error');
    },
  });
  const pending = draft?.status === 'PENDING_APPROVAL';
  const impact = useQuery({
    queryKey: ['admin', 'fee-schedule-impact', draft?.id, draft?.updatedAt],
    queryFn: () => api.admin.feeSchedules.impact(draft!.id),
    enabled: !!draft && !dirty && (draft.status === 'OPEN' || pending),
  });

  const update = (key: string, patch: Partial<DraftRow>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setDirty(true);
  };

  const readable = useMemo(() => bandsFromRows(rows, currency) !== null, [rows, currency]);
  const issues = publishIssues ?? draft?.validation.issues ?? [];
  const errors = issues.filter((i) => i.severity === 'error');
  const flagged = new Set(errors.flatMap((i) => i.bandKeys));
  const editable = access.mayEdit && draft?.status === 'OPEN';
  const maySubmit =
    !!draft &&
    draft.status === 'OPEN' &&
    !dirty &&
    !draft.stale &&
    draft.validation.valid &&
    !submit.isPending;
  const mayDecide = pending && mayApprove && !!draft?.viewer?.mayDecide;
  const isMaker = pending && !!draft?.viewer?.independenceBlock;

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
        description="Edit a copy of the booking fees for one market, check it, and submit it. Another administrator approves it, and then it goes live in one step. Nothing changes for buyers until it is approved."
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
          {!draft && live?.pendingDraft && (
            <Button
              loading={openExisting.isPending}
              onClick={() => openExisting.mutate(live.pendingDraft!.id)}
            >
              Review the draft waiting for approval
            </Button>
          )}
          {access.mayEdit && !draft && !live?.pendingDraft && (
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
                draft cannot be approved.{' '}
                {pending
                  ? 'Reject or withdraw it, then start a new one from the live schedule.'
                  : 'Discard it and start a new one from the live schedule.'}
              </p>
            </Card>
          )}

          {draft.status === 'OPEN' && draft.lastRejectionNote && (
            <Card>
              <p className="text-sm text-text-primary" role="status">
                This draft was not approved. Reason: {draft.lastRejectionNote}
              </p>
            </Card>
          )}

          {pending && (
            <Card title="Waiting for approval">
              <div className="space-y-2 text-sm" data-testid="fee-schedule-approval">
                <p>
                  Submitted by {draft.submittedBy?.email ?? 'an administrator'}
                  {draft.submittedAt ? ` on ${new Date(draft.submittedAt).toLocaleString()}` : ''}.
                  It is not live. It cannot be changed while it waits.
                </p>
                {draft.submissionNote && <p>Note from the maker: {draft.submissionNote}</p>}
                <p className="text-text-secondary">
                  Takes effect: at once, when it is approved. Bookings already made keep the fee
                  they were charged.
                </p>
                <p className="text-text-secondary">
                  Worked on by: {(draft.contributors ?? []).map((c) => c.email).join(', ') || '-'}.
                  None of these people can approve it.
                </p>
                {!mayApprove && (
                  <p className="text-text-secondary">
                    You do not hold the duty to approve fee changes.
                  </p>
                )}
                {mayApprove && !draft.viewer?.mayDecide && (
                  <p className="text-status-error">
                    You worked on this draft, so you cannot approve or reject it. Another
                    administrator must decide.
                  </p>
                )}
                <div className="flex flex-wrap gap-2 pt-2">
                  {mayDecide && (
                    <>
                      <Button
                        onClick={() => setConfirming('approve')}
                        disabled={draft.stale || !draft.validation.valid}
                      >
                        Approve and publish
                      </Button>
                      <Button variant="outline" onClick={() => setConfirming('reject')}>
                        Reject
                      </Button>
                    </>
                  )}
                  {isMaker && access.mayEdit && (
                    <Button
                      variant="secondary"
                      loading={withdraw.isPending}
                      onClick={() => withdraw.mutate()}
                    >
                      Withdraw to edit
                    </Button>
                  )}
                </div>
              </div>
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
                    disabled={!editable}
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
                    {editable && (
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
            {editable && (
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
                  you can submit it:
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
                  <caption className="sr-only">Booking fee now and after approval</caption>
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
                        Fee after approval
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

          {!dirty && impact.data && (
            <Card title={`Financial impact - last ${impact.data.windowDays} days`}>
              <div className="space-y-1 text-sm" data-testid="fee-schedule-impact">
                {impact.data.orders === 0 ? (
                  <p className="text-text-secondary">
                    No confirmed {draft.currency} orders in this time, so there is nothing to
                    compare.
                  </p>
                ) : (
                  <>
                    <p>
                      {impact.data.orders} real orders paid{' '}
                      {money(impact.data.liveFeeMinor, draft.currency)} in booking fees under the
                      live schedule. Under this draft they would pay{' '}
                      {money(impact.data.draftFeeMinor, draft.currency)} (
                      {impact.data.deltaMinor >= 0 ? 'more by ' : 'less by '}
                      {money(Math.abs(impact.data.deltaMinor), draft.currency)}).
                    </p>
                    <p className="text-text-secondary">
                      {impact.data.higher} orders pay more (at most{' '}
                      {money(impact.data.largestIncreaseMinor, draft.currency)} more),{' '}
                      {impact.data.lower} pay less, {impact.data.unchanged} do not change.
                    </p>
                  </>
                )}
                <p className="text-xs text-text-muted">
                  An estimate. Every order is priced as if it were in {impact.data.place}, so a band
                  for one state or region is not shown here, and a fee policy for one event or
                  organizer is left out. Orders already made keep the fee they were charged.
                </p>
              </div>
            </Card>
          )}

          {editable && (
            <div className="flex justify-end">
              <Button onClick={() => setConfirming('submit')} disabled={!maySubmit}>
                Submit for approval
              </Button>
            </div>
          )}
        </>
      )}

      {live && live.history.length > 0 && (
        <Card title={`Published versions - ${currencyName(currency)}`}>
          <ul className="space-y-2 text-sm" data-testid="fee-schedule-history">
            {live.history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">Version {h.version}</span>
                <span className="text-text-secondary">
                  {h.publishedAt ? new Date(h.publishedAt).toLocaleString() : ''}
                  {h.emergency
                    ? ` - emergency rollback to version ${h.rollbackOfVersion} by ${h.publishedBy?.email ?? 'an administrator'}`
                    : h.approvedBy
                      ? ` - submitted by ${h.submittedBy?.email ?? '-'}, approved by ${h.approvedBy.email}`
                      : ` - published by ${h.publishedBy?.email ?? 'an administrator'} (before approvals)`}
                </span>
                {h.approvalNote && <span className="text-text-muted">Note: {h.approvalNote}</span>}
                {mayApprove && access.mayEdit && h.version < live.liveVersion && (
                  <Button size="sm" variant="outline" onClick={() => setRollback(h.version)}>
                    Emergency: roll back to this version
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Dialog
        open={confirming !== null}
        onClose={closeDialog}
        title={
          confirming === 'approve'
            ? 'Approve and publish the fee schedule'
            : confirming === 'reject'
              ? 'Reject the fee schedule'
              : 'Submit the fee schedule for approval'
        }
        description={
          confirming === 'approve'
            ? 'New quotes and bookings use it at once. Bookings already made keep the fee they were charged.'
            : confirming === 'reject'
              ? 'The draft goes back to its maker with your reason. Nothing changes for buyers.'
              : 'Another administrator must approve it. Nothing changes for buyers until then, and you cannot edit it while it waits.'
        }
      >
        <div className="space-y-3">
          {confirming === 'approve' && (
            <p className="text-sm text-text-secondary">
              All bands are changed together in one step. If someone changed the live schedule after
              this draft was started, nothing is published.
            </p>
          )}
          <Input
            label={
              confirming === 'reject'
                ? 'Reason (required, the maker sees it)'
                : 'Note (optional, kept with the decision)'
            }
            value={note}
            maxLength={1000}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={closeDialog}>
              Cancel
            </Button>
            {confirming === 'submit' && (
              <Button loading={submit.isPending} onClick={() => submit.mutate()}>
                Submit
              </Button>
            )}
            {confirming === 'approve' && (
              <Button loading={approve.isPending} onClick={() => approve.mutate()}>
                Approve and publish
              </Button>
            )}
            {confirming === 'reject' && (
              <Button
                loading={reject.isPending}
                disabled={note.trim().length < 5}
                onClick={() => reject.mutate()}
              >
                Reject
              </Button>
            )}
          </div>
        </div>
      </Dialog>

      <Dialog
        open={rollback !== null}
        onClose={() => setRollback(null)}
        title={`Emergency: roll back to version ${rollback ?? ''}`}
        description="Use this only when the live fees are wrong and cannot wait for a normal approval. The live schedule goes back to what this earlier version charged, at once, without a second approval."
      >
        <div className="space-y-3">
          <p className="text-sm text-text-secondary">
            This makes a new version. It is recorded with your name and reason, and every other
            approver is told to review it. Any draft that is open or waiting can no longer be
            approved.
          </p>
          <Input
            label="Reason (at least 20 characters)"
            value={rollbackReason}
            maxLength={1000}
            onChange={(e) => setRollbackReason(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRollback(null)}>
              Cancel
            </Button>
            <Button
              loading={restore.isPending}
              disabled={rollbackReason.trim().length < 20}
              onClick={() => restore.mutate()}
            >
              Roll back now
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
