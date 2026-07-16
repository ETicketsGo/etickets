'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CloudOff, RefreshCw, ShieldCheck } from 'lucide-react';
import {
  api,
  Badge,
  Button,
  Card,
  Input,
  Select,
  StatusBadge,
  errorMessage,
  useOnline,
  useToast,
  type SignedManifest,
} from '@eticketsgo/web-kit';
import {
  validateOfflineScan,
  type ManifestEntry,
  type OfflineCheckInResult,
} from '@eticketsgo/shared-types';
import {
  clearAcknowledged,
  decodeQr,
  enqueueCheckIn,
  listQueue,
  loadManifest,
  localCheckedIn,
  pendingCheckIns,
  saveManifest,
  updateQueueStatus,
  type QueueRecord,
} from '@/lib/offline/checkin-queue';

const OK_RESULTS: OfflineCheckInResult[] = ['VALID'];

/**
 * Offline gate operations panel (ADR-035). Register + approve a device, download a
 * signed manifest, scan tickets offline against it (durably queued), then sync on
 * reconnect. The server remains authoritative — this never grants final entry.
 * Rendered only where the offline feature flag is enabled (endpoints 404 otherwise).
 */
export function OfflineCheckin({
  organizationId,
  eventId,
  sessions,
}: {
  organizationId: string;
  eventId: string;
  sessions: { id: string; startsAt: string }[];
}) {
  const online = useOnline();
  const toast = useToast();
  const deviceKey = `etg_checkin_device_${eventId}`;
  const [deviceId, setDeviceIdState] = useState<string | null>(null);
  const setDeviceId = (id: string | null) => {
    setDeviceIdState(id);
    try {
      if (id) window.localStorage.setItem(deviceKey, id);
      else window.localStorage.removeItem(deviceKey);
    } catch {
      /* ignore */
    }
  };
  // Restore the approved device across reloads so an offline queue can still sync.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(deviceKey);
      if (saved) setDeviceIdState(saved);
    } catch {
      /* ignore */
    }
  }, [deviceKey]);
  const [sessionId, setSessionId] = useState(sessions[0]?.id ?? '');
  const [manifest, setManifest] = useState<SignedManifest | null>(null);
  const [token, setToken] = useState('');
  const [lastResult, setLastResult] = useState<OfflineCheckInResult | null>(null);
  const [queue, setQueue] = useState<QueueRecord[]>([]);

  const refreshQueue = useCallback(() => listQueue().then(setQueue), []);
  useEffect(() => {
    refreshQueue();
  }, [refreshQueue]);

  // Register + approve THIS device (owner/manager approves their own device).
  const setupDevice = async () => {
    try {
      const dev = await api.offlineCheckin.registerDevice({
        organizationId,
        eventId,
        name: `Gate ${new Date().toISOString().slice(11, 16)}`,
        platform: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 60) : 'web',
      });
      const approved = await api.offlineCheckin.approveDevice(dev.id);
      setDeviceId(approved.id);
      toast.push('Device registered and approved.', 'success');
    } catch (e) {
      toast.push(errorMessage(e), 'error');
    }
  };

  const downloadManifest = async () => {
    if (!sessionId) return;
    try {
      const m = await api.offlineCheckin.manifest(sessionId);
      setManifest(m);
      await saveManifest(sessionId, m.meta, m.entries);
      toast.push(`Manifest downloaded — ${m.entries.length} tickets.`, 'success');
    } catch (e) {
      toast.push(errorMessage(e), 'error');
    }
  };

  // Hydrate a cached manifest when offline.
  useEffect(() => {
    if (manifest || !sessionId) return;
    loadManifest(sessionId).then((rec) => {
      if (rec)
        setManifest({
          meta: rec.meta as SignedManifest['meta'],
          entries: rec.entries,
          signature: '',
        });
    });
  }, [sessionId, manifest]);

  const entriesMap = useMemo(() => {
    const map = new Map<string, ManifestEntry>();
    manifest?.entries.forEach((e) => map.set(e.ticketId, e));
    return map;
  }, [manifest]);

  const scanOffline = async () => {
    if (!manifest || !deviceId) {
      toast.push('Set up a device and download the manifest first.', 'info');
      return;
    }
    const decoded = decodeQr(token.trim());
    const result = validateOfflineScan({
      decoded,
      meta: manifest.meta,
      entries: entriesMap,
      device: {
        organizationId,
        eventId,
        eventSessionId: manifest.meta.eventSessionId,
        active: true,
      },
      now: Date.now(),
      localCheckedIn: await localCheckedIn(),
      expectedSessionId: sessionId || undefined,
    });
    setLastResult(result);

    if (OK_RESULTS.includes(result) && decoded) {
      await enqueueCheckIn({
        ticketId: decoded.ticketId,
        deviceId,
        eventSessionId: decoded.eventSessionId,
        nonce: decoded.nonce,
        version: decoded.version,
        result,
        scannedAt: Date.now(),
      });
      toast.push('Queued for sync.', 'success');
    }
    setToken('');
    refreshQueue();
  };

  const sync = async () => {
    if (!deviceId) return;
    const { records, payload } = await pendingCheckIns();
    if (payload.length === 0) {
      toast.push('Nothing to sync.', 'info');
      return;
    }
    try {
      const results = await api.offlineCheckin.reconcile(deviceId, payload);
      const byTicket = new Map(results.map((r) => [r.ticketId, r.outcome]));
      for (const rec of records) {
        const outcome = byTicket.get(rec.ticketId);
        const status =
          outcome === 'ACCEPTED'
            ? 'ACCEPTED'
            : outcome?.startsWith('DUPLICATE')
              ? 'DUPLICATE'
              : outcome === 'SUPERVISOR_REVIEW_REQUIRED'
                ? 'REVIEW_REQUIRED'
                : 'CONFLICT';
        await updateQueueStatus(rec.localId, status, outcome ?? null);
      }
      await clearAcknowledged();
      await refreshQueue();
      toast.push('Synced.', 'success');
    } catch (e) {
      toast.push(errorMessage(e), 'error');
    }
  };

  const pending = queue.filter((r) => r.status === 'PENDING' || r.status === 'SYNCING').length;
  const conflicts = queue.filter(
    (r) => r.status === 'CONFLICT' || r.status === 'REVIEW_REQUIRED',
  ).length;

  return (
    <Card
      title="Offline mode"
      action={<Badge tone={online ? 'success' : 'warning'}>{online ? 'Online' : 'Offline'}</Badge>}
    >
      <div className="space-y-4">
        <p className="text-caption text-text-muted">
          Scans validate against a signed manifest and queue durably; the server reconciles on
          reconnect and remains the authority.
        </p>

        {/* Device + manifest preflight */}
        <div className="grid gap-2 sm:grid-cols-2">
          <Button variant="outline" onClick={setupDevice} disabled={!!deviceId || !online}>
            <ShieldCheck className="h-4 w-4" />{' '}
            {deviceId ? 'Device approved' : 'Register + approve device'}
          </Button>
          <Button variant="outline" onClick={downloadManifest} disabled={!sessionId || !online}>
            <CloudOff className="h-4 w-4" /> Download manifest
          </Button>
        </div>

        <Select
          id="offline-session"
          label="Session"
          value={sessionId}
          onChange={(e) => {
            setSessionId(e.target.value);
            setManifest(null);
          }}
        >
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {new Date(s.startsAt).toLocaleString()}
            </option>
          ))}
        </Select>

        {manifest && (
          <p className="text-caption text-text-muted" data-testid="manifest-status">
            Manifest ready · {manifest.entries.length} tickets · v{manifest.meta.version}
          </p>
        )}

        {/* Offline scan (manual token entry; camera reuses the online scanner) */}
        <div className="flex gap-2">
          <Input
            id="offline-token"
            aria-label="Ticket QR token"
            placeholder="Paste ticket QR token…"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className="flex-1"
          />
          <Button onClick={scanOffline} disabled={!manifest || !deviceId}>
            Validate
          </Button>
        </div>

        {lastResult && (
          <div
            role="status"
            aria-live="polite"
            data-testid="offline-result"
            className={`rounded-md border px-3 py-2 text-[0.9375rem] font-medium ${
              lastResult === 'VALID'
                ? 'border-status-success/30 bg-status-success/10 text-status-success'
                : 'border-status-warning/30 bg-status-warning/10 text-status-warning'
            }`}
          >
            {lastResult === 'VALID' ? 'Valid — queued offline' : lastResult.replaceAll('_', ' ')}
          </div>
        )}

        {/* Queue health + sync */}
        <div className="flex items-center justify-between border-t border-border pt-3">
          <span className="text-caption text-text-secondary" data-testid="queue-count">
            {pending} queued · {conflicts} conflicts
          </span>
          <Button size="sm" variant="outline" onClick={sync} disabled={!online || pending === 0}>
            <RefreshCw className="h-3.5 w-3.5" /> Sync now
          </Button>
        </div>

        {queue.length > 0 && (
          <ul className="space-y-1.5" aria-label="Offline check-in queue">
            {queue.slice(0, 8).map((r) => (
              <li
                key={r.localId}
                className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-caption"
              >
                <span className="font-mono text-text-muted">{r.ticketId.slice(0, 12)}…</span>
                <StatusBadge status={r.status} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
