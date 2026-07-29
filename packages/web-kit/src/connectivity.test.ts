import { describe, it, expect, beforeEach } from 'vitest';
import {
  deriveConnectivity,
  deriveSyncState,
  markApiReachable,
  markApiUnreachable,
  getConnectivitySnapshot,
  getServerConnectivitySnapshot,
  subscribeConnectivity,
  __resetConnectivityForTests,
} from './connectivity';

describe('deriveConnectivity — connectivity model', () => {
  it('browser offline is authoritative → OFFLINE', () => {
    expect(deriveConnectivity({ browserOnline: false, apiReachable: null })).toBe('OFFLINE');
    expect(deriveConnectivity({ browserOnline: false, apiReachable: true })).toBe('OFFLINE');
  });

  it('browser online + confirmed API network failure → DEGRADED (stale onLine / API down)', () => {
    // This is the NestJS 11 / Express 5 case: navigator.onLine stayed true but the API is unreachable.
    expect(deriveConnectivity({ browserOnline: true, apiReachable: false })).toBe('DEGRADED');
  });

  it('browser online + recent successful request → ONLINE', () => {
    expect(deriveConnectivity({ browserOnline: true, apiReachable: true })).toBe('ONLINE');
  });

  it('browser online + no evidence yet → UNKNOWN (initial hydration)', () => {
    expect(deriveConnectivity({ browserOnline: true, apiReachable: null })).toBe('UNKNOWN');
  });
});

describe('deriveSyncState — wallet label precedence', () => {
  const base = { hasToken: true, isFetching: false, hasData: true, isError: false };

  it('no token → REQUIRES_SIGN_IN', () => {
    expect(deriveSyncState({ ...base, hasToken: false, connectivity: 'ONLINE' })).toBe(
      'REQUIRES_SIGN_IN',
    );
  });

  it('OFFLINE with cached data → STALE (label contains "Offline")', () => {
    expect(deriveSyncState({ ...base, connectivity: 'OFFLINE', hasData: true })).toBe('STALE');
  });

  it('OFFLINE with no data → OFFLINE', () => {
    expect(deriveSyncState({ ...base, connectivity: 'OFFLINE', hasData: false })).toBe('OFFLINE');
  });

  it('DEGRADED (API unreachable, browser "online") with data → STALE', () => {
    expect(deriveSyncState({ ...base, connectivity: 'DEGRADED', hasData: true })).toBe('STALE');
  });

  it('offline/degraded takes PRECEDENCE over an in-flight fetch (never masked by SYNCING)', () => {
    expect(deriveSyncState({ ...base, connectivity: 'OFFLINE', isFetching: true })).toBe('STALE');
    expect(deriveSyncState({ ...base, connectivity: 'DEGRADED', isFetching: true })).toBe('STALE');
  });

  it('online + fetching → SYNCING', () => {
    expect(deriveSyncState({ ...base, connectivity: 'ONLINE', isFetching: true })).toBe('SYNCING');
  });

  it('online + data → CURRENT (Up to date)', () => {
    expect(deriveSyncState({ ...base, connectivity: 'ONLINE', hasData: true })).toBe('CURRENT');
  });

  it('an HTTP application error (isError) does NOT mean offline → FAILED', () => {
    expect(
      deriveSyncState({ ...base, connectivity: 'ONLINE', hasData: false, isError: true }),
    ).toBe('FAILED');
  });

  it('never shows CURRENT ("Up to date") while connectivity is OFFLINE/DEGRADED', () => {
    for (const connectivity of ['OFFLINE', 'DEGRADED'] as const) {
      expect(deriveSyncState({ ...base, connectivity, hasData: true })).not.toBe('CURRENT');
    }
  });
});

describe('connectivity store — reachability signals', () => {
  beforeEach(() => __resetConnectivityForTests());

  it('starts UNKNOWN (browser online in the node env, no request evidence)', () => {
    expect(getConnectivitySnapshot().state).toBe('UNKNOWN');
  });

  it('a successful request → reachable → ONLINE, and records lastOnlineAt', () => {
    markApiReachable(1000);
    const s = getConnectivitySnapshot();
    expect(s.state).toBe('ONLINE');
    expect(s.apiReachable).toBe(true);
    expect(s.lastOnlineAt).toBe(1000);
    expect(s.reason).toBe('RECENT_SUCCESS');
  });

  it('a network-level failure → unreachable → DEGRADED (browser still "online"), records lastFailureAt', () => {
    markApiUnreachable(2000);
    const s = getConnectivitySnapshot();
    expect(s.state).toBe('DEGRADED');
    expect(s.apiReachable).toBe(false);
    expect(s.lastFailureAt).toBe(2000);
    expect(s.reason).toBe('API_UNREACHABLE');
  });

  it('recovers automatically: unreachable → then a success → ONLINE again', () => {
    markApiUnreachable(1000);
    expect(getConnectivitySnapshot().state).toBe('DEGRADED');
    markApiReachable(2000);
    expect(getConnectivitySnapshot().state).toBe('ONLINE');
  });

  it('snapshot reference is stable when nothing changes (no render churn)', () => {
    markApiReachable(1000);
    const a = getConnectivitySnapshot();
    const b = getConnectivitySnapshot();
    expect(a).toBe(b);
    markApiReachable(1000); // identical values → no new snapshot
    expect(getConnectivitySnapshot()).toBe(a);
  });

  it('notifies subscribers on change and stops after unsubscribe', () => {
    let calls = 0;
    const unsub = subscribeConnectivity(() => {
      calls += 1;
    });
    markApiUnreachable(1000);
    expect(calls).toBe(1);
    unsub();
    markApiReachable(2000);
    expect(calls).toBe(1);
  });

  it('server snapshot is a stable UNKNOWN (hydration-safe)', () => {
    expect(getServerConnectivitySnapshot().state).toBe('UNKNOWN');
    expect(getServerConnectivitySnapshot()).toBe(getServerConnectivitySnapshot());
  });

  it('browser offline overrides a prior successful request → OFFLINE', () => {
    markApiReachable(1000);
    __resetConnectivityForTests({
      browserOnline: false,
      apiReachable: true,
      lastOnlineAt: 1000,
      lastFailureAt: null,
    });
    expect(getConnectivitySnapshot().state).toBe('OFFLINE');
  });
});
