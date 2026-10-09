'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  api,
  DataTable,
  StatusBadge,
  Badge,
  Button,
  Dialog,
  RatingStars,
  Select,
  SearchInput,
  Pagination,
  PageHeader,
  EmptyState,
  dateTime,
  errorMessage,
  useToast,
  type Column,
  type FeedbackRow,
  type FeedbackStatusValue,
} from '@eticketsgo/web-kit';
import { accountContactText } from '../../../components/account-contact';
import {
  FilterBar,
  apiFilters,
  useFilterDescription,
  useUrlFilters,
} from '../../../components/list-filters';

/*
  Complaint first, because it is the one a person has to act on.

  A complaint is not a contact message: it is somebody saying an organizer wronged them, it is
  recorded against that organizer, and how many are open decides whether that organizer keeps
  selling. Before this it arrived as CONTACT with nothing attaching it to anybody.
*/
const KINDS = ['COMPLAINT', 'CONTACT', 'BUG', 'FEATURE', 'GENERAL', 'CSAT', 'ORGANIZER_CSAT'];
const STATUSES: FeedbackStatusValue[] = ['OPEN', 'TRIAGED', 'CLOSED'];
const FILTER_KEYS = [
  'country',
  'organizationId',
  'eventId',
  'kind',
  'status',
  'from',
  'to',
  'q',
] as const;

const KIND_TONE: Record<string, 'info' | 'error' | 'warning' | 'success' | 'neutral'> = {
  COMPLAINT: 'error',
  CONTACT: 'info',
  BUG: 'error',
  FEATURE: 'warning',
  GENERAL: 'neutral',
  CSAT: 'success',
  ORGANIZER_CSAT: 'success',
};

function kindLabel(kind: string) {
  return kind
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ');
}

export default function AdminSupport() {
  const toast = useToast();
  const qc = useQueryClient();
  /*
    Every filter lives in the URL. The organizer page links here with an organizer and a kind,
    and the action centre with a status; those links are now simply the filters they name, and
    a filtered inbox can be refreshed or sent to a colleague without losing them.
  */
  const filters = useUrlFilters(FILTER_KEYS);
  const { kind, status, q: applied } = filters.values;
  const [q, setQ] = useState(applied);
  const [page, setPage] = useState(1);
  const scope = apiFilters(filters.values);
  const described = useFilterDescription(
    filters.values,
    [{ name: 'Kind', value: kind || undefined }],
    applied,
  );
  const clearAll = () => {
    setQ('');
    filters.clear();
  };

  useEffect(() => setPage(1), [filters.signature]);
  const [selected, setSelected] = useState<FeedbackRow | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin', 'support', page, filters.signature],
    enabled: !filters.invalidWindow,
    queryFn: () =>
      api.admin.support({
        page,
        pageSize: 15,
        ...scope,
        kind: kind || undefined,
        status: status || undefined,
        q: applied || undefined,
      }),
  });

  const mutation = useMutation({
    mutationFn: ({ id, next }: { id: string; next: FeedbackStatusValue }) =>
      api.admin.updateSupport(id, next),
    onSuccess: (res) => {
      toast.push(`Marked ${kindLabel(res.status)}.`, 'success');
      qc.invalidateQueries({ queryKey: ['admin', 'support'] });
      setSelected((s) => (s ? { ...s, status: res.status } : s));
    },
    onError: (err) => toast.push(errorMessage(err), 'error'),
  });

  const columns: Column<FeedbackRow>[] = [
    {
      key: 'kind',
      header: 'Kind',
      render: (r) => <Badge tone={KIND_TONE[r.kind] ?? 'neutral'}>{kindLabel(r.kind)}</Badge>,
    },
    /*
      Sender, organizer and message in ONE cell.

      They were three columns beside three more, which is what made this table - and most of the
      admin console - wider than the screen. Read as a block they are the submission: what it
      says, who said it, and who it is about.
    */
    {
      key: 'message',
      header: 'Submission',
      render: (r) => (
        <div className="min-w-0 space-y-1">
          {r.subject && <p className="font-medium text-text-primary">{r.subject}</p>}
          <p className="line-clamp-2 text-text-secondary">{r.message}</p>
          <p className="text-caption text-text-muted">
            {accountContactText(r.user?.email ?? r.email) ?? 'Anonymous'}
            {r.organizationName ? ` · about ${r.organizationName}` : ''}
            {r.bookingReference ? ` · ${r.bookingReference}` : ''}
          </p>
          {r.rating ? <RatingStars value={r.rating} size="sm" /> : null}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      className: 'whitespace-nowrap',
      render: (r) => (
        <div className="space-y-1">
          <StatusBadge status={r.status} />
          <p className="text-caption text-text-muted">{dateTime(r.createdAt)}</p>
        </div>
      ),
      sortable: true,
      sortValue: (r) => r.createdAt,
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Support and complaints"
        description="Complaints about organizers, contact messages, bug reports and satisfaction surveys."
      />
      <div className="space-y-4 rounded-lg border border-border bg-background-surface p-4">
        <SearchInput
          value={q}
          onChange={setQ}
          onSubmit={() => filters.set({ q: q.trim() })}
          placeholder="Search message, subject, or email"
        />
        <FilterBar
          filters={{ ...filters, clear: clearAll }}
          statuses={STATUSES}
          countryHint="Where the organizer is registered. A message about no organizer is in no country."
        >
          <Select label="Kind" value={kind} onChange={(e) => filters.set({ kind: e.target.value })}>
            <option value="">Every kind</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {kindLabel(k)}
              </option>
            ))}
          </Select>
        </FilterBar>
      </div>
      <DataTable
        columns={columns}
        rows={data?.data}
        loading={isLoading}
        error={isError ? "We couldn't load this. Please try again." : undefined}
        onRetry={() => refetch()}
        empty={
          <EmptyState
            title="No submissions match these filters"
            hint={described ? `Nothing matches ${described}.` : undefined}
            action={
              filters.active ? (
                <Button variant="outline" onClick={clearAll}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        }
        rowKey={(r) => r.id}
        onRowClick={(r) => setSelected(r)}
      />
      {data && (
        <Pagination page={data.meta.page} totalPages={data.meta.totalPages} onChange={setPage} />
      )}

      <Dialog
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected ? kindLabel(selected.kind) : 'Submission'}
        footer={
          selected && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {STATUSES.map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={selected.status === s ? 'primary' : 'outline'}
                  disabled={selected.status === s || mutation.isPending}
                  loading={mutation.isPending && mutation.variables?.next === s}
                  onClick={() => mutation.mutate({ id: selected.id, next: s })}
                >
                  {kindLabel(s)}
                </Button>
              ))}
            </div>
          )
        }
      >
        {selected && (
          <div className="space-y-4 text-text-secondary">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={KIND_TONE[selected.kind] ?? 'neutral'}>{kindLabel(selected.kind)}</Badge>
              <StatusBadge status={selected.status} />
              {selected.rating && <RatingStars value={selected.rating} size="sm" />}
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[0.9375rem]">
              <dt className="text-text-muted">From</dt>
              <dd className="text-text-primary">
                {selected.user
                  ? [selected.user.fullName, accountContactText(selected.user.email)]
                      .filter(Boolean)
                      .join(' - ')
                  : (accountContactText(selected.email) ?? 'Anonymous')}
              </dd>
              <dt className="text-text-muted">Account</dt>
              <dd className="text-text-primary">{selected.userId ? 'Signed-in user' : 'Guest'}</dd>
              <dt className="text-text-muted">Received</dt>
              <dd className="text-text-primary">{dateTime(selected.createdAt)}</dd>
              {selected.organizationName && (
                <>
                  <dt className="text-text-muted">About</dt>
                  <dd className="text-text-primary">
                    <Link
                      href={`/admin/organizers/${selected.organizationId}`}
                      className="text-action-primary underline-offset-4 hover:underline"
                    >
                      {selected.organizationName}
                    </Link>
                  </dd>
                </>
              )}
              {selected.bookingReference && (
                <>
                  <dt className="text-text-muted">Booking</dt>
                  <dd className="font-mono text-text-primary">{selected.bookingReference}</dd>
                </>
              )}
            </dl>
            {selected.subject && (
              <div>
                <p className="text-caption font-semibold uppercase tracking-wide text-text-muted">
                  Subject
                </p>
                <p className="mt-1 font-medium text-text-primary">{selected.subject}</p>
              </div>
            )}
            <div>
              <p className="text-caption font-semibold uppercase tracking-wide text-text-muted">
                Message
              </p>
              <p className="mt-1 whitespace-pre-wrap text-text-primary">{selected.message}</p>
            </div>
            {selected.metadata && Object.keys(selected.metadata).length > 0 && (
              <div>
                <p className="text-caption font-semibold uppercase tracking-wide text-text-muted">
                  Metadata
                </p>
                <pre className="mt-1 overflow-x-auto rounded-md bg-background-subtle p-3 text-caption text-text-secondary">
                  {JSON.stringify(selected.metadata, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}
      </Dialog>
    </div>
  );
}
