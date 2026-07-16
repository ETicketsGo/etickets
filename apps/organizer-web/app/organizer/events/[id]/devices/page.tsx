'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  PauseCircle,
  XCircle,
  AlertTriangle,
  ShieldAlert,
  Plus,
} from 'lucide-react';
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
  useAuthUser,
  useToast,
  hasAnyRole,
  type BadgeTone,
  type Column,
  type CheckInDeviceRow,
} from '@eticketsgo/web-kit';

const MANAGER_ROLES = ['ORGANIZER_OWNER', 'ORGANIZER_MANAGER', 'ADMIN', 'SUPER_ADMIN'];
const PAGE_SIZE = 10;

const STATUS_META: Record<string, { tone: BadgeTone; Icon: typeof Clock }> = {
  PENDING: { tone: 'warning', Icon: Clock },
  ACTIVE: { tone: 'success', Icon: CheckCircle2 },
  SUSPENDED: { tone: 'neutral', Icon: PauseCircle },
  REVOKED: { tone: 'error', Icon: XCircle },
  EXPIRED: { tone: 'error', Icon: AlertTriangle },
};
function StatusCell({ status }: { status: string }) {
  const m = STATUS_META[status] ?? { tone: 'neutral' as BadgeTone, Icon: Clock };
  const Icon = m.Icon;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon className="h-4 w-4 shrink-0" aria-hidden />
      <Badge tone={m.tone}>{status}</Badge>
    </span>
  );
}

type Action = 'approve' | 'suspend' | 'revoke' | 'report-lost';
const ACTION_LABEL: Record<Action, string> = {
  approve: 'Approve device',
  suspend: 'Suspend device',
  revoke: 'Revoke device',
  'report-lost': 'Report device lost',
};
const NEEDS_REASON: Action[] = ['revoke', 'report-lost'];
const DESTRUCTIVE: Action[] = ['suspend', 'revoke', 'report-lost'];

export default function DevicesPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const qc = useQueryClient();
  const { user } = useAuthUser();
  const canManage = hasAnyRole(user, MANAGER_ROLES);

  const { data: event } = useQuery({ queryKey: ['event', id], queryFn: () => api.events.get(id) });
  const orgId = event?.organizationId;

  const devices = useQuery({
    queryKey: ['checkin-devices', orgId, id],
    queryFn: () => api.offlineCheckin.listDevices(orgId!, id),
    enabled: !!orgId,
    retry: false,
  });

  // Active activation decisions — used to warn about downgrade impact before actions.
  const activations = useQuery({
    queryKey: ['activation-decisions', orgId],
    queryFn: () => api.offlineCheckin.listActivations(orgId!),
    enabled: !!orgId && canManage,
    retry: false,
  });
  const deviceInActiveScope = (deviceId: string) =>
    (activations.data ?? []).some((d) => d.state === 'ACTIVE' && d.deviceIds.includes(deviceId));

  const sessionLabel = (sid: string | null) => {
    if (!sid) return 'Event-wide';
    const s = event?.sessions.find((x) => x.id === sid);
    return s ? dateTime(s.startsAt) : sid.slice(0, 8);
  };

  // Search / filter / sort / paginate (client-side; the fleet per event is small).
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [sort, setSort] = useState<'name' | 'lastSeen' | 'status'>('name');
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    let rows = devices.data ?? [];
    if (search.trim())
      rows = rows.filter((d) => d.name.toLowerCase().includes(search.trim().toLowerCase()));
    if (statusFilter) rows = rows.filter((d) => d.status === statusFilter);
    rows = [...rows].sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (sort === 'status') return a.status.localeCompare(b.status);
      const at = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
      const bt = b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0;
      return bt - at;
    });
    return rows;
  }, [devices.data, search, statusFilter, sort]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Register
  const [registerOpen, setRegisterOpen] = useState(false);
  const [name, setName] = useState('');
  const [platform, setPlatform] = useState('');
  const [regSession, setRegSession] = useState('');
  const register = useMutation({
    mutationFn: () =>
      api.offlineCheckin.registerDevice({
        organizationId: orgId!,
        eventId: id,
        eventSessionId: regSession || undefined,
        name: name.trim(),
        platform: platform.trim() || undefined,
      }),
    onSuccess: () => {
      toast.push('Device registered (pending approval).', 'success');
      setRegisterOpen(false);
      setName('');
      setPlatform('');
      qc.invalidateQueries({ queryKey: ['checkin-devices'] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  // Lifecycle action (confirmed)
  const [acting, setActing] = useState<{ device: CheckInDeviceRow; action: Action } | null>(null);
  const [reason, setReason] = useState('');
  const [viewing, setViewing] = useState<CheckInDeviceRow | null>(null);

  const runAction = useMutation({
    mutationFn: () => {
      const { device, action } = acting!;
      if (action === 'approve') return api.offlineCheckin.approveDevice(device.id);
      if (action === 'suspend')
        return api.offlineCheckin.suspendDevice(device.id, reason.trim() || undefined);
      if (action === 'revoke') return api.offlineCheckin.revokeDevice(device.id, reason.trim());
      return api.offlineCheckin.reportLostDevice(device.id, reason.trim());
    },
    onSuccess: () => {
      toast.push('Done.', 'success');
      setActing(null);
      setReason('');
      qc.invalidateQueries({ queryKey: ['checkin-devices'] });
      qc.invalidateQueries({ queryKey: ['command-center'] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const columns: Column<CheckInDeviceRow>[] = [
    {
      key: 'name',
      header: 'Device',
      render: (d) => (
        <button
          className="text-left font-medium text-action-primary hover:underline"
          onClick={() => setViewing(d)}
        >
          {d.name}
        </button>
      ),
    },
    { key: 'status', header: 'Status', render: (d) => <StatusCell status={d.status} /> },
    { key: 'session', header: 'Assigned', render: (d) => sessionLabel(d.eventSessionId) },
    {
      key: 'lastSeen',
      header: 'Last seen',
      render: (d) => (d.lastSeenAt ? dateTime(d.lastSeenAt) : '—'),
    },
    { key: 'manifest', header: 'Manifest', render: (d) => `v${d.manifestVersion}` },
    {
      key: 'expires',
      header: 'Expires',
      render: (d) => (d.expiresAt ? dateTime(d.expiresAt) : '—'),
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (d) =>
        canManage ? (
          <div className="flex flex-wrap gap-1.5">
            {d.status !== 'ACTIVE' && d.status !== 'REVOKED' && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setActing({ device: d, action: 'approve' })}
              >
                Approve
              </Button>
            )}
            {d.status === 'ACTIVE' && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setActing({ device: d, action: 'suspend' })}
              >
                Suspend
              </Button>
            )}
            {d.status !== 'REVOKED' && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setActing({ device: d, action: 'revoke' })}
                >
                  Revoke
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => setActing({ device: d, action: 'report-lost' })}
                >
                  Lost
                </Button>
              </>
            )}
          </div>
        ) : (
          <span className="text-xs text-text-muted">View only</span>
        ),
    },
  ];

  const impact =
    acting && DESTRUCTIVE.includes(acting.action) && deviceInActiveScope(acting.device.id);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Offline devices</h2>
          <p className="text-caption text-text-muted">
            Register, approve, suspend, revoke and report devices. State changes are audited; the
            server enforces activation + readiness rules.
          </p>
        </div>
        {canManage && (
          <Button onClick={() => setRegisterOpen(true)}>
            <Plus className="h-4 w-4" /> Register device
          </Button>
        )}
      </div>

      <Card>
        <div className="grid gap-3 sm:grid-cols-3">
          <Input
            id="d-search"
            label="Search"
            placeholder="Device name…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
          <Select
            id="d-status"
            label="Status"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All statuses</option>
            {['PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED'].map((st) => (
              <option key={st} value={st}>
                {st}
              </option>
            ))}
          </Select>
          <Select
            id="d-sort"
            label="Sort by"
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
          >
            <option value="name">Name</option>
            <option value="lastSeen">Last seen</option>
            <option value="status">Status</option>
          </Select>
        </div>
      </Card>

      <DataTable
        columns={columns}
        rows={pageRows}
        loading={devices.isLoading}
        error={devices.isError ? "We couldn't load devices. Please try again." : undefined}
        onRetry={() => devices.refetch()}
        empty={<EmptyState title="No devices" hint="Register a device to get started." />}
        rowKey={(d) => d.id}
      />
      {totalPages > 1 && <Pagination page={page} totalPages={totalPages} onChange={setPage} />}

      {/* Register dialog */}
      <Dialog
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
        title="Register device"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setRegisterOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={register.isPending}
              disabled={!name.trim()}
              onClick={() => register.mutate()}
            >
              Register
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-text-secondary">
            The device is created as <strong>pending</strong> and must be approved before it can
            validate offline.
          </p>
          <Input
            id="reg-name"
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            id="reg-platform"
            label="Platform (optional)"
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
          />
          <Select
            id="reg-session"
            label="Assigned session (optional)"
            value={regSession}
            onChange={(e) => setRegSession(e.target.value)}
          >
            <option value="">Event-wide</option>
            {event?.sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {dateTime(s.startsAt)}
              </option>
            ))}
          </Select>
        </div>
      </Dialog>

      {/* Confirm action dialog */}
      <Dialog
        open={!!acting}
        onClose={() => {
          setActing(null);
          setReason('');
        }}
        title={acting ? ACTION_LABEL[acting.action] : ''}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setActing(null);
                setReason('');
              }}
            >
              Cancel
            </Button>
            <Button
              variant={acting && DESTRUCTIVE.includes(acting.action) ? 'danger' : 'primary'}
              loading={runAction.isPending}
              disabled={acting ? NEEDS_REASON.includes(acting.action) && !reason.trim() : true}
              onClick={() => runAction.mutate()}
            >
              Confirm
            </Button>
          </div>
        }
      >
        {acting && (
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">
              {ACTION_LABEL[acting.action]} “
              <span className="font-medium text-text-primary">{acting.device.name}</span>”?
            </p>
            {impact && (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-md border border-status-warning/30 bg-status-warning/10 px-3 py-2 text-sm text-status-warning"
              >
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>
                  <strong>Activation impact:</strong> this device is part of an active activation.
                  {acting.action === 'approve'
                    ? ''
                    : ' The server will immediately downgrade that scope to NO_GO (mustDowngrade). This does not bypass any rule — it enforces them.'}
                </span>
              </p>
            )}
            {NEEDS_REASON.includes(acting.action) && (
              <Textarea
                id="action-reason"
                label="Reason (required)"
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why is this happening?"
              />
            )}
          </div>
        )}
      </Dialog>

      {/* View details dialog */}
      <Dialog
        open={!!viewing}
        onClose={() => setViewing(null)}
        title="Device details"
        footer={
          <div className="flex justify-end">
            <Button variant="outline" onClick={() => setViewing(null)}>
              Close
            </Button>
          </div>
        }
      >
        {viewing && (
          <dl className="grid grid-cols-3 gap-x-3 gap-y-2 text-sm">
            <dt className="text-text-muted">Name</dt>
            <dd className="col-span-2 text-text-primary">{viewing.name}</dd>
            <dt className="text-text-muted">Status</dt>
            <dd className="col-span-2">
              <StatusCell status={viewing.status} />
            </dd>
            <dt className="text-text-muted">Approval</dt>
            <dd className="col-span-2 text-text-primary">
              {viewing.status === 'PENDING' ? 'Awaiting approval' : 'Approved / decided'}
            </dd>
            <dt className="text-text-muted">Assigned</dt>
            <dd className="col-span-2 text-text-primary">{sessionLabel(viewing.eventSessionId)}</dd>
            <dt className="text-text-muted">Platform</dt>
            <dd className="col-span-2 text-text-primary">{viewing.platform ?? '—'}</dd>
            <dt className="text-text-muted">Last seen</dt>
            <dd className="col-span-2 text-text-primary">
              {viewing.lastSeenAt ? dateTime(viewing.lastSeenAt) : 'Never'}
            </dd>
            <dt className="text-text-muted">Manifest</dt>
            <dd className="col-span-2 text-text-primary">v{viewing.manifestVersion}</dd>
            <dt className="text-text-muted">Expires</dt>
            <dd className="col-span-2 text-text-primary">
              {viewing.expiresAt ? dateTime(viewing.expiresAt) : '—'}
            </dd>
          </dl>
        )}
      </Dialog>
    </div>
  );
}
