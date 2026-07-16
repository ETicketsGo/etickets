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
