// Connectivity model (ADR-034 hardening). The customer wallet must show an offline indicator
// whenever the app truly cannot reach its own API — even if `navigator.onLine` is stale or wrong
// (notably after an offline reload, where Chromium can report `onLine === true` on a page restored
// from the service-worker cache). We therefore combine TWO signals:
//
//   1. the browser hint  — `navigator.onLine` + the `online`/`offline` window events, and
//   2. API-origin reachability — set by the shared `request()` client: a network-level fetch
//      failure marks the origin unreachable; ANY HTTP response (including 4xx/5xx) marks it
//      reachable (an application error is NOT a connectivity problem).
//
// The state is a module-level external store consumed via `useSyncExternalStore`, so it is
// hydration-safe (SSR renders `UNKNOWN`), attaches its window listeners exactly once, and reflects
// connectivity changes that happen before a component mounts. No polling loop — reachability is
// event-driven off the requests the app already makes.

import type { OfflineSyncState } from './offline-eligibility';

export type ConnectivityState = 'ONLINE' | 'DEGRADED' | 'OFFLINE' | 'UNKNOWN';

export interface ConnectivitySnapshot {
  state: ConnectivityState;
  browserOnline: boolean;
  /** null until the first request resolves; true = reachable, false = network-level failure. */
  apiReachable: boolean | null;
  lastOnlineAt: number | null;
  lastFailureAt: number | null;
  reason: 'BROWSER_OFFLINE' | 'API_UNREACHABLE' | 'RECENT_SUCCESS' | 'INITIALIZING';
}

interface State {
  browserOnline: boolean;
  apiReachable: boolean | null;
  lastOnlineAt: number | null;
  lastFailureAt: number | null;
}

/**
 * Pure connectivity classification — the single source of truth, exported for unit testing.
 *
 *  - OFFLINE   : the browser reports offline (definitive).
 *  - DEGRADED  : the browser claims online, but our API origin is confirmed unreachable at the
 *                network level — treat as "effectively offline" for the wallet (stale `onLine`,
 *                captive portal, or API down). Surfaces the offline indicator.
 *  - ONLINE    : browser online AND a recent request reached the origin.
 *  - UNKNOWN   : browser online, no request evidence yet (initial hydration).
 */
export function deriveConnectivity(s: {
  browserOnline: boolean;
  apiReachable: boolean | null;
}): ConnectivityState {
  if (!s.browserOnline) return 'OFFLINE';
  if (s.apiReachable === false) return 'DEGRADED';
  if (s.apiReachable === true) return 'ONLINE';
  return 'UNKNOWN';
}

/**
 * Derive the user-facing wallet sync label from connectivity + query state. Offline/degraded
 * connectivity is AUTHORITATIVE and takes precedence over an in-flight (doomed) background fetch,
 * so the user always sees they are offline rather than a misleading "Syncing…"/"Up to date". An
 * HTTP application error (4xx/5xx) never produces an offline state — it is reported as FAILED.
 */
export function deriveSyncState(opts: {
  hasToken: boolean;
  connectivity: ConnectivityState;
  isFetching: boolean;
  hasData: boolean;
  isError: boolean;
}): OfflineSyncState {
  if (!opts.hasToken) return 'REQUIRES_SIGN_IN';
  if (opts.connectivity === 'OFFLINE' || opts.connectivity === 'DEGRADED') {
    return opts.hasData ? 'STALE' : 'OFFLINE';
  }
  if (opts.isFetching) return 'SYNCING';
  if (opts.hasData) return 'CURRENT';
  if (opts.isError) return 'FAILED';
  return 'SYNCING';
}

/**
 * Read the browser online hint safely. In a real browser `navigator.onLine` is a boolean; in
 * non-DOM environments (SSR, the Node global `navigator` which has no `onLine`) it is absent — we
 * default to `true` ("assume online until a request proves otherwise") so connectivity resolves via
 * API reachability rather than defaulting to a false offline.
 */
function readBrowserOnline(): boolean {
  return typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean'
    ? true
    : navigator.onLine;
}

const listeners = new Set<() => void>();
let state: State = {
  browserOnline: readBrowserOnline(),
  apiReachable: null,
  lastOnlineAt: null,
  lastFailureAt: null,
};
let cached: ConnectivitySnapshot | null = null;

function reasonFor(s: State): ConnectivitySnapshot['reason'] {
  if (!s.browserOnline) return 'BROWSER_OFFLINE';
  if (s.apiReachable === false) return 'API_UNREACHABLE';
  if (s.apiReachable === true) return 'RECENT_SUCCESS';
  return 'INITIALIZING';
}

function setState(patch: Partial<State>): void {
  const next: State = { ...state, ...patch };
  if (
    next.browserOnline === state.browserOnline &&
    next.apiReachable === state.apiReachable &&
    next.lastOnlineAt === state.lastOnlineAt &&
    next.lastFailureAt === state.lastFailureAt
  ) {
    return; // no meaningful change → no re-render churn
  }
  state = next;
  cached = null; // invalidate the memoized snapshot
  for (const l of listeners) l();
}

/** Called by the API client on a successful HTTP response (any status ⇒ the origin is reachable). */
export function markApiReachable(now: number = Date.now()): void {
  setState({ apiReachable: true, lastOnlineAt: now });
}

/** Called by the API client on a network-level failure (fetch threw before any response). */
export function markApiUnreachable(now: number = Date.now()): void {
  setState({ apiReachable: false, lastFailureAt: now });
}

let browserListenersAttached = false;
function ensureBrowserListeners(): void {
  if (browserListenersAttached || typeof window === 'undefined') return;
  browserListenersAttached = true;
  const update = (): void => setState({ browserOnline: readBrowserOnline() });
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update(); // capture the current value (an offline event before mount is not missed)
}

const SERVER_SNAPSHOT: ConnectivitySnapshot = {
  state: 'UNKNOWN',
  browserOnline: true,
  apiReachable: null,
  lastOnlineAt: null,
  lastFailureAt: null,
  reason: 'INITIALIZING',
};

export function subscribeConnectivity(cb: () => void): () => void {
  ensureBrowserListeners();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getConnectivitySnapshot(): ConnectivitySnapshot {
  if (!cached) {
    cached = {
      state: deriveConnectivity(state),
      browserOnline: state.browserOnline,
      apiReachable: state.apiReachable,
      lastOnlineAt: state.lastOnlineAt,
      lastFailureAt: state.lastFailureAt,
      reason: reasonFor(state),
    };
  }
  return cached;
}

export function getServerConnectivitySnapshot(): ConnectivitySnapshot {
  return SERVER_SNAPSHOT;
}

// `useConnectivity` (the React hook wrapping this store via useSyncExternalStore) lives in the
// `'use client'` hooks module — this file stays React-free so the API client (`api.ts`) can import
// the reachability markers from any environment (including Server Components) without pulling a
// client-only hook into a server import graph.

/** Test-only: reset the module store to its initial state between tests. */
export function __resetConnectivityForTests(now: State | null = null): void {
  state = now ?? {
    browserOnline: readBrowserOnline(),
    apiReachable: null,
    lastOnlineAt: null,
    lastFailureAt: null,
  };
  cached = null;
}
