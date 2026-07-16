// Multi-tab synchronization coordination for the offline gate (ADR-035). Ensures only
// ONE browser tab acts as the sync leader for a given device at a time, so concurrent
// tabs never submit the same queue independently. Progressive enhancement:
//   1. Web Locks API (navigator.locks) — the browser auto-releases the lock on tab
//      close/crash/refresh, giving free leader takeover.
//   2. localStorage lease fallback with a stale-lease takeover.
//   3. If neither is available, run directly — the server's per-record idempotency
//      key remains the ultimate guard against a double check-in.

export type CoordinationMode = 'weblocks' | 'storage' | 'none';

export function coordinationMode(): CoordinationMode {
  if (typeof navigator !== 'undefined' && 'locks' in navigator) return 'weblocks';
  if (typeof window !== 'undefined' && 'localStorage' in window) return 'storage';
  return 'none';
}

const LEASE_MS = 15_000;
function leaseKey(deviceId: string): string {
  return `etg_sync_leader_${deviceId}`;
}
let TAB_ID: string | null = null;
function tabId(): string {
  if (TAB_ID) return TAB_ID;
  try {
    TAB_ID = crypto.randomUUID();
  } catch {
    TAB_ID = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  return TAB_ID;
}

/**
 * Runs `fn` only if this tab can become the sync leader for `deviceId` right now.
 * Returns `{ ran: false }` when another tab already holds leadership (the caller
 * should simply skip this cycle — the leader will handle the queue). Never throws for
 * coordination reasons.
 */
export async function runAsSyncLeader<T>(
  deviceId: string,
  fn: () => Promise<T>,
): Promise<{ ran: boolean; result?: T }> {
  const mode = coordinationMode();

  if (mode === 'weblocks') {
    // ifAvailable → the callback runs with `null` when the lock is already held.
    return navigator.locks.request(
      `etg-sync-${deviceId}`,
      { ifAvailable: true },
      async (lock): Promise<{ ran: boolean; result?: T }> => {
        if (!lock) return { ran: false };
        return { ran: true, result: await fn() };
      },
    );
  }

  if (mode === 'storage') {
    const key = leaseKey(deviceId);
    const now = Date.now();
    let held: { tabId: string; ts: number } | null = null;
    try {
      held = JSON.parse(window.localStorage.getItem(key) ?? 'null');
    } catch {
      held = null;
    }
    const fresh = held && now - held.ts < LEASE_MS && held.tabId !== tabId();
    if (fresh) return { ran: false };
    // Claim (or renew) the lease, run, then release.
    window.localStorage.setItem(key, JSON.stringify({ tabId: tabId(), ts: now }));
    try {
      const result = await fn();
      return { ran: true, result };
    } finally {
      try {
        const current = JSON.parse(window.localStorage.getItem(key) ?? 'null');
        if (current?.tabId === tabId()) window.localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    }
  }

  // No coordination primitive — run directly; the server idempotency key is the guard.
  const result = await fn();
  return { ran: true, result };
}

/** Cross-tab "queue changed" notifier so follower tabs refresh their view. */
export function queueChannel(deviceId: string): {
  post: () => void;
  subscribe: (cb: () => void) => () => void;
} {
  let bc: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      bc = new BroadcastChannel(`etg-queue-${deviceId}`);
    } catch {
      bc = null;
    }
  }
  return {
    post: () => {
      try {
        bc?.postMessage('changed');
      } catch {
        /* ignore */
      }
    },
    subscribe: (cb: () => void) => {
      if (!bc) return () => {};
      const handler = () => cb();
      bc.addEventListener('message', handler);
      return () => bc?.removeEventListener('message', handler);
    },
  };
}
