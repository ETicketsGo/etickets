// Versioned IndexedDB repository for the offline Experience Wallet (ADR-034).
// Replaces the localStorage snapshot as the primary offline store. Records are
// namespaced by user id (no cross-user leakage), hold only offline-eligible items
// with the minimum needed to render a pass, and are purged on logout / transfer /
// refund / revoke (via re-sync replacement). No tokens or secrets are stored.

import { offlineEligibleTickets, type WalletTicket } from '@eticketsgo/web-kit';

const DB_NAME = 'etg-offline';
const DB_VERSION = 1;
const WALLET_STORE = 'wallet';

export interface OfflineWalletRecord {
  userId: string;
  schemaVersion: number;
  syncedAt: number;
  items: WalletTicket[];
}

function hasIdb(): boolean {
  return typeof window !== 'undefined' && 'indexedDB' in window;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // OfflineMigrationRunner: create/upgrade object stores across PWA versions.
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(WALLET_STORE)) {
        db.createObjectStore(WALLET_STORE, { keyPath: 'userId' });
      }
      // Future migrations: switch on req.oldVersion → add stores/indexes here.
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Strips the raw signed QR token; the scannable QR image (qrDataUrl) is kept. */
function minimize(t: WalletTicket): WalletTicket {
  const { qrToken: _drop, ...rest } = t;
  void _drop;
  return rest;
}

/** Persists the offline-eligible slice of a user's wallet. Best-effort. */
export async function saveWallet(userId: string, tickets: WalletTicket[]): Promise<void> {
  if (!hasIdb() || !userId) return;
  const items = offlineEligibleTickets(tickets).map(minimize);
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(WALLET_STORE, 'readwrite');
      tx.objectStore(WALLET_STORE).put({
        userId,
        schemaVersion: DB_VERSION,
        syncedAt: Date.now(),
        items,
      } satisfies OfflineWalletRecord);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Quota / private-mode failures are non-fatal — online still works.
  }
}

/** Loads a user's cached wallet, or null when none / unavailable. */
export async function loadWallet(userId: string): Promise<OfflineWalletRecord | null> {
  if (!hasIdb() || !userId) return null;
  try {
    const db = await openDb();
    const record = await new Promise<OfflineWalletRecord | null>((resolve, reject) => {
      const tx = db.transaction(WALLET_STORE, 'readonly');
      const req = tx.objectStore(WALLET_STORE).get(userId);
      req.onsuccess = () => resolve((req.result as OfflineWalletRecord) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return record;
  } catch {
    return null;
  }
}

/** Removes one user's cached wallet (logout / account switch / shared device). */
export async function purgeUser(userId: string): Promise<void> {
  if (!hasIdb() || !userId) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(WALLET_STORE, 'readwrite');
      tx.objectStore(WALLET_STORE).delete(userId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* ignore */
  }
}

/** Wipes ALL offline wallet data on this device ("Clear offline data"). */
export async function clearAllOffline(): Promise<void> {
  if (!hasIdb()) return;
  try {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  } catch {
    /* ignore */
  }
}

/** Best-effort storage estimate for the storage-used summary. */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}
