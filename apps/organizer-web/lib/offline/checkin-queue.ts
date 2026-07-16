// Durable offline check-in queue (ADR-035) for the organizer gate app. IndexedDB-
// backed so accepted offline scans survive refresh/restart and are never lost.
// Records are only cleared after the SERVER acknowledges them. The pure validation +
// reconciliation logic and the retry/backoff policy live in @eticketsgo/shared-types;
// this is durable transport + the local duplicate ledger + resilient retry/dead-letter.

import {
  classifyQueueFailure,
  isSyncEligible,
  planRetry,
  type ManifestEntry,
  type OfflineCheckInResult,
  type QueueFailure,
  type QueuedCheckIn,
  type DecodedQr,
} from '@eticketsgo/shared-types';

const DB_NAME = 'etg-checkin';
const DB_VERSION = 1;
const QUEUE = 'queue';
const MANIFEST = 'manifest';

export type QueueStatus =
  | 'PENDING'
  | 'SYNCING'
  | 'RETRYING'
  | 'BLOCKED'
  | 'ACCEPTED'
  | 'DUPLICATE'
  | 'CONFLICT'
  | 'REJECTED'
  | 'REVIEW_REQUIRED';

export interface QueueRecord {
  localId: string;
  ticketId: string;
  deviceId: string;
  eventSessionId: string;
  nonce: string;
  version: number;
  result: OfflineCheckInResult;
  status: QueueStatus;
  outcome: string | null;
  scannedAt: number;
  idempotencyKey: string;
  // Retry metadata (resilient sync).
  retryCount: number;
  lastAttemptAt: number | null;
  nextAttemptAt: number | null;
  failureCategory: string | null;
  failureMessage: string | null;
}

function hasIdb(): boolean {
  return typeof window !== 'undefined' && 'indexedDB' in window;
}

/**
 * Whether durable offline queueing is available in this browser. When false (e.g.
 * IndexedDB disabled/private mode), offline scans cannot be persisted — the operator
 * must be warned rather than silently losing scans.
 */
export function isQueueDurable(): boolean {
  return hasIdb();
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(QUEUE)) db.createObjectStore(QUEUE, { keyPath: 'localId' });
      if (!db.objectStoreNames.contains(MANIFEST))
        db.createObjectStore(MANIFEST, { keyPath: 'eventSessionId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      }),
  );
}

/** Local id without Math.random dependence issues in restricted contexts. */
function localId(ticketId: string): string {
  return `${ticketId}-${Date.now()}-${performance.now().toString(36).replace('.', '')}`;
}

/** Back-fills retry fields on records written before resilience was added. */
function normalize(r: QueueRecord): QueueRecord {
  const p = r as Partial<QueueRecord>;
  return {
    ...r,
    retryCount: p.retryCount ?? 0,
    lastAttemptAt: p.lastAttemptAt ?? null,
    nextAttemptAt: p.nextAttemptAt ?? null,
    failureCategory: p.failureCategory ?? null,
    failureMessage: p.failureMessage ?? null,
  };
}

export async function enqueueCheckIn(
  input: Omit<
    QueueRecord,
    | 'localId'
    | 'status'
    | 'outcome'
    | 'idempotencyKey'
    | 'retryCount'
    | 'lastAttemptAt'
    | 'nextAttemptAt'
    | 'failureCategory'
    | 'failureMessage'
  >,
): Promise<QueueRecord> {
  const record: QueueRecord = {
    ...input,
    localId: localId(input.ticketId),
    status: 'PENDING',
    outcome: null,
    idempotencyKey: `${input.deviceId}:${input.ticketId}:${input.nonce}`,
    retryCount: 0,
    lastAttemptAt: null,
    nextAttemptAt: null,
    failureCategory: null,
    failureMessage: null,
  };
  if (hasIdb()) await tx(QUEUE, 'readwrite', (s) => s.put(record));
  return record;
}

export async function listQueue(): Promise<QueueRecord[]> {
  if (!hasIdb()) return [];
  try {
    const all = (await tx<QueueRecord[]>(QUEUE, 'readonly', (s) => s.getAll())) ?? [];
    return all.map(normalize);
  } catch {
    return [];
  }
}

/** Applies a partial patch to a record atomically (used for status + retry updates). */
async function patchRecord(id: string, patch: Partial<QueueRecord>): Promise<void> {
  if (!hasIdb()) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(QUEUE, 'readwrite');
    const store = t.objectStore(QUEUE);
    const get = store.get(id);
    get.onsuccess = () => {
      const rec = get.result as QueueRecord | undefined;
      if (rec) store.put({ ...normalize(rec), ...patch });
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
  db.close();
}

/** Kept for backward compatibility with existing callers/tests. */
export async function updateQueueStatus(
  id: string,
  status: QueueStatus,
  outcome: string | null,
): Promise<void> {
  await patchRecord(id, { status, outcome });
}

/** Ticket ids already scanned on this device — the local duplicate ledger. */
export async function localCheckedIn(): Promise<Set<string>> {
  const all = await listQueue();
  return new Set(all.filter((r) => r.status !== 'REJECTED').map((r) => r.ticketId));
}

/**
 * Records eligible to sync NOW (fresh PENDING or a RETRYING record past its backoff),
 * in scan order (ordered sync preserved). BLOCKED (dead-letter) and server-terminal
 * records are excluded — only a deliberate manual retry re-queues a blocked record.
 */
export async function eligibleCheckIns(
  now: number,
): Promise<{ records: QueueRecord[]; payload: QueuedCheckIn[] }> {
  const records = (await listQueue())
    .filter((r) => isSyncEligible(r, now))
    .sort((a, b) => a.scannedAt - b.scannedAt);
  const payload: QueuedCheckIn[] = records.map((r) => ({
    ticketId: r.ticketId,
    deviceId: r.deviceId,
    nonce: r.nonce,
    version: r.version,
    eventSessionId: r.eventSessionId,
    checkedInAt: r.scannedAt,
    wasOverride: false,
  }));
  return { records, payload };
}

/** Marks a set of records in-flight before a sync attempt. */
export async function markSyncing(ids: string[]): Promise<void> {
  for (const id of ids) await patchRecord(id, { status: 'SYNCING' });
}

function outcomeToStatus(outcome: string | undefined): QueueStatus {
  if (outcome === 'ACCEPTED') return 'ACCEPTED';
  if (outcome?.startsWith('DUPLICATE')) return 'DUPLICATE';
  if (outcome === 'SUPERVISOR_REVIEW_REQUIRED') return 'REVIEW_REQUIRED';
  return 'CONFLICT';
}

/**
 * Applies authoritative per-record server outcomes. ACCEPTED/DUPLICATE clear retry
 * metadata; conflicts/reviews are terminal (server wins) — never retried, never
 * silently promoted to ACCEPTED. Returns the outcome map for the caller/UI.
 */
export async function applyOutcomes(
  records: QueueRecord[],
  results: { ticketId: string; outcome: string }[],
): Promise<void> {
  const byTicket = new Map(results.map((r) => [r.ticketId, r.outcome]));
  for (const rec of records) {
    const outcome = byTicket.get(rec.ticketId);
    await patchRecord(rec.localId, {
      status: outcomeToStatus(outcome),
      outcome: outcome ?? null,
      failureCategory: null,
      failureMessage: null,
      nextAttemptAt: null,
    });
  }
}

/**
 * Applies a transport failure to attempted records: schedules a backoff retry, or
 * dead-letters (BLOCKED) when non-retryable or the retry budget is exhausted. Records
 * are never dropped and never marked ACCEPTED.
 */
export async function applyFailure(
  records: QueueRecord[],
  input: 'network' | number,
  now: number,
): Promise<QueueFailure> {
  const failure = classifyQueueFailure(input);
  for (const rec of records) {
    const plan = planRetry(rec.retryCount, failure, now);
    await patchRecord(rec.localId, {
      status: plan.disposition,
      retryCount: plan.retryCount,
      lastAttemptAt: plan.lastAttemptAt,
      nextAttemptAt: plan.nextAttemptAt,
      failureCategory: plan.failureCategory,
      failureMessage: plan.failureMessage,
    });
  }
  return failure;
}

/** Removes only records the server has acknowledged (ACCEPTED/DUPLICATE). */
export async function clearAcknowledged(): Promise<void> {
  const all = await listQueue();
  if (!hasIdb()) return;
  const db = await openDb();
  const t = db.transaction(QUEUE, 'readwrite');
  const store = t.objectStore(QUEUE);
  for (const r of all)
    if (r.status === 'ACCEPTED' || r.status === 'DUPLICATE') store.delete(r.localId);
  await new Promise<void>((resolve) => {
    t.oncomplete = () => resolve();
  });
  db.close();
}

/** Dead-letter records (BLOCKED) needing operator attention. */
export async function deadLetterRecords(): Promise<QueueRecord[]> {
  return (await listQueue()).filter((r) => r.status === 'BLOCKED');
}

/**
 * Re-queues a dead-lettered record for another sync attempt (reset backoff). Safe:
 * the server remains authoritative — a manual retry can never mark a scan ACCEPTED,
 * only re-submit it for the server to decide.
 */
export async function manualRetryRecord(id: string): Promise<void> {
  const all = await listQueue();
  const rec = all.find((r) => r.localId === id);
  if (!rec || rec.status !== 'BLOCKED') return;
  await patchRecord(id, { status: 'PENDING', retryCount: 0, nextAttemptAt: null });
}

/** Counts by state for operator visibility + preflight/command-center metrics. */
export interface QueueMetrics {
  pending: number;
  retrying: number;
  blocked: number;
  conflicts: number;
  review: number;
  total: number;
}
export async function queueMetrics(): Promise<QueueMetrics> {
  const all = await listQueue();
  return {
    pending: all.filter((r) => r.status === 'PENDING' || r.status === 'SYNCING').length,
    retrying: all.filter((r) => r.status === 'RETRYING').length,
    blocked: all.filter((r) => r.status === 'BLOCKED').length,
    conflicts: all.filter((r) => r.status === 'CONFLICT' || r.status === 'REJECTED').length,
    review: all.filter((r) => r.status === 'REVIEW_REQUIRED').length,
    total: all.length,
  };
}

/** Safe JSON diagnostic of dead-letter records (no secrets — ids + failure only). */
export async function exportDeadLetter(): Promise<string> {
  const rows = (await deadLetterRecords()).map((r) => ({
    ticketId: r.ticketId,
    deviceId: r.deviceId,
    eventSessionId: r.eventSessionId,
    scannedAt: r.scannedAt,
    retryCount: r.retryCount,
    lastAttemptAt: r.lastAttemptAt,
    failureCategory: r.failureCategory,
    failureMessage: r.failureMessage,
    outcome: r.outcome,
  }));
  return JSON.stringify({ exportedAt: Date.now(), count: rows.length, records: rows }, null, 2);
}

// ── Manifest cache (per session) ──
interface ManifestRecord {
  eventSessionId: string;
  meta: unknown;
  entries: ManifestEntry[];
  savedAt: number;
}

export async function saveManifest(
  eventSessionId: string,
  meta: unknown,
  entries: ManifestRecord['entries'],
): Promise<void> {
  if (!hasIdb()) return;
  await tx(MANIFEST, 'readwrite', (s) =>
    s.put({ eventSessionId, meta, entries, savedAt: Date.now() } satisfies ManifestRecord),
  );
}

export async function loadManifest(eventSessionId: string): Promise<ManifestRecord | null> {
  if (!hasIdb()) return null;
  try {
    return (
      (await tx<ManifestRecord | undefined>(MANIFEST, 'readonly', (s) => s.get(eventSessionId))) ??
      null
    );
  } catch {
    return null;
  }
}

/** Decodes a scanned QR token (base64url JSON) without verifying its signature. */
export function decodeQr(token: string): DecodedQr | null {
  try {
    const json = JSON.parse(atob(token.replace(/-/g, '+').replace(/_/g, '/'))) as {
      ticketId?: string;
      eventSessionId?: string;
      nonce?: string;
      version?: number;
    };
    if (!json.ticketId || !json.eventSessionId || !json.nonce) return null;
    return {
      ticketId: json.ticketId,
      eventSessionId: json.eventSessionId,
      nonce: json.nonce,
      version: json.version ?? 1,
    };
  } catch {
    return null;
  }
}
