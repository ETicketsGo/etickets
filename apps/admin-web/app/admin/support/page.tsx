'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
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

/*
  Complaint first, because it is the one a person has to act on.

  A complaint is not a contact message: it is somebody saying an organizer wronged them, it is
  recorded against that organizer, and how many are open decides whether that organizer keeps
  selling. Before this it arrived as CONTACT with nothing attaching it to anybody.
*/
const KINDS = ['COMPLAINT', 'CONTACT', 'BUG', 'FEATURE', 'GENERAL', 'CSAT', 'ORGANIZER_CSAT'];
const STATUSES: FeedbackStatusValue[] = ['OPEN', 'TRIAGED', 'CLOSED'];

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
    The organizer page links straight here with an organizer and a kind in the URL, so the link
    lands on the complaints about that organizer rather than on the whole inbox. Read once as the
    initial state: after that the selects own the filters, and a link that kept overriding them
    would make the dropdowns look broken.
  */
  const params = useSearchParams();
  const [organizationId, setOrganizationId] = useState(params.get('organizationId') ?? '');
  const [page, setPage] = useState(1);
  const [kind, setKind] = useState(params.get('kind') ?? '');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const [selected, setSelected] = useState<FeedbackRow | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin', 'support', page, kind, status, applied, organizationId],
    queryFn: () =>
      api.admin.support({
        page,
        pageSize: 15,
        kind: kind || undefined,
        status: status || undefined,
        q: applied || undefined,
        organizationId: organizationId || undefined,
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
            {r.user?.email ?? r.email ?? 'Anonymous'}
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
      {organizationId && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-background-subtle/50 p-3">
          <p className="text-sm text-text-secondary">
            Showing submissions about one organizer only.
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setOrganizationId('');
              setPage(1);
            }}
          >
            Show every organizer
          </Button>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-[1fr_180px_180px]">
        <SearchInput
          value={q}
          onChange={setQ}
          onSubmit={() => {
            setApplied(q);
            setPage(1);
          }}
          placeholder="Search message, subject, or email…"
        />
        <Select
          aria-label="Kind filter"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All kinds</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {kindLabel(k)}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Status filter"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {kindLabel(s)}
            </option>
          ))}
        </Select>
      </div>
      <DataTable
        columns={columns}
        rows={data?.data}
        loading={isLoading}
        error={isError ? "We couldn't load this. Please try again." : undefined}
        onRetry={() => refetch()}
        empty={<EmptyState title="No submissions match these filters" />}
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
                  ? `${selected.user.fullName} (${selected.user.email})`
                  : (selected.email ?? 'Anonymous')}
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
