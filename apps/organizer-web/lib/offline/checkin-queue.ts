// Durable offline check-in queue (ADR-035) for the organizer gate app. IndexedDB-
// backed so accepted offline scans survive refresh/restart and are never lost.
// Records are only cleared after the SERVER acknowledges them. The pure validation
// + reconciliation logic lives in @eticketsgo/shared-types; this is just durable
// transport + the local duplicate ledger.

import type {
  DecodedQr,
  ManifestEntry,
  OfflineCheckInResult,
  QueuedCheckIn,
} from '@eticketsgo/shared-types';

const DB_NAME = 'etg-checkin';
const DB_VERSION = 1;
const QUEUE = 'queue';
const MANIFEST = 'manifest';

export type QueueStatus =
  'PENDING' | 'SYNCING' | 'ACCEPTED' | 'DUPLICATE' | 'CONFLICT' | 'REJECTED' | 'REVIEW_REQUIRED';

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
}

function hasIdb(): boolean {
  return typeof window !== 'undefined' && 'indexedDB' in window;
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

export async function enqueueCheckIn(
  input: Omit<QueueRecord, 'localId' | 'status' | 'outcome' | 'idempotencyKey'>,
): Promise<QueueRecord> {
  const record: QueueRecord = {
    ...input,
    localId: localId(input.ticketId),
    status: 'PENDING',
    outcome: null,
    idempotencyKey: `${input.deviceId}:${input.ticketId}:${input.nonce}`,
  };
  if (hasIdb()) await tx(QUEUE, 'readwrite', (s) => s.put(record));
  return record;
}

export async function listQueue(): Promise<QueueRecord[]> {
  if (!hasIdb()) return [];
  try {
    return (await tx<QueueRecord[]>(QUEUE, 'readonly', (s) => s.getAll())) ?? [];
  } catch {
    return [];
  }
}

export async function updateQueueStatus(
  localId: string,
  status: QueueStatus,
  outcome: string | null,
): Promise<void> {
  if (!hasIdb()) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(QUEUE, 'readwrite');
    const store = t.objectStore(QUEUE);
    const get = store.get(localId);
    get.onsuccess = () => {
      const rec = get.result as QueueRecord | undefined;
      if (rec) store.put({ ...rec, status, outcome });
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
  db.close();
}

/** Ticket ids already queued on this device — the local duplicate ledger. */
export async function localCheckedIn(): Promise<Set<string>> {
  const all = await listQueue();
  return new Set(all.filter((r) => r.status !== 'REJECTED').map((r) => r.ticketId));
}

/** PENDING records mapped to the server's QueuedCheckIn shape, in scan order. */
export async function pendingCheckIns(): Promise<{
  records: QueueRecord[];
  payload: QueuedCheckIn[];
}> {
  const all = (await listQueue())
    .filter((r) => r.status === 'PENDING' || r.status === 'SYNCING')
    .sort((a, b) => a.scannedAt - b.scannedAt);
  const payload: QueuedCheckIn[] = all.map((r) => ({
    ticketId: r.ticketId,
    deviceId: r.deviceId,
    nonce: r.nonce,
    version: r.version,
    eventSessionId: r.eventSessionId,
    checkedInAt: r.scannedAt,
    wasOverride: false,
  }));
  return { records: all, payload };
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
