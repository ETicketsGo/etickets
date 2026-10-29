'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Download } from 'lucide-react';
import {
  BRAND_FOCUS,
  api,
  brandButtonClasses,
  brandChipClasses,
  errorMessage,
  money,
  tokenStore,
  useToast,
  type BrandStatus,
  type DiscrepancyRow,
  type DiscrepancyStatusValue,
} from '@eticketsgo/web-kit';
import {
  AsOf,
  LINK,
  PageHead,
  Panel,
  Pending,
  ProposalNote,
  State,
  Unread,
} from '@/components/proposal/desk';
import { useHolds } from '@/lib/capabilities';
import { describeDiscrepancy } from '@/lib/discrepancy-detail';
import {
  ageDays,
  ageWords,
  countByType,
  discrepancyTypeLabel,
  exposureByCurrency,
} from '@/lib/proposal-model';

/**
 * PROPOSAL - reconciliation as a finance desk (docs/design/ADMIN-PROPOSAL.md).
 *
 * The live page opens on five coloured ageing tiles and a table whose default view is the
 * whole history, so a queue of 141 open exceptions read as a page of "Ignored". Here:
 *   - the page opens on what is UNRESOLVED (open + being looked at);
 *   - the head is one row per currency: how many, how much is in question (summed only within
 *     that currency), and how old the oldest is;
 *   - each row says what is wrong in a sentence with formatted money, and opens to its
 *     evidence (provider, reference, the stored sentence word for word, dates, notes);
 *   - resolving or ignoring needs a written reason, which the API already stores.
 * Same endpoints as the live page; nothing about how a discrepancy is detected changes.
 */

const STATUS_LABEL: Record<DiscrepancyStatusValue, string> = {
  OPEN: 'Open',
  ASSIGNED: 'Being looked at',
  RESOLVED: 'Resolved',
  IGNORED: 'Ignored',
};
const STATUS_TONE: Record<DiscrepancyStatusValue, BrandStatus> = {
  OPEN: 'critical',
  ASSIGNED: 'caution',
  RESOLVED: 'positive',
  IGNORED: 'neutral',
};

type View = 'UNRESOLVED' | DiscrepancyStatusValue;
const VIEWS: { key: View; label: string }[] = [
  { key: 'UNRESOLVED', label: 'Unresolved' },
  { key: 'OPEN', label: 'Open' },
  { key: 'ASSIGNED', label: 'Being looked at' },
  { key: 'RESOLVED', label: 'Resolved' },
  { key: 'IGNORED', label: 'Ignored' },
];

const PAGE = 25;

function downloadCsv() {
  fetch(api.admin.finance.csvUrl(), {
    headers: { authorization: `Bearer ${tokenStore.access ?? ''}` },
  })
    .then((r) => r.text())
    .then((text) => {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'discrepancies.csv';
      a.click();
      URL.revokeObjectURL(url);
    });
}

export default function ProposalReconciliation() {
  const now = useMemo(() => new Date(), []);
  const [view, setView] = useState<View>('UNRESOLVED');
  const [currency, setCurrency] = useState<string | null>(null);
  const [type, setType] = useState<string>('');
  const [shown, setShown] = useState(PAGE);
  const mayResolve = useHolds('FINANCE_RESOLVE');

  const list = useQuery({
    queryKey: ['proposal', 'recon', view],
    queryFn: async () =>
      view === 'UNRESOLVED'
        ? [
            ...(await api.admin.finance.discrepancies('OPEN')),
            ...(await api.admin.finance.discrepancies('ASSIGNED')),
          ]
        : api.admin.finance.discrepancies(view),
  });
  // The currency head always describes the unresolved queue, whatever the list below shows.
  const unresolved = useQuery({
    queryKey: ['proposal', 'recon', 'UNRESOLVED'],
    queryFn: async () => [
      ...(await api.admin.finance.discrepancies('OPEN')),
      ...(await api.admin.finance.discrepancies('ASSIGNED')),
    ],
  });
  const aging = useQuery({
    queryKey: ['admin', 'aging'],
    queryFn: () => api.admin.finance.aging(),
  });

  const exposure = exposureByCurrency(unresolved.data ?? []);
  const types = countByType(unresolved.data ?? []);
  const rows = (list.data ?? [])
    .filter((r) => !currency || (r.currency?.toUpperCase() ?? '') === currency)
    .filter((r) => !type || r.type === type)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  // One payment can fail several checks at once (amount, currency, status); say how many
  // distinct payments the rows are about, so 141 rows are not read as 141 problems.
  const refs = new Set(rows.map((r) => `${r.provider}:${r.entityRef}`)).size;
  const currencies = [...new Set((list.data ?? []).map((r) => r.currency?.toUpperCase() ?? ''))]
    .filter(Boolean)
    .sort();

  return (
    <>
      <ProposalNote />
      <PageHead
        eyebrow="Money"
        title="Reconciliation"
        description="Where the payment provider and our records disagree. Nothing here is corrected automatically: each one is closed by a person, with a written reason."
        meta={
          <AsOf
            at={list.dataUpdatedAt || null}
            busy={list.isFetching}
            onRefresh={() => {
              void list.refetch();
              void unresolved.refetch();
              void aging.refetch();
            }}
          />
        }
        action={
          <button
            type="button"
            onClick={downloadCsv}
            className={brandButtonClasses('secondary', 'md')}
          >
            <Download className="h-4 w-4" aria-hidden /> Export CSV
          </button>
        }
      />

      <Panel
        id="exposure"
        title="Unresolved, by currency"
        meta="Open and being looked at, all time. Amounts are added only within one currency."
      >
        {unresolved.isError ? (
          <Unread what="the unresolved exceptions" onRetry={() => unresolved.refetch()} />
        ) : unresolved.isLoading ? (
          <Pending />
        ) : exposure.length === 0 ? (
          <p className="text-brand-ui font-semibold text-brand-positive">
            Nothing is unresolved. Every exception has been closed by a person.
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {exposure.map((g) => (
              <li
                key={g.currency ?? 'none'}
                className="rounded-brand-card border border-brand-line bg-brand-surface p-4"
              >
                <p className="text-brand-eyebrow uppercase text-brand-ink-3">
                  {g.currency ?? 'Currency not recorded'}
                </p>
                <p className="mt-2 text-brand-figure tabular-nums text-brand-ink">
                  {g.currency ? money(g.amountMinor, g.currency) : `${g.count}`}
                </p>
                <p className="mt-1 text-brand-meta text-brand-ink-2">
                  in question across {g.count} {g.count === 1 ? 'exception' : 'exceptions'}
                  {g.rowsWithoutAmount > 0 && ` (${g.rowsWithoutAmount} with no amount)`}
                </p>
                {g.oldestAt && (
                  <p className="text-brand-meta text-brand-ink-2">
                    Oldest{' '}
                    <span
                      className={
                        ageDays(g.oldestAt, now) >= 7
                          ? 'font-semibold text-brand-critical'
                          : 'font-semibold text-brand-ink'
                      }
                    >
                      {ageWords(g.oldestAt, now)}
                    </span>
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}

        {aging.data && aging.data.length > 0 && (
          <div className="mt-4">
            <p className="text-brand-eyebrow uppercase text-brand-ink-3">
              How long open ones have waited
            </p>
            <ul className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-brand-meta text-brand-ink-2">
              {aging.data.map((b) => (
                <li key={b.bucket}>
                  {b.bucket}:{' '}
                  <span className="font-semibold tabular-nums text-brand-ink">{b.count}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Panel>

      <Panel
        id="list"
        title="Exceptions"
        meta={`${rows.length.toLocaleString('en-IN')} shown, about ${refs.toLocaleString('en-IN')} provider references, oldest first. Open one to see its evidence.`}
        flush
      >
        <div className="space-y-3 px-4 sm:px-6">
          <div
            className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0"
            role="group"
            aria-label="Status"
          >
            {VIEWS.map((v) => (
              <button
                key={v.key}
                type="button"
                aria-pressed={view === v.key}
                onClick={() => {
                  setView(v.key);
                  setShown(PAGE);
                }}
                className={`${brandChipClasses(view === v.key)} shrink-0`}
              >
                {v.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {currencies.length > 1 && (
              <div className="flex flex-wrap gap-2" role="group" aria-label="Currency">
                <button
                  type="button"
                  aria-pressed={!currency}
                  onClick={() => setCurrency(null)}
                  className={brandChipClasses(!currency)}
                >
                  Every currency
                </button>
                {currencies.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={currency === c}
                    onClick={() => setCurrency(c)}
                    className={brandChipClasses(currency === c)}
                  >
                    {c}
                  </button>
                ))}
              </div>
            )}
            <label className="flex w-full min-w-0 items-center gap-2 text-brand-meta text-brand-ink-2 sm:w-auto">
              Kind
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                className={`h-9 min-w-0 flex-1 rounded-brand-control border border-brand-field bg-brand-surface px-2 text-brand-ui text-brand-ink sm:max-w-xs ${BRAND_FOCUS}`}
              >
                <option value="">Every kind</option>
                {types.map((t) => (
                  <option key={t.type} value={t.type}>
                    {discrepancyTypeLabel(t.type)} ({t.count})
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="mt-3 border-t border-brand-line">
          {list.isError ? (
            <div className="p-4 sm:px-6">
              <Unread what="the exceptions" onRetry={() => list.refetch()} />
            </div>
          ) : list.isLoading ? (
            <div className="p-4 sm:px-6">
              <Pending className="h-64" />
            </div>
          ) : rows.length === 0 ? (
            <p className="p-4 text-brand-ui text-brand-ink-2 sm:px-6">
              Nothing matches these filters.
            </p>
          ) : (
            <ul className="divide-y divide-brand-line">
              {rows.slice(0, shown).map((r) => (
                <ExceptionRow key={r.id} row={r} now={now} mayResolve={mayResolve} />
              ))}
            </ul>
          )}
          {rows.length > shown && (
            <div className="border-t border-brand-line p-4 sm:px-6">
              <button
                type="button"
                onClick={() => setShown((n) => n + PAGE)}
                className={brandButtonClasses('secondary', 'sm')}
              >
                Show {Math.min(PAGE, rows.length - shown)} more of {rows.length - shown}
              </button>
            </div>
          )}
        </div>
      </Panel>
    </>
  );
}

function ExceptionRow({
  row: r,
  now,
  mayResolve,
}: {
  row: DiscrepancyRow;
  now: Date;
  mayResolve: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const { push } = useToast();
  const unresolved = r.status === 'OPEN' || r.status === 'ASSIGNED';
  const evidenceId = `evidence-${r.id}`;

  const decide = (kind: 'resolve' | 'ignore') => {
    if (note.trim().length < 10) {
      setError('Write what you found (at least 10 characters). It is kept with the record.');
      return;
    }
    setBusy(true);
    (kind === 'resolve'
      ? api.admin.finance.resolve(r.id, note.trim())
      : api.admin.finance.ignore(r.id, note.trim())
    )
      .then(() => {
        push(kind === 'resolve' ? 'Marked resolved' : 'Marked ignored', 'success');
        void qc.invalidateQueries({ queryKey: ['proposal', 'recon'] });
      })
      .catch((e) => push(errorMessage(e), 'error'))
      .finally(() => setBusy(false));
  };

  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={evidenceId}
        onClick={() => setOpen((o) => !o)}
        className={`grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-brand-sunken sm:grid-cols-[minmax(0,1fr)_10rem_7rem_9rem_1.25rem] sm:px-6 ${BRAND_FOCUS}`}
      >
        <span className="min-w-0">
          <span className="block text-brand-ui font-semibold text-brand-ink">
            {discrepancyTypeLabel(r.type)}
          </span>
          <span className="block text-brand-meta text-brand-ink-2">
            {describeDiscrepancy(r.detail, r.currency)}
          </span>
        </span>
        <span className="whitespace-nowrap text-right text-brand-ui font-semibold tabular-nums text-brand-ink">
          {r.amountMinor != null && r.currency ? money(r.amountMinor, r.currency) : 'No amount'}
        </span>
        <span className="text-brand-meta text-brand-ink-2 sm:text-right">
          {ageWords(r.createdAt, now)} old
        </span>
        <span className="justify-self-end sm:justify-self-start">
          <State tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</State>
        </span>
        <ChevronDown
          className={`hidden h-5 w-5 text-brand-ink-3 transition-transform duration-200 motion-reduce:transition-none sm:block ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>
      {open && (
        <div
          id={evidenceId}
          className="border-t border-brand-line bg-brand-sunken px-4 py-4 sm:px-6"
        >
          <p className="text-brand-eyebrow uppercase text-brand-ink-3">Evidence</p>
          <dl className="mt-2 grid gap-x-6 gap-y-2 text-brand-meta sm:grid-cols-2 lg:grid-cols-3">
            <Fact label="Provider">{r.provider}</Fact>
            <Fact label="Provider reference">
              <span className="break-all font-mono">{r.entityRef || 'None'}</span>
            </Fact>
            <Fact label="Environment">{r.env}</Fact>
            <Fact label="Filed">
              {new Date(r.createdAt).toLocaleString('en-GB', {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}{' '}
              (your time)
            </Fact>
            <Fact label="Amount, as stored">
              {r.amountMinor ?? 'None'} minor units{r.currency ? ` of ${r.currency}` : ''}
            </Fact>
            <Fact label="Assigned">{r.assignedToUserId ? 'Yes' : 'Nobody'}</Fact>
            <div className="sm:col-span-2 lg:col-span-3">
              <dt className="text-brand-ink-3">What the detector recorded, word for word</dt>
              <dd className="mt-0.5 break-words font-mono text-brand-ink">
                {r.detail ?? 'Nothing recorded'}
              </dd>
            </div>
            {r.resolutionNotes && (
              <div className="sm:col-span-2 lg:col-span-3">
                <dt className="text-brand-ink-3">Reason given when it was closed</dt>
                <dd className="mt-0.5 text-brand-ink">{r.resolutionNotes}</dd>
              </div>
            )}
          </dl>
          <p className="mt-3 text-brand-meta">
            <Link href={`/admin/payments?q=${encodeURIComponent(r.entityRef)}`} className={LINK}>
              Find this payment
            </Link>
          </p>

          {unresolved && mayResolve && (
            <div className="mt-4 max-w-form space-y-2">
              <label
                htmlFor={`note-${r.id}`}
                className="block text-brand-ui font-semibold text-brand-ink"
              >
                What did you find?
              </label>
              <textarea
                id={`note-${r.id}`}
                value={note}
                onChange={(e) => {
                  setNote(e.target.value);
                  setError(null);
                }}
                rows={2}
                aria-invalid={!!error}
                aria-describedby={error ? `note-err-${r.id}` : undefined}
                className={`w-full rounded-brand-control border bg-brand-surface p-2 text-brand-ui text-brand-ink ${error ? 'border-2 border-brand-critical' : 'border-brand-field'} ${BRAND_FOCUS}`}
              />
              {error && (
                <p id={`note-err-${r.id}`} className="text-brand-meta text-brand-critical">
                  {error}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => decide('resolve')}
                  className={brandButtonClasses('primary', 'sm')}
                >
                  Mark resolved
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => decide('ignore')}
                  className={brandButtonClasses('secondary', 'sm')}
                >
                  Ignore, not a real difference
                </button>
              </div>
            </div>
          )}
          {unresolved && !mayResolve && (
            <p className="mt-4 text-brand-meta text-brand-ink-2">
              Closing an exception needs the Finance resolve duty, which your account does not hold.
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-brand-ink-3">{label}</dt>
      <dd className="mt-0.5 text-brand-ink">{children}</dd>
    </div>
  );
}
