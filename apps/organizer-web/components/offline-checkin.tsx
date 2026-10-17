'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CloudOff, RefreshCw, ShieldCheck } from 'lucide-react';
import {
  api,
  ApiRequestError,
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
  manifestNeedsRefresh,
  validateOfflineScan,
  type ManifestEntry,
  type OfflineCheckInResult,
} from '@eticketsgo/shared-types';
import {
  applyFailure,
  applyOutcomes,
  clearAcknowledged,
  clearManifest,
  decodeQr,
  eligibleCheckIns,
  enqueueCheckIn,
  exportDeadLetter,
  isQueueDurable,
  listQueue,
  loadManifest,
  localCheckedIn,
  manualRetryRecord,
  markSyncing,
  saveManifest,
  type QueueRecord,
} from '@/lib/offline/checkin-queue';
import { queueChannel, runAsSyncLeader } from '@/lib/offline/sync-coordinator';
import {
  deviceRefusalMessage,
  listValidUntilMessage,
  offlineAdmission,
  offlineResultMessage,
} from '@/lib/offline/offline-messages';

const OK_RESULTS: OfflineCheckInResult[] = ['VALID'];

/** How often the panel looks at the clock: to stop admitting on time and to refresh early. */
const LIST_TICK_MS = 15_000;

const clockTime = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

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
  /*
    H5: set when the server says this device is no longer ACTIVE (suspended, revoked, expired
    or never approved). The panel then stops admitting, forgets its list, and says why.
  */
  const [deviceProblem, setDeviceProblem] = useState<string | null>(null);
  // Re-rendered on a timer so an expiring list stops admitting on time, not on the next click.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), LIST_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const [queue, setQueue] = useState<QueueRecord[]>([]);
  // Durable queueing requires IndexedDB; warn (never silently lose scans) if absent.
  const [durable, setDurable] = useState(true);
  useEffect(() => setDurable(isQueueDurable()), []);

  const refreshQueue = useCallback(() => listQueue().then(setQueue), []);
  useEffect(() => {
    refreshQueue();
  }, [refreshQueue]);

  // Follower tabs refresh their queue view when the leader tab syncs (multi-tab).
  useEffect(() => {
    if (!deviceId) return;
    const ch = queueChannel(deviceId);
    return ch.subscribe(() => refreshQueue());
  }, [deviceId, refreshQueue]);

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

  /** A device the server no longer trusts keeps no list it could admit from (H5). */
  const stopForDevice = useCallback(
    async (message: string) => {
      setDeviceProblem(message);
      setManifest(null);
      // A green "Valid" from before the refusal must not stay on screen beside it.
      setLastResult(null);
      if (sessionId) await clearManifest(sessionId);
    },
    [sessionId],
  );

  const downloadManifest = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!sessionId || !deviceId) return;
      try {
        const m = await api.offlineCheckin.manifest(sessionId, deviceId);
        setManifest(m);
        setDeviceProblem(null);
        await saveManifest(sessionId, m.meta, m.entries, m.signature);
        if (!opts.silent)
          toast.push(`Ticket list downloaded: ${m.entries.length} tickets.`, 'success');
      } catch (e) {
        const refused = deviceRefusalMessage(e, false);
        if (refused) await stopForDevice(refused);
        else if (!opts.silent) toast.push(errorMessage(e), 'error');
      }
    },
    [sessionId, deviceId, toast, stopForDevice],
  );

  // Hydrate a cached manifest when offline: only one issued to THIS device (H5).
  useEffect(() => {
    if (manifest || !sessionId || !deviceId) return;
    loadManifest(sessionId).then((rec) => {
      const meta = rec?.meta as SignedManifest['meta'] | undefined;
      if (rec && meta?.deviceId === deviceId)
        setManifest({ meta, entries: rec.entries, signature: rec.signature ?? '' });
    });
  }, [sessionId, deviceId, manifest]);

  /*
    Refresh the list early whenever there is signal (H5). A list is valid only for the offline
    revocation window, so a door that is online now and then always holds one with time left,
    and only a door with no signal for the whole window stops admitting offline.
  */
  useEffect(() => {
    if (!online || !deviceId || !manifest || deviceProblem) return;
    if (manifestNeedsRefresh(manifest.meta, now)) void downloadManifest({ silent: true });
  }, [online, deviceId, manifest, deviceProblem, now, downloadManifest]);

  const admission = deviceProblem
    ? { canAdmit: false, message: deviceProblem }
    : offlineAdmission(manifest?.meta ?? null, deviceId, now, clockTime);

  const entriesMap = useMemo(() => {
    const map = new Map<string, ManifestEntry>();
    manifest?.entries.forEach((e) => map.set(e.ticketId, e));
    return map;
  }, [manifest]);

  const scanOffline = async () => {
    // Checked again at the moment of the scan: the list may have run out since the last tick.
    const at = Date.now();
    const gate = deviceProblem
      ? { canAdmit: false, message: deviceProblem }
      : offlineAdmission(manifest?.meta ?? null, deviceId, at, clockTime);
    if (!manifest || !deviceId || !gate.canAdmit) {
      setNow(at);
      toast.push(gate.message ?? 'Set up this device and download the ticket list first.', 'info');
      return;
    }
    const decoded = decodeQr(token.trim());
    const result = validateOfflineScan({
      decoded,
      meta: manifest.meta,
      entries: entriesMap,
      device: {
        deviceId,
        organizationId,
        eventId,
        eventSessionId: manifest.meta.eventSessionId,
        active: true,
      },
      now: at,
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
        scannedAt: at,
        manifestVersion: manifest.meta.version,
        manifestSignature: manifest.signature,
      });
      toast.push('Queued for sync.', 'success');
    }
    setToken('');
    refreshQueue();
  };

  const doSync = useCallback(
    async (opts: { silent?: boolean } = {}): Promise<void> => {
      if (!deviceId) return;
      const now = Date.now();
      const { records, payload } = await eligibleCheckIns(now);
      if (payload.length === 0) {
        if (!opts.silent) toast.push('Nothing to sync.', 'info');
        return;
      }
      const ch = queueChannel(deviceId);
      // Only the sync LEADER for this device submits — other tabs skip this cycle so
      // the same queue is never submitted twice concurrently.
      const outcome = await runAsSyncLeader(deviceId, async () => {
        await markSyncing(records.map((r) => r.localId));
        try {
          const results = await api.offlineCheckin.reconcile(deviceId, payload);
          await applyOutcomes(records, results);
          await clearAcknowledged();
          return { ok: true as const };
        } catch (e) {
          // Classify the failure: HTTP status (retryable 5xx/429 vs authoritative 4xx)
          // or a network error. Records are never dropped — they retry or dead-letter.
          const status = e instanceof ApiRequestError ? (e.status ?? 'network') : 'network';
          const failure = await applyFailure(records, status, Date.now());
          // A device that is no longer ACTIVE: the scans are held on the server for a manager,
          // and this device stops admitting (H5).
          const refused = deviceRefusalMessage(e, true);
          if (refused) await stopForDevice(refused);
          return { ok: false as const, message: refused ?? failure.message };
        }
      });

      if (!outcome.ran) {
        if (!opts.silent) toast.push('Another tab is handling sync for this device.', 'info');
        return;
      }
      await refreshQueue();
      ch.post();
      if (opts.silent) return;
      if (outcome.result?.ok) toast.push('Synced.', 'success');
      else toast.push(outcome.result?.message ?? 'Sync failed — will retry.', 'warning');
    },
    [deviceId, refreshQueue, toast, stopForDevice],
  );

  const sync = () => doSync();

  // Automatic, backoff-respecting retry ONLY for records already in a RETRYING backoff
  // whose next-attempt time has elapsed. Fresh scans are never auto-submitted here (the
  // operator syncs those) — this timer just drains transient failures once they are due.
  useEffect(() => {
    if (!deviceId || !online) return;
    const timer = setInterval(async () => {
      const now = Date.now();
      const q = await listQueue();
      const dueRetry = q.some(
        (r) => r.status === 'RETRYING' && r.nextAttemptAt != null && r.nextAttemptAt <= now,
      );
      if (dueRetry) void doSync({ silent: true });
    }, 3_000);
    return () => clearInterval(timer);
  }, [deviceId, online, doSync]);

  const retryBlocked = async () => {
    const blocked = queue.filter((r) => r.status === 'BLOCKED');
    for (const r of blocked) await manualRetryRecord(r.localId);
    await refreshQueue();
    if (blocked.length) toast.push(`${blocked.length} record(s) re-queued for retry.`, 'success');
  };

  const copyDeadLetter = async () => {
    try {
      const json = await exportDeadLetter();
      // Clipboard needs a secure context; fall back to a file download otherwise.
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(json);
        toast.push('Dead-letter diagnostic copied to clipboard.', 'success');
      } else {
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = 'offline-deadletter.json';
        a.click();
        URL.revokeObjectURL(url);
        toast.push('Dead-letter diagnostic downloaded.', 'success');
      }
    } catch {
      toast.push('Could not export the diagnostic.', 'error');
    }
  };

  const pending = queue.filter(
    (r) => r.status === 'PENDING' || r.status === 'SYNCING' || r.status === 'RETRYING',
  ).length;
  const retrying = queue.filter((r) => r.status === 'RETRYING').length;
  const blocked = queue.filter((r) => r.status === 'BLOCKED').length;
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

        {!durable && (
          <div
            role="alert"
            data-testid="durability-warning"
            className="rounded-md border border-status-error/30 bg-tint-error px-3 py-2 text-caption text-status-error"
          >
            Durable offline queueing is unavailable in this browser (IndexedDB disabled). Do not
            rely on offline mode here — use a supported browser, or stay online.
          </div>
        )}

        {/* Device + manifest preflight */}
        <div className="grid gap-2 sm:grid-cols-2">
          <Button variant="outline" onClick={setupDevice} disabled={!!deviceId || !online}>
            <ShieldCheck className="h-4 w-4" />{' '}
            {deviceId ? 'Device approved' : 'Register + approve device'}
          </Button>
          <Button
            variant="outline"
            onClick={() => downloadManifest()}
            disabled={!sessionId || !deviceId || !online}
          >
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

        {manifest && admission.canAdmit && (
          <p className="text-caption text-text-muted" data-testid="manifest-status">
            Manifest ready · {manifest.entries.length} tickets · v{manifest.meta.version}.{' '}
            {listValidUntilMessage(manifest.meta, clockTime)}
          </p>
        )}

        {/* H5: why this device will not admit offline right now, in plain words. */}
        {(deviceProblem || (manifest && !admission.canAdmit)) && admission.message && (
          <div
            role="alert"
            data-testid="offline-stopped"
            className="rounded-md border border-status-error/30 bg-tint-error px-3 py-2 text-caption text-status-error"
          >
            {admission.message}
          </div>
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
          <Button onClick={scanOffline} disabled={!admission.canAdmit}>
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
                ? 'border-status-success/30 bg-tint-success text-status-success'
                : 'border-status-warning/30 bg-tint-warning text-status-warning'
            }`}
          >
            {offlineResultMessage(lastResult)}
          </div>
        )}

        {/* Queue health + sync */}
        <div className="flex items-center justify-between border-t border-border pt-3">
          <span className="text-caption text-text-secondary" data-testid="queue-count">
            {pending} queued · {retrying} retrying · {blocked} blocked · {conflicts} conflicts
          </span>
          <Button size="sm" variant="outline" onClick={sync} disabled={!online || pending === 0}>
            <RefreshCw className="h-3.5 w-3.5" /> Sync now
          </Button>
        </div>

        {blocked > 0 && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-status-error/30 bg-tint-error px-3 py-2 text-caption text-status-error"
            data-testid="deadletter-banner"
          >
            <span>
              {blocked} scan(s) could not sync and are held (not lost, not admitted). Retry when the
              cause is fixed, or copy the diagnostic.
            </span>
            <span className="flex gap-2">
              <Button size="sm" variant="outline" onClick={retryBlocked} disabled={!online}>
                Retry blocked
              </Button>
              <Button size="sm" variant="ghost" onClick={copyDeadLetter}>
                Copy diagnostic
              </Button>
            </span>
          </div>
        )}

        {queue.length > 0 && (
          <ul className="space-y-1.5" aria-label="Offline check-in queue">
            {queue.slice(0, 8).map((r) => (
              <li
                key={r.localId}
                className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-caption"
              >
                <span className="min-w-0">
                  <span className="font-mono text-text-muted">{r.ticketId.slice(0, 12)}…</span>
                  {r.failureMessage && (r.status === 'RETRYING' || r.status === 'BLOCKED') && (
                    <span className="block text-text-muted">
                      {r.failureMessage}
                      {r.status === 'RETRYING' && r.retryCount > 0 && ` (attempt ${r.retryCount})`}
                    </span>
                  )}
                </span>
                <StatusBadge status={r.status} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
