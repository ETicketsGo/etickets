import { describe, it, expect } from 'vitest';
import {
  validateOfflineScan,
  classifyReconciliation,
  isOverridable,
  applyDelta,
  hasDeltaGap,
  deriveActivationVerdict,
  mustDowngrade,
  RECONCILE_META,
  RECONCILE_OUTCOMES,
  reconcileAdmitted,
  reconcileNeedsReview,
  initialReviewState,
  allowedReconcileResolutions,
  canResolveReconcile,
  deriveCommandCenterAlerts,
  buildPreflightChecks,
  derivePreflightVerdict,
  PREFLIGHT_CLOCK_TOLERANCE_MS,
  PREFLIGHT_DELTA_WINDOW_MS,
  type CommandCenterSignals,
  type PreflightSignals,
  type DecodedQr,
  type ManifestEntry,
  type ManifestMeta,
  type DeviceScope,
  type QueuedCheckIn,
  type ServerTicketState,
  type RevocationDelta,
  type ActivationInputs,
  type ReconcileOutcome,
} from '@eticketsgo/shared-types';

const NOW = 1_800_000_000_000;

const meta: ManifestMeta = {
  organizationId: 'org1',
  eventId: 'ev1',
  eventSessionId: 'se1',
  version: 3,
  validFrom: NOW - 3_600_000,
  expiresAt: NOW + 3_600_000,
};

const entry = (over: Partial<ManifestEntry> = {}): ManifestEntry => ({
  ticketId: 'tk1',
  eventSessionId: 'se1',
  nonce: 'nonce-1',
  version: 1,
  status: 'ACTIVE',
  eligible: true,
  ...over,
});

const decoded = (over: Partial<DecodedQr> = {}): DecodedQr => ({
  ticketId: 'tk1',
  eventSessionId: 'se1',
  nonce: 'nonce-1',
  version: 1,
  ...over,
});

const device: DeviceScope = {
  organizationId: 'org1',
  eventId: 'ev1',
  eventSessionId: 'se1',
  active: true,
};

function run(over: Partial<Parameters<typeof validateOfflineScan>[0]> = {}) {
  return validateOfflineScan({
    decoded: decoded(),
    meta,
    entries: new Map([['tk1', entry()]]),
    device,
    now: NOW,
    localCheckedIn: new Set(),
    ...over,
  });
}

describe('validateOfflineScan', () => {
  it('accepts a valid, in-manifest, matching, active ticket', () => {
    expect(run()).toBe('VALID');
  });

  it('rejects an unreadable QR', () => {
    expect(run({ decoded: null })).toBe('INVALID_SIGNATURE');
  });

  it('rejects an unauthorized / inactive / wrong-scope device', () => {
    expect(run({ device: { ...device, active: false } })).toBe('DEVICE_NOT_AUTHORIZED');
    expect(run({ device: { ...device, organizationId: 'other' } })).toBe('DEVICE_NOT_AUTHORIZED');
    expect(run({ device: { ...device, eventId: 'other' } })).toBe('DEVICE_NOT_AUTHORIZED');
  });

  it('rejects a stale/expired or not-yet-valid manifest', () => {
    expect(run({ meta: { ...meta, expiresAt: NOW - 1 } })).toBe('MANIFEST_STALE');
    expect(run({ meta: { ...meta, validFrom: NOW + 1 } })).toBe('MANIFEST_STALE');
  });

  it('rejects the wrong session', () => {
    expect(run({ decoded: decoded({ eventSessionId: 'seX' }) })).toBe('WRONG_SESSION');
    expect(run({ expectedSessionId: 'seOther' })).toBe('WRONG_SESSION');
  });

  it('requires online validation for an unknown ticket', () => {
    expect(run({ entries: new Map() })).toBe('REQUIRES_ONLINE_VALIDATION');
  });

  it('requires online validation when the nonce/version was rotated', () => {
    expect(run({ decoded: decoded({ nonce: 'old-nonce' }) })).toBe('REQUIRES_ONLINE_VALIDATION');
    expect(run({ decoded: decoded({ version: 99 }) })).toBe('REQUIRES_ONLINE_VALIDATION');
  });

  it('maps revoked / refunded / cancelled / transferred statuses', () => {
    const cases: [string, string][] = [
      ['REFUNDED', 'REFUNDED'],
      ['CANCELLED', 'CANCELLED'],
      ['VOID', 'CANCELLED'],
      ['TRANSFERRED', 'TRANSFERRED'],
      ['REVOKED', 'REVOKED'],
    ];
    for (const [status, expected] of cases) {
      expect(run({ entries: new Map([['tk1', entry({ status })]]) })).toBe(expected);
    }
  });

  it('reports a server-known prior check-in', () => {
    expect(run({ entries: new Map([['tk1', entry({ status: 'CHECKED_IN' })]]) })).toBe(
      'ALREADY_CHECKED_IN_SERVER_KNOWN',
    );
  });

  it('reports a local duplicate on the same device', () => {
    expect(run({ localCheckedIn: new Set(['tk1']) })).toBe('ALREADY_CHECKED_IN_LOCAL');
  });

  it('never treats an ineligible ticket as valid', () => {
    expect(run({ entries: new Map([['tk1', entry({ eligible: false })]]) })).toBe(
      'REQUIRES_ONLINE_VALIDATION',
    );
  });
});

describe('isOverridable', () => {
  it('allows overriding soft failures but never crypto/scope failures', () => {
    expect(isOverridable('MANIFEST_STALE')).toBe(true);
    expect(isOverridable('REQUIRES_ONLINE_VALIDATION')).toBe(true);
    expect(isOverridable('INVALID_SIGNATURE')).toBe(false);
    expect(isOverridable('DEVICE_NOT_AUTHORIZED')).toBe(false);
    expect(isOverridable('REVOKED')).toBe(false);
  });
});

describe('classifyReconciliation', () => {
  const q: QueuedCheckIn = {
    ticketId: 'tk1',
    deviceId: 'dev1',
    nonce: 'nonce-1',
    version: 1,
    eventSessionId: 'se1',
    checkedInAt: NOW,
    wasOverride: false,
  };
  const server = (over: Partial<ServerTicketState> = {}): ServerTicketState => ({
    status: 'ACTIVE',
    nonce: 'nonce-1',
    version: 1,
    eventSessionId: 'se1',
    checkedIn: null,
    ...over,
  });

  it('accepts a clean queued check-in', () => {
    expect(classifyReconciliation(q, server())).toBe('ACCEPTED');
  });

  it('flags refunded/revoked/transferred after download (server wins)', () => {
    expect(classifyReconciliation(q, server({ status: 'REFUNDED' }))).toBe(
      'REFUNDED_AFTER_DOWNLOAD',
    );
    expect(classifyReconciliation(q, server({ status: 'CANCELLED' }))).toBe(
      'REVOKED_AFTER_DOWNLOAD',
    );
    expect(classifyReconciliation(q, server({ nonce: 'rotated' }))).toBe(
      'TRANSFERRED_AFTER_DOWNLOAD',
    );
  });

  it('detects duplicates across and within devices, and online precedence', () => {
    expect(
      classifyReconciliation(q, server({ checkedIn: { deviceId: 'dev1', online: false } })),
    ).toBe('DUPLICATE_SAME_DEVICE');
    expect(
      classifyReconciliation(q, server({ checkedIn: { deviceId: 'dev2', online: false } })),
    ).toBe('DUPLICATE_OTHER_DEVICE');
    expect(classifyReconciliation(q, server({ checkedIn: { deviceId: null, online: true } }))).toBe(
      'ALREADY_CHECKED_IN_ONLINE',
    );
  });

  it('routes a wrong session and a vanished ticket to review', () => {
    expect(classifyReconciliation(q, server({ eventSessionId: 'seX' }))).toBe('WRONG_SESSION');
    expect(classifyReconciliation(q, null)).toBe('SUPERVISOR_REVIEW_REQUIRED');
  });
});

describe('revocation deltas', () => {
  const delta = (over: Partial<RevocationDelta> = {}): RevocationDelta => ({
    eventSessionId: 'se1',
    baseVersion: 100,
    toVersion: 200,
    changes: [{ ticketId: 'tk1', nonce: 'rotated', version: 2, status: 'ACTIVE', eligible: true }],
    signature: 'sig',
    ...over,
  });

  it('applies changes and bumps entries (server wins)', () => {
    const entries = new Map<string, ManifestEntry>([
      [
        'tk1',
        {
          ticketId: 'tk1',
          eventSessionId: 'se1',
          nonce: 'old',
          version: 1,
          status: 'ACTIVE',
          eligible: true,
        },
      ],
    ]);
    const next = applyDelta(entries, 100, delta());
    expect(next.get('tk1')!.nonce).toBe('rotated');
    expect(next.get('tk1')!.version).toBe(2);
  });

  it('is a no-op for a stale/rollback delta', () => {
    const entries = new Map<string, ManifestEntry>();
    expect(applyDelta(entries, 300, delta({ toVersion: 200 }))).toBe(entries);
  });

  it('detects a gap and forces a full refresh', () => {
    expect(hasDeltaGap(50, delta())).toBe(true); // local 50 < base 100
    expect(() => applyDelta(new Map(), 50, delta())).toThrow(/DELTA_GAP/);
  });
});

describe('activation policy', () => {
  const inputs = (over: Partial<ActivationInputs> = {}): ActivationInputs => ({
    flagEnabled: true,
    organizationApproved: true,
    eventApproved: true,
    deviceApproved: true,
    manifestValid: true,
    deltaFresh: true,
    queueOperational: true,
    reconciliationOperational: true,
    alertsOperational: true,
    auditHealthy: true,
    twoDeviceDrillPassed: true,
    deviceLossDrillPassed: true,
    reconciliationDrillPassed: true,
    openCriticalFindings: 0,
    adminActivationRecorded: true,
    ...over,
  });

  it('is GO only when every gate passes', () => {
    expect(deriveActivationVerdict(inputs()).verdict).toBe('GO');
  });

  it('is NO_GO when the flag is off or a drill is missing', () => {
    expect(deriveActivationVerdict(inputs({ flagEnabled: false })).verdict).toBe('NO_GO');
    expect(deriveActivationVerdict(inputs({ twoDeviceDrillPassed: false })).verdict).toBe('NO_GO');
    expect(deriveActivationVerdict(inputs({ openCriticalFindings: 1 })).verdict).toBe('NO_GO');
    expect(deriveActivationVerdict(inputs({ adminActivationRecorded: false })).verdict).toBe(
      'NO_GO',
    );
  });

  it('is CONDITIONAL_GO when only non-blocking checks fail', () => {
    expect(deriveActivationVerdict(inputs({ alertsOperational: false })).verdict).toBe(
      'CONDITIONAL_GO',
    );
  });

  it('mustDowngrade fires on any runtime failure signal', () => {
    expect(
      mustDowngrade({
        deviceRevoked: false,
        manifestExpired: true,
        deltaTooStale: false,
        queueCorrupt: false,
        auditUnavailable: false,
        reconciliationUnavailable: false,
        securityConfigInvalid: false,
      }),
    ).toBe(true);
    expect(
      mustDowngrade({
        deviceRevoked: false,
        manifestExpired: false,
        deltaTooStale: false,
        queueCorrupt: false,
        auditUnavailable: false,
        reconciliationUnavailable: false,
        securityConfigInvalid: false,
      }),
    ).toBe(false);
  });
});

describe('reconciliation console rules (presentation + safe resolution)', () => {
  it('marks ONLY ACCEPTED as an admission', () => {
    const admitted = RECONCILE_OUTCOMES.filter(reconcileAdmitted);
    expect(admitted).toEqual(['ACCEPTED']);
  });

  it('needs review only for SUPERVISOR_REVIEW_REQUIRED', () => {
    const review = RECONCILE_OUTCOMES.filter(reconcileNeedsReview);
    expect(review).toEqual(['SUPERVISOR_REVIEW_REQUIRED']);
    expect(initialReviewState('SUPERVISOR_REVIEW_REQUIRED')).toBe('PENDING');
    expect(initialReviewState('ACCEPTED')).toBe('NOT_REQUIRED');
    expect(initialReviewState('WRONG_SESSION')).toBe('NOT_REQUIRED');
  });

  it('every outcome has display metadata with a label + tone', () => {
    for (const o of RECONCILE_OUTCOMES) {
      expect(RECONCILE_META[o].label.length).toBeGreaterThan(0);
      expect(['success', 'info', 'warning', 'danger']).toContain(RECONCILE_META[o].tone);
    }
  });

  it('allows audit-only resolutions ONLY for a PENDING review case', () => {
    expect(allowedReconcileResolutions('SUPERVISOR_REVIEW_REQUIRED', 'PENDING')).toEqual([
      'ACKNOWLEDGED',
      'DISMISSED',
    ]);
    // Already resolved → nothing.
    expect(allowedReconcileResolutions('SUPERVISOR_REVIEW_REQUIRED', 'RESOLVED')).toEqual([]);
    // Informational outcomes are never resolvable, whatever the state.
    expect(allowedReconcileResolutions('WRONG_SESSION', 'PENDING')).toEqual([]);
    expect(allowedReconcileResolutions('ACCEPTED', 'NOT_REQUIRED')).toEqual([]);
  });

  it('never offers a resolution that admits a ticket', () => {
    for (const o of RECONCILE_OUTCOMES) {
      for (const state of ['NOT_REQUIRED', 'PENDING', 'RESOLVED'] as const) {
        const actions = allowedReconcileResolutions(o as ReconcileOutcome, state);
        // The only actions are audit-only annotations; there is no ACCEPT action.
        for (const a of actions) expect(['ACKNOWLEDGED', 'DISMISSED']).toContain(a);
      }
    }
  });

  it('canResolveReconcile agrees with the allowed set', () => {
    expect(canResolveReconcile('SUPERVISOR_REVIEW_REQUIRED', 'PENDING', 'ACKNOWLEDGED')).toBe(true);
    expect(canResolveReconcile('SUPERVISOR_REVIEW_REQUIRED', 'PENDING', 'DISMISSED')).toBe(true);
    expect(canResolveReconcile('SUPERVISOR_REVIEW_REQUIRED', 'RESOLVED', 'ACKNOWLEDGED')).toBe(
      false,
    );
    expect(canResolveReconcile('WRONG_SESSION', 'PENDING', 'DISMISSED')).toBe(false);
  });
});

describe('command center alert derivation (deterministic, deduped, ranked)', () => {
  const healthy: CommandCenterSignals = {
    eventSessionId: 'se1',
    verdict: 'GO',
    hasActivationDecision: true,
    downgradeActive: false,
    downgradeReasons: [],
    manifestStale: false,
    activeDeviceCount: 2,
    revokedDeviceActivityCount: 0,
    totalScans: 40,
    duplicateCount: 1,
    pendingReviewCount: 0,
    syncFailureCount: 0,
    oldestActiveDeviceUnseenMs: 10_000,
  };

  it('produces no alerts for a healthy session', () => {
    expect(deriveCommandCenterAlerts(healthy)).toEqual([]);
  });

  it('flags a downgraded live activation as critical', () => {
    const alerts = deriveCommandCenterAlerts({
      ...healthy,
      verdict: 'NO_GO',
      downgradeActive: true,
      downgradeReasons: ['A scoped device is no longer active'],
    });
    const a = alerts.find((x) => x.type === 'ACTIVATION_DOWNGRADE');
    expect(a?.severity).toBe('critical');
    expect(a?.detail).toMatch(/no longer active/);
  });

  it('does not alert on NO_GO when no decision exists (uncertified is normal)', () => {
    const alerts = deriveCommandCenterAlerts({
      ...healthy,
      hasActivationDecision: false,
      verdict: 'NO_GO',
    });
    expect(alerts.find((x) => x.type === 'ACTIVATION_DOWNGRADE')).toBeUndefined();
  });

  it('flags revoked-device activity, stale manifest, no devices, pending reviews', () => {
    const alerts = deriveCommandCenterAlerts({
      ...healthy,
      revokedDeviceActivityCount: 3,
      manifestStale: true,
      activeDeviceCount: 0,
      pendingReviewCount: 2,
    });
    const types = alerts.map((a) => a.type);
    expect(types).toContain('REVOKED_DEVICE_ACTIVITY');
    expect(types).toContain('STALE_MANIFEST');
    expect(types).toContain('NO_ACTIVE_DEVICES');
    expect(types).toContain('PENDING_SUPERVISOR_REVIEWS');
    // Critical alerts sort before warnings.
    expect(alerts[0].severity).toBe('critical');
  });

  it('applies the duplicate-rate threshold + minimum sample', () => {
    // Below sample size: no alert even at a high rate.
    expect(
      deriveCommandCenterAlerts({ ...healthy, totalScans: 4, duplicateCount: 3 }).find(
        (a) => a.type === 'HIGH_DUPLICATE_RATE',
      ),
    ).toBeUndefined();
    // Above sample + above rate: alert.
    expect(
      deriveCommandCenterAlerts({ ...healthy, totalScans: 20, duplicateCount: 8 }).find(
        (a) => a.type === 'HIGH_DUPLICATE_RATE',
      ),
    ).toBeDefined();
  });

  it('is idempotent: re-deriving yields identical keys (no duplicates on polling)', () => {
    const s = { ...healthy, pendingReviewCount: 1, manifestStale: true };
    const first = deriveCommandCenterAlerts(s).map((a) => a.key);
    const second = deriveCommandCenterAlerts(s).map((a) => a.key);
    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(first.length); // unique keys
  });

  it('flags a device that has not synced (queue-growth proxy)', () => {
    const a = deriveCommandCenterAlerts({
      ...healthy,
      oldestActiveDeviceUnseenMs: 9 * 60_000,
    }).find((x) => x.type === 'QUEUE_GROWTH');
    expect(a?.severity).toBe('warning');
  });
});

describe('offline preflight checklist (device pre-event gate)', () => {
  const ready: PreflightSignals = {
    deviceActive: true,
    deviceInScope: true,
    latestManifestVersion: 5,
    clientManifestVersion: 5,
    manifestFresh: true,
    lastSeenMsAgo: 60_000,
    deltaWindowMs: PREFLIGHT_DELTA_WINDOW_MS,
    clockSkewMs: 1_000,
    clockToleranceMs: PREFLIGHT_CLOCK_TOLERANCE_MS,
    queueDepth: 0,
    syncFailureCount: 0,
    pendingReviewCount: 0,
    activationVerdict: 'GO',
    criticalAlertCount: 0,
  };
  const verdictOf = (s: PreflightSignals) => derivePreflightVerdict(buildPreflightChecks(s));

  it('is READY when every check passes', () => {
    expect(verdictOf(ready)).toBe('READY');
    expect(buildPreflightChecks(ready).every((c) => c.status === 'pass')).toBe(true);
  });

  it('NOT_READY on any blocking failure', () => {
    expect(verdictOf({ ...ready, deviceActive: false })).toBe('NOT_READY');
    expect(verdictOf({ ...ready, deviceInScope: false })).toBe('NOT_READY');
    expect(verdictOf({ ...ready, manifestFresh: false })).toBe('NOT_READY');
    expect(verdictOf({ ...ready, clientManifestVersion: 4 })).toBe('NOT_READY'); // stale manifest
    expect(verdictOf({ ...ready, clockSkewMs: 5 * 60_000 })).toBe('NOT_READY');
    expect(verdictOf({ ...ready, activationVerdict: 'NO_GO' })).toBe('NOT_READY');
    expect(verdictOf({ ...ready, criticalAlertCount: 1 })).toBe('NOT_READY');
  });

  it('WARNING (not NOT_READY) on non-blocking issues', () => {
    expect(verdictOf({ ...ready, queueDepth: 3 })).toBe('WARNING');
    expect(verdictOf({ ...ready, pendingReviewCount: 2 })).toBe('WARNING');
    expect(verdictOf({ ...ready, lastSeenMsAgo: 3 * 60 * 60_000 })).toBe('WARNING');
  });

  it('treats an unreported manifest version / clock / queue as a warning, not a block', () => {
    const s = { ...ready, clientManifestVersion: null, clockSkewMs: null, queueDepth: null };
    expect(verdictOf(s)).toBe('WARNING');
    const manifest = buildPreflightChecks(s).find((c) => c.key === 'manifest_latest')!;
    expect(manifest.status).toBe('warn');
  });

  it('every non-pass check carries actionable guidance', () => {
    const checks = buildPreflightChecks({ ...ready, deviceActive: false, queueDepth: 2 });
    for (const c of checks) {
      if (c.status !== 'pass') expect(c.guidance.length).toBeGreaterThan(0);
    }
  });

  it('a stale manifest is a blocking failure with a clear explanation', () => {
    const c = buildPreflightChecks({ ...ready, clientManifestVersion: 3 }).find(
      (x) => x.key === 'manifest_latest',
    )!;
    expect(c.status).toBe('fail');
    expect(c.blocking).toBe(true);
    expect(c.explanation).toMatch(/v3/);
  });
});
