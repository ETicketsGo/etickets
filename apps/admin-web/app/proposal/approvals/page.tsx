'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BRAND_FOCUS,
  EventArtwork,
  api,
  brandButtonClasses,
  countryDisplay,
  errorMessage,
  eventImageSource,
  money,
  useAuthUser,
  type AdminEventRow,
  type OrgEventDetail,
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
import {
  ageWords,
  priceSpans,
  rejectionReasonError,
  riskSignals,
  type RiskSignal,
} from '@/lib/proposal-model';

/**
 * PROPOSAL - the event approval queue as a reviewer's desk (docs/design/ADMIN-PROPOSAL.md).
 *
 * The live queue is a table of title, organizer, city, category, country and date, with the
 * decision two clicks away on another page. A reviewer cannot judge a listing they cannot see.
 * Each row here carries what a buyer would see (the image, the title, where, when in the venue's
 * own time zone, the prices per currency) and the facts worth checking first, then ONE decision:
 * approve, or send back with a reason the organizer will read. Longest waiting first.
 *
 * Read from existing endpoints only: the queue list, then each event's own detail (the list has
 * no image or price - a gap the proposal names) and the organizer's complaint count.
 */

const SHOWN = 12;

function venueWhen(iso: string, timeZone: string | null | undefined) {
  const format = (tz: string | undefined) =>
    new Intl.DateTimeFormat('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short',
      timeZone: tz,
    }).format(new Date(iso));
  if (!timeZone) return `${format('UTC')} (the venue has no time zone set)`;
  try {
    return format(timeZone);
  } catch {
    // A venue whose stored zone the browser does not know: say so, never show it as local time.
    return `${format('UTC')} (venue time zone "${timeZone}" not recognised)`;
  }
}

export default function ProposalApprovals() {
  const now = useMemo(() => new Date(), []);
  const { user } = useAuthUser();
  const mayComplaints = (user?.adminPermissions ?? []).includes('BOOKING_READ');

  const queue = useQuery({
    queryKey: ['proposal', 'approvals'],
    queryFn: () => api.admin.events({ page: 1, pageSize: 100, status: 'UNDER_REVIEW' }),
  });
  // Longest waiting first: the list is newest first, and the reviewer's job is the reverse.
  const rows = [...(queue.data?.data ?? [])].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const page = rows.slice(0, SHOWN);

  const details = useQueries({
    queries: page.map((r) => ({
      queryKey: ['proposal', 'event', r.id],
      queryFn: () => api.events.get(r.id),
      staleTime: 60_000,
      retry: false,
    })),
  });
  const orgIds = [
    ...new Set(details.map((d) => d.data?.organizationId).filter(Boolean) as string[]),
  ];
  const complaints = useQueries({
    queries: orgIds.map((id) => ({
      queryKey: ['proposal', 'complaints', id],
      queryFn: () => api.admin.complaintCounts(id),
      enabled: mayComplaints,
      staleTime: 60_000,
      retry: false,
    })),
  });
  const complaintsFor = (orgId: string | undefined) => {
    const i = orgId ? orgIds.indexOf(orgId) : -1;
    return i >= 0 ? complaints[i]?.data : undefined;
  };

  const total = queue.data?.meta.total ?? 0;

  return (
    <>
      <ProposalNote />
      <PageHead
        eyebrow="Review"
        title="Event approvals"
        description="Each event as buyers will see it, with what to check first. One decision per row; sending one back needs a reason the organizer will read."
        meta={
          <AsOf
            at={queue.dataUpdatedAt || null}
            busy={queue.isFetching}
            onRefresh={() => queue.refetch()}
          />
        }
      />

      <Panel
        id="queue"
        title={
          queue.data ? `${total.toLocaleString('en-IN')} waiting for review` : 'Waiting for review'
        }
        meta={
          total > SHOWN
            ? `The ${SHOWN} that have waited longest, by last change. ${total - SHOWN} more after these.`
            : 'Longest waiting first, by last change.'
        }
        flush
      >
        {queue.isError ? (
          <div className="px-4 pb-4 sm:px-6">
            <Unread what="the approval queue" onRetry={() => queue.refetch()} />
          </div>
        ) : queue.isLoading ? (
          <div className="px-4 pb-4 sm:px-6">
            <Pending className="h-96" />
          </div>
        ) : rows.length === 0 ? (
          <p className="px-4 pb-6 text-brand-ui font-semibold text-brand-positive sm:px-6">
            Nothing is waiting for review.
          </p>
        ) : (
          <ul className="divide-y divide-brand-line border-t border-brand-line">
            {page.map((r, i) => (
              <ApprovalRow
                key={r.id}
                row={r}
                detail={details[i]?.data}
                detailState={
                  details[i]?.isError ? 'error' : details[i]?.isLoading ? 'loading' : 'ok'
                }
                complaints={complaintsFor(details[i]?.data?.organizationId)}
                now={now}
              />
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}

const SIGNAL_TONE: Record<RiskSignal['tone'], 'critical' | 'caution' | 'info'> = {
  critical: 'critical',
  caution: 'caution',
  info: 'info',
};

function ApprovalRow({
  row,
  detail,
  detailState,
  complaints,
  now,
}: {
  row: AdminEventRow;
  detail: OrgEventDetail | undefined;
  detailState: 'loading' | 'error' | 'ok';
  complaints: { open: number; total: number } | undefined;
  now: Date;
}) {
  const qc = useQueryClient();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [decided, setDecided] = useState<'APPROVE' | 'REJECT' | null>(null);

  const signals = riskSignals(row, detail, now);
  if (complaints && complaints.open > 0) {
    signals.unshift({
      key: 'complaints',
      words: `${complaints.open} open ${complaints.open === 1 ? 'complaint' : 'complaints'} against this organizer`,
      tone: 'caution',
    });
  }
  const spans = priceSpans(detail);
  const tz = detail?.venue?.timezone;
  const image = eventImageSource(
    detail ? { variants: detail.imageVariants, path: detail.imagePath } : null,
    'thumb',
  );
  const country = countryDisplay(row.venue.country)?.name;
  const noteId = `reason-${row.id}`;

  const decide = (decision: 'APPROVE' | 'REJECT') => {
    if (decision === 'REJECT') {
      const e = rejectionReasonError(note);
      if (e) {
        setError(e);
        return;
      }
    }
    setBusy(true);
    api.admin
      .reviewEvent(row.id, decision, decision === 'REJECT' ? note.trim() : undefined)
      .then(() => {
        setDecided(decision);
        void qc.invalidateQueries({ queryKey: ['proposal', 'approvals'] });
      })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };

  return (
    <li className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-4 px-4 py-5 sm:grid-cols-[6rem_minmax(0,1fr)] sm:px-6 lg:grid-cols-[7.5rem_minmax(0,1fr)_15rem]">
      <div className="w-[4.5rem] sm:w-24 lg:w-[7.5rem]">
        <EventArtwork
          src={image?.src}
          srcSet={image?.srcSet}
          sizes="120px"
          alt={`Image for ${row.title}`}
          title={row.title}
          eyebrow={row.category}
          ratio="1:1"
        />
      </div>

      <div className="min-w-0 space-y-2">
        <div>
          <p className="text-brand-eyebrow uppercase text-brand-ink-3">
            {row.category} - {row.organization.name}
          </p>
          <h3 className="font-brand-display text-brand-card text-brand-ink">
            <Link href={`/admin/events/${row.id}`} className={`hover:underline ${BRAND_FOCUS}`}>
              {row.title}
            </Link>
          </h3>
        </div>
        <dl className="grid gap-x-6 gap-y-1 text-brand-meta sm:grid-cols-2">
          <div>
            <dt className="sr-only">Where</dt>
            <dd className="text-brand-ink-2">
              {row.venue.name}, {row.venue.city}
              {country ? `, ${country}` : ''}
            </dd>
          </div>
          <div>
            <dt className="sr-only">When, venue time</dt>
            <dd className="text-brand-ink-2">
              {row.firstSessionAt ? (
                <>
                  {venueWhen(row.firstSessionAt, tz)}
                  {row.sessionCount > 1 && ` + ${row.sessionCount - 1} more`}
                </>
              ) : (
                'No date set'
              )}
            </dd>
          </div>
          <div>
            <dt className="sr-only">Prices</dt>
            <dd className="font-semibold tabular-nums text-brand-ink">
              {detailState === 'loading'
                ? 'Reading prices...'
                : detailState === 'error'
                  ? 'Prices could not be read'
                  : detail?.isFree
                    ? 'Free event'
                    : spans.length === 0
                      ? 'No prices yet'
                      : spans
                          .map((s) =>
                            s.minMinor === s.maxMinor
                              ? money(s.minMinor, s.currency)
                              : `${money(s.minMinor, s.currency)} to ${money(s.maxMinor, s.currency)}`,
                          )
                          .join('; ')}
            </dd>
          </div>
          <div>
            <dt className="sr-only">Waiting</dt>
            <dd className="text-brand-ink-3">Last changed {ageWords(row.updatedAt, now)} ago</dd>
          </div>
        </dl>
        {signals.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label="Check before deciding">
            {signals.map((s) => (
              <li key={s.key}>
                <State tone={SIGNAL_TONE[s.tone]}>{s.words}</State>
              </li>
            ))}
          </ul>
        )}
        {detail?.reviewNote && (
          <p className="text-brand-meta text-brand-ink-2">
            <span className="font-semibold text-brand-ink">Last review note: </span>
            {detail.reviewNote}
          </p>
        )}
      </div>

      <div className="col-span-2 space-y-2 sm:col-span-1 sm:col-start-2 lg:col-start-auto">
        {decided ? (
          <p className="text-brand-ui font-semibold text-brand-ink">
            {decided === 'APPROVE'
              ? 'Approved. The organizer can publish it.'
              : 'Sent back with your reason.'}
          </p>
        ) : rejecting ? (
          <div className="space-y-2">
            <label htmlFor={noteId} className="block text-brand-ui font-semibold text-brand-ink">
              Why are you sending it back?
            </label>
            <textarea
              id={noteId}
              rows={3}
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
                setError(null);
              }}
              aria-invalid={!!error}
              aria-describedby={error ? `${noteId}-err` : `${noteId}-hint`}
              className={`w-full rounded-brand-control border bg-brand-surface p-2 text-brand-ui text-brand-ink ${error ? 'border-2 border-brand-critical' : 'border-brand-field'} ${BRAND_FOCUS}`}
            />
            {error ? (
              <p id={`${noteId}-err`} className="text-brand-meta text-brand-critical">
                {error}
              </p>
            ) : (
              <p id={`${noteId}-hint`} className="text-brand-meta text-brand-ink-3">
                The organizer sees this word for word.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => decide('REJECT')}
                className={brandButtonClasses('primary', 'sm')}
              >
                Send back
              </button>
              <button
                type="button"
                onClick={() => setRejecting(false)}
                className={brandButtonClasses('quiet', 'sm')}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-2 lg:flex-col">
              <button
                type="button"
                disabled={busy}
                onClick={() => decide('APPROVE')}
                className={brandButtonClasses('secondary', 'md')}
              >
                Approve
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setRejecting(true)}
                className={brandButtonClasses('quiet', 'md')}
              >
                Send back with a reason
              </button>
            </div>
            {error && <p className="text-brand-meta text-brand-critical">{error}</p>}
            <Link href={`/admin/events/${row.id}`} className={`${LINK} text-brand-meta`}>
              Full details
            </Link>
          </>
        )}
      </div>
    </li>
  );
}
