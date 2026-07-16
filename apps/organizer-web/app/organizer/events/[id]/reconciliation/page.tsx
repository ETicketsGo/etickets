'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Info, RefreshCw } from 'lucide-react';
import {
  api,
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  Input,
  Pagination,
  Select,
  Textarea,
  dateTime,
  errorMessage,
  useToast,
  type BadgeTone,
  type Column,
  type ReconciliationRow,
  type ReconcileResolutionAction,
} from '@eticketsgo/web-kit';
import {
  RECONCILE_META,
  RECONCILE_OUTCOMES,
  allowedReconcileResolutions,
} from '@eticketsgo/shared-types';

const TONE: Record<'success' | 'info' | 'warning' | 'danger', BadgeTone> = {
  success: 'success',
  info: 'neutral',
  warning: 'warning',
  danger: 'error',
};
// Icon per tone so status is never communicated by colour alone.
function OutcomeIcon({ tone }: { tone: 'success' | 'info' | 'warning' | 'danger' }) {
  const cls = 'h-4 w-4 shrink-0';
  if (tone === 'success') return <CheckCircle2 className={cls} aria-hidden />;
  if (tone === 'danger') return <XCircle className={cls} aria-hidden />;
  if (tone === 'warning') return <AlertTriangle className={cls} aria-hidden />;
  return <Info className={cls} aria-hidden />;
}

const REVIEW_LABEL: Record<string, string> = {
  NOT_REQUIRED: 'No action',
  PENDING: 'Needs review',
  RESOLVED: 'Resolved',
};

export default function ReconciliationConsole() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const qc = useQueryClient();

  const { data: event } = useQuery({ queryKey: ['event', id], queryFn: () => api.events.get(id) });
  const orgId = event?.organizationId;

  const devices = useQuery({
    queryKey: ['checkin-devices', orgId, id],
    queryFn: () => api.offlineCheckin.listDevices(orgId!, id),
    enabled: !!orgId,
    retry: false,
  });

  const [page, setPage] = useState(1);
  const [sessionId, setSessionId] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [outcome, setOutcome] = useState('');
  const [reviewState, setReviewState] = useState('');
  const [ticketId, setTicketId] = useState('');
  const resetPage = () => setPage(1);

  const list = useQuery({
    queryKey: [
      'reconciliation',
      orgId,
      id,
      sessionId,
      deviceId,
      outcome,
      reviewState,
      ticketId,
      page,
    ],
    queryFn: () =>
      api.offlineCheckin.reconciliation({
        organizationId: orgId!,
        eventId: id,
        eventSessionId: sessionId || undefined,
        deviceId: deviceId || undefined,
        outcome: outcome || undefined,
        reviewState: reviewState || undefined,
        ticketId: ticketId || undefined,
        page,
        pageSize: 20,
      }),
    enabled: !!orgId,
    retry: false,
  });

  const [resolving, setResolving] = useState<ReconciliationRow | null>(null);
  const [action, setAction] = useState<ReconcileResolutionAction>('ACKNOWLEDGED');
  const [reason, setReason] = useState('');

  const resolve = useMutation({
    mutationFn: () =>
      api.offlineCheckin.resolveReconciliation(resolving!.id, action, reason.trim()),
    onSuccess: () => {
      toast.push('Case resolved.', 'success');
      setResolving(null);
      setReason('');
      qc.invalidateQueries({ queryKey: ['reconciliation'] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const columns: Column<ReconciliationRow>[] = [
    {
      key: 'ticket',
      header: 'Ticket',
      render: (r) => <span className="font-mono text-xs">{r.ticketId.slice(0, 12)}…</span>,
    },
    {
      key: 'outcome',
      header: 'Outcome',
      render: (r) => {
        const meta = RECONCILE_META[r.outcome];
        return (
          <span className="inline-flex items-center gap-1.5">
            <OutcomeIcon tone={meta.tone} />
            <Badge tone={TONE[meta.tone]}>{meta.label}</Badge>
          </span>
        );
      },
    },
    {
      key: 'review',
      header: 'Status',
      render: (r) => (
        <span className="text-sm text-text-secondary">{REVIEW_LABEL[r.reviewState]}</span>
      ),
    },
    {
      key: 'device',
      header: 'Device',
      render: (r) => <span className="font-mono text-xs">{r.deviceId.slice(0, 8)}</span>,
    },
    { key: 'operator', header: 'Operator', render: (r) => r.operator?.email ?? '—' },
    { key: 'scanned', header: 'Scanned (device)', render: (r) => dateTime(r.localScannedAt) },
    { key: 'reconciled', header: 'Reconciled (server)', render: (r) => dateTime(r.reconciledAt) },
    {
      key: 'action',
      header: 'Action',
      render: (r) =>
        allowedReconcileResolutions(r.outcome, r.reviewState).length > 0 ? (
          <Button variant="outline" size="sm" onClick={() => setResolving(r)}>
            Resolve
          </Button>
        ) : r.reviewState === 'RESOLVED' ? (
          <span className="text-xs text-text-muted" title={r.resolutionReason ?? ''}>
            {r.resolutionAction} · {r.resolvedBy?.email ?? ''}
          </span>
        ) : (
          <span className="text-xs text-text-muted">—</span>
        ),
    },
  ];

  const resolutionOptions = resolving
    ? allowedReconcileResolutions(resolving.outcome, resolving.reviewState)
    : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Reconciliation console</h2>
          <p className="text-caption text-text-muted">
            Offline scans reconciled by the server. The server always wins — resolving a case is an
            audit-only annotation and never admits a ticket.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-caption text-text-muted" aria-live="polite">
            {list.isFetching
              ? 'Refreshing…'
              : list.dataUpdatedAt
                ? `Updated ${dateTime(new Date(list.dataUpdatedAt).toISOString())}`
                : ''}
          </span>
          <Button variant="outline" size="sm" onClick={() => list.refetch()}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        </div>
      </div>

      <Card>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Select
            id="f-session"
            label="Session"
            value={sessionId}
            onChange={(e) => {
              setSessionId(e.target.value);
              resetPage();
            }}
          >
            <option value="">All sessions</option>
            {event?.sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {dateTime(s.startsAt)}
              </option>
            ))}
          </Select>
          <Select
            id="f-device"
            label="Device"
            value={deviceId}
            onChange={(e) => {
              setDeviceId(e.target.value);
              resetPage();
            }}
          >
            <option value="">All devices</option>
            {devices.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
          <Select
            id="f-outcome"
            label="Outcome"
            value={outcome}
            onChange={(e) => {
              setOutcome(e.target.value);
              resetPage();
            }}
          >
            <option value="">All outcomes</option>
            {RECONCILE_OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {RECONCILE_META[o].label}
              </option>
            ))}
          </Select>
          <Select
            id="f-review"
            label="Review status"
            value={reviewState}
            onChange={(e) => {
              setReviewState(e.target.value);
              resetPage();
            }}
          >
            <option value="">Any status</option>
            <option value="PENDING">Needs review</option>
            <option value="RESOLVED">Resolved</option>
            <option value="NOT_REQUIRED">No action</option>
          </Select>
          <Input
            id="f-ticket"
            label="Ticket reference"
            placeholder="Ticket id…"
            value={ticketId}
            onChange={(e) => {
              setTicketId(e.target.value);
              resetPage();
            }}
          />
        </div>
      </Card>

      <DataTable
        columns={columns}
        rows={list.data?.data}
        loading={list.isLoading}
        error={
          list.isError ? "We couldn't load reconciliation activity. Please try again." : undefined
        }
        onRetry={() => list.refetch()}
        empty={
          <EmptyState
            title="No reconciliation activity"
            hint="No records match these filters yet."
          />
        }
        rowKey={(r) => r.id}
      />
      {list.data && list.data.meta.totalPages > 1 && (
        <Pagination
          page={list.data.meta.page}
          totalPages={list.data.meta.totalPages}
          onChange={setPage}
        />
      )}

      <Dialog
        open={!!resolving}
        onClose={() => setResolving(null)}
        title="Resolve reconciliation case"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setResolving(null)}>
              Cancel
            </Button>
            <Button
              loading={resolve.isPending}
              disabled={!reason.trim() || resolutionOptions.length === 0}
              onClick={() => resolve.mutate()}
            >
              Record resolution
            </Button>
          </div>
        }
      >
        {resolving && (
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">
              This records an audit-only decision on{' '}
              <span className="font-medium text-text-primary">
                {RECONCILE_META[resolving.outcome].label}
              </span>{' '}
              for ticket{' '}
              <span className="font-mono text-xs">{resolving.ticketId.slice(0, 12)}</span>. It does
              not change the outcome or admit the ticket.
            </p>
            <Select
              id="r-action"
              label="Decision"
              value={action}
              onChange={(e) => setAction(e.target.value as ReconcileResolutionAction)}
            >
              {resolutionOptions.map((a) => (
                <option key={a} value={a}>
                  {a === 'ACKNOWLEDGED' ? 'Acknowledge (reviewed)' : 'Dismiss (not admissible)'}
                </option>
              ))}
            </Select>
            <Textarea
              id="r-reason"
              label="Reason (required)"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this being resolved?"
            />
          </div>
        )}
      </Dialog>
    </div>
  );
}
