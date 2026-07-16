// Offline gate check-in core (ADR-035). Pure, framework-free validation + queue
// reconciliation logic — the security heart of offline check-in, shared by the
// (future) organizer offline UI and the server reconciler, and exhaustively
// unit-tested. This NEVER treats uncertainty as success.
//
// SECURITY MODEL (offline): a server-signed, short-lived, device-scoped MANIFEST
// is the offline root of trust. It lists, per ticket, the current nonce/version +
// status + eligibility. A scanned QR is decoded and matched against the manifest;
// duplicate detection (local ledger + server reconciliation) stops replays. The
// device holds NO QR signing secret (avoids secret distribution); anything the
// manifest can't confirm returns REQUIRES_ONLINE_VALIDATION — not VALID.

export type OfflineCheckInResult =
  | 'VALID'
  | 'ALREADY_CHECKED_IN_LOCAL'
  | 'ALREADY_CHECKED_IN_SERVER_KNOWN'
  | 'INVALID_SIGNATURE'
  | 'WRONG_EVENT'
  | 'WRONG_SESSION'
  | 'REVOKED'
  | 'REFUNDED'
  | 'CANCELLED'
  | 'TRANSFERRED'
  | 'EXPIRED'
  | 'MANIFEST_STALE'
  | 'DEVICE_NOT_AUTHORIZED'
  | 'REQUIRES_ONLINE_VALIDATION'
  | 'SUPERVISOR_REVIEW_REQUIRED';

/** A single ticket's validation snapshot inside a signed manifest. */
export interface ManifestEntry {
  ticketId: string;
  eventSessionId: string;
  nonce: string;
  version: number;
  /** Last-known ticket status at manifest build time. */
  status: string;
  /** Whether the ticket is eligible to be checked in. */
  eligible: boolean;
}

/** Signed manifest header (scope + validity window). */
export interface ManifestMeta {
  organizationId: string;
  eventId: string;
  eventSessionId: string;
  version: number;
  validFrom: number;
  expiresAt: number;
}

/** The device's approved scope (what it may validate offline). */
export interface DeviceScope {
  organizationId: string;
  eventId: string | null;
  eventSessionId: string | null;
  /** ACTIVE registered device? Anything else can't validate offline. */
  active: boolean;
}

/** A decoded QR payload (already base64url-decoded; signature NOT verified here). */
export interface DecodedQr {
  ticketId: string;
  eventSessionId: string;
  nonce: string;
  version: number;
}

export interface OfflineValidateInput {
  decoded: DecodedQr | null;
  meta: ManifestMeta;
  /** Manifest entries keyed by ticketId. */
  entries: Map<string, ManifestEntry>;
  device: DeviceScope;
  now: number;
  /** Ticket ids already checked in on THIS device (local ledger). */
  localCheckedIn: Set<string>;
  /** Optional session the operator expects to be scanning. */
  expectedSessionId?: string;
}

const STATUS_RESULT: Record<string, OfflineCheckInResult> = {
  REFUNDED: 'REFUNDED',
  CANCELLED: 'CANCELLED',
  VOID: 'CANCELLED',
  TRANSFERRED: 'TRANSFERRED',
  REVOKED: 'REVOKED',
};

/**
 * Validates a scanned QR fully offline against a signed manifest. Returns exactly
 * one result; ambiguity → REQUIRES_ONLINE_VALIDATION (never VALID).
 */
export function validateOfflineScan(input: OfflineValidateInput): OfflineCheckInResult {
  const { decoded, meta, entries, device, now, localCheckedIn, expectedSessionId } = input;

  // 1. Decodable QR.
  if (!decoded || !decoded.ticketId || !decoded.nonce) return 'INVALID_SIGNATURE';

  // 2. Device must be an ACTIVE, correctly-scoped registered device.
  if (!device.active || device.organizationId !== meta.organizationId)
    return 'DEVICE_NOT_AUTHORIZED';
  if (device.eventId && device.eventId !== meta.eventId) return 'DEVICE_NOT_AUTHORIZED';
  if (device.eventSessionId && device.eventSessionId !== meta.eventSessionId)
    return 'DEVICE_NOT_AUTHORIZED';

  // 3. Manifest validity window.
  if (now < meta.validFrom || now > meta.expiresAt) return 'MANIFEST_STALE';

  // 4. Session/event of the scanned QR.
  if (decoded.eventSessionId !== meta.eventSessionId) return 'WRONG_SESSION';
  if (expectedSessionId && decoded.eventSessionId !== expectedSessionId) return 'WRONG_SESSION';

  // 5. Ticket must be in the manifest; unknown → cannot confirm offline.
  const entry = entries.get(decoded.ticketId);
  if (!entry) return 'REQUIRES_ONLINE_VALIDATION';
  if (entry.eventSessionId !== meta.eventSessionId) return 'WRONG_SESSION';

  // 6. Nonce/version must match the manifest exactly. A mismatch means the QR was
  //    rotated (transfer/reissue) or the manifest is stale — never accept offline.
  if (entry.nonce !== decoded.nonce || entry.version !== decoded.version) {
    return 'REQUIRES_ONLINE_VALIDATION';
  }

  // 7. Status.
  const statusResult = STATUS_RESULT[entry.status];
  if (statusResult) return statusResult;
  if (entry.status === 'CHECKED_IN') return 'ALREADY_CHECKED_IN_SERVER_KNOWN';
  if (entry.status !== 'ACTIVE') return 'REQUIRES_ONLINE_VALIDATION';
  if (!entry.eligible) return 'REQUIRES_ONLINE_VALIDATION';

  // 8. Local duplicate (this device already admitted it).
  if (localCheckedIn.has(decoded.ticketId)) return 'ALREADY_CHECKED_IN_LOCAL';

  return 'VALID';
}

/** States a supervisor may override (never cryptographic/scope failures). */
const OVERRIDABLE: OfflineCheckInResult[] = [
  'MANIFEST_STALE',
  'REQUIRES_ONLINE_VALIDATION',
  'ALREADY_CHECKED_IN_LOCAL',
  'WRONG_SESSION',
];
export function isOverridable(result: OfflineCheckInResult): boolean {
  return OVERRIDABLE.includes(result);
}

// ─────────────────────────── Reconciliation ───────────────────────────

export type ReconcileOutcome =
  | 'ACCEPTED'
  | 'DUPLICATE_SAME_DEVICE'
  | 'DUPLICATE_OTHER_DEVICE'
  | 'REVOKED_AFTER_DOWNLOAD'
  | 'REFUNDED_AFTER_DOWNLOAD'
  | 'TRANSFERRED_AFTER_DOWNLOAD'
  | 'WRONG_SESSION'
  | 'ALREADY_CHECKED_IN_ONLINE'
  | 'SUPERVISOR_REVIEW_REQUIRED';

/** A queued offline check-in submitted for server reconciliation. */
export interface QueuedCheckIn {
  ticketId: string;
  deviceId: string;
  nonce: string;
  version: number;
  eventSessionId: string;
  checkedInAt: number;
  wasOverride: boolean;
}

/** The server's CURRENT truth for a ticket at reconciliation time. */
export interface ServerTicketState {
  status: string;
  nonce: string;
  version: number;
  eventSessionId: string;
  /** An existing successful check-in, if any. */
  checkedIn?: { deviceId: string | null; online: boolean } | null;
}

/**
 * Classifies a queued offline check-in against current server state. Server always
 * wins; conflicts are surfaced, never silently accepted. Idempotent per (ticket,
 * device).
 */
export function classifyReconciliation(
  q: QueuedCheckIn,
  server: ServerTicketState | null,
): ReconcileOutcome {
  if (!server) return 'SUPERVISOR_REVIEW_REQUIRED'; // ticket vanished — needs review
  if (server.status === 'REFUNDED') return 'REFUNDED_AFTER_DOWNLOAD';
  if (['CANCELLED', 'VOID', 'REVOKED'].includes(server.status)) return 'REVOKED_AFTER_DOWNLOAD';
  if (server.eventSessionId !== q.eventSessionId) return 'WRONG_SESSION';
  // A rotated nonce means the ticket was transferred/reissued after download.
  if (server.nonce !== q.nonce || server.version !== q.version) return 'TRANSFERRED_AFTER_DOWNLOAD';

  const existing = server.checkedIn;
  if (existing) {
    if (existing.online) return 'ALREADY_CHECKED_IN_ONLINE';
    if (existing.deviceId === q.deviceId) return 'DUPLICATE_SAME_DEVICE';
    return 'DUPLICATE_OTHER_DEVICE';
  }
  if (server.status !== 'ACTIVE') return 'SUPERVISOR_REVIEW_REQUIRED';
  return 'ACCEPTED';
}

// ─────────────────────────── Revocation deltas (M5) ───────────────────────────

/** One changed ticket in an incremental revocation delta. */
export interface DeltaChange {
  ticketId: string;
  nonce: string;
  version: number;
  status: string;
  eligible: boolean;
}

/**
 * An incremental, server-signed set of manifest changes since `baseVersion`.
 * Monotonic; event/session scoped. A device applies it atomically and stores
 * `toVersion`; a gap forces a full-manifest refresh.
 */
export interface RevocationDelta {
  eventSessionId: string;
  baseVersion: number;
  toVersion: number;
  changes: DeltaChange[];
  signature: string;
}

/**
 * A gap exists when the device's last-applied version is older than the delta's
 * base (missed changes) — the device must refetch the full manifest, never apply
 * partially (rollback/gap prevention).
 */
export function hasDeltaGap(localVersion: number, delta: { baseVersion: number }): boolean {
  return localVersion < delta.baseVersion;
}

/**
 * Applies a delta to a manifest-entry map, returning a NEW map. Rejects rollbacks
 * (a delta older than what's applied) and gaps by throwing — the caller must then
 * do a full refresh. Server always wins for the changed entries.
 */
export function applyDelta(
  entries: Map<string, ManifestEntry>,
  localVersion: number,
  delta: RevocationDelta,
): Map<string, ManifestEntry> {
  if (delta.toVersion <= localVersion) return entries; // stale/rollback → no-op
  if (hasDeltaGap(localVersion, delta)) {
    throw new Error('DELTA_GAP: full manifest refresh required');
  }
  const next = new Map(entries);
  for (const c of delta.changes) {
    next.set(c.ticketId, {
      ticketId: c.ticketId,
      eventSessionId: delta.eventSessionId,
      nonce: c.nonce,
      version: c.version,
      status: c.status,
      eligible: c.eligible,
    });
  }
  return next;
}

// ───────────────────────── Offline activation policy (M12) ─────────────────────

export type ActivationVerdict = 'GO' | 'CONDITIONAL_GO' | 'NO_GO';

export interface ActivationInputs {
  flagEnabled: boolean;
  organizationApproved: boolean;
  eventApproved: boolean;
  deviceApproved: boolean;
  manifestValid: boolean;
  deltaFresh: boolean;
  queueOperational: boolean;
  reconciliationOperational: boolean;
  alertsOperational: boolean;
  auditHealthy: boolean;
  twoDeviceDrillPassed: boolean;
  deviceLossDrillPassed: boolean;
  reconciliationDrillPassed: boolean;
  openCriticalFindings: number;
  adminActivationRecorded: boolean;
}

export interface ActivationCheck {
  key: string;
  label: string;
  passed: boolean;
  /** A failed blocking check forces NO_GO regardless of the others. */
  blocking: boolean;
}

/**
 * Strict launch gate for offline gate check-in (M12). GO requires the flag,
 * org/event/device approval, a valid manifest, fresh deltas, operational queue/
 * reconciliation/alerts/audit, ALL three live drills passed, zero open Critical/
 * High findings, and a recorded admin activation. Anything blocking failing →
 * NO_GO; otherwise partial → CONDITIONAL_GO.
 */
export function deriveActivationVerdict(inputs: ActivationInputs): {
  verdict: ActivationVerdict;
  checks: ActivationCheck[];
} {
  const checks: ActivationCheck[] = [
    { key: 'flag', label: 'Feature flag enabled', passed: inputs.flagEnabled, blocking: true },
    {
      key: 'org',
      label: 'Organization approved',
      passed: inputs.organizationApproved,
      blocking: true,
    },
    { key: 'event', label: 'Event approved', passed: inputs.eventApproved, blocking: true },
    { key: 'device', label: 'Device approved', passed: inputs.deviceApproved, blocking: true },
    { key: 'manifest', label: 'Manifest valid', passed: inputs.manifestValid, blocking: true },
    { key: 'delta', label: 'Revocation delta fresh', passed: inputs.deltaFresh, blocking: false },
    { key: 'queue', label: 'Queue operational', passed: inputs.queueOperational, blocking: false },
    {
      key: 'reconciliation',
      label: 'Reconciliation operational',
      passed: inputs.reconciliationOperational,
      blocking: true,
    },
    {
      key: 'alerts',
      label: 'Alerting operational',
      passed: inputs.alertsOperational,
      blocking: false,
    },
    { key: 'audit', label: 'Audit logging healthy', passed: inputs.auditHealthy, blocking: true },
    {
      key: 'drill_two_device',
      label: 'Two-device drill passed',
      passed: inputs.twoDeviceDrillPassed,
      blocking: true,
    },
    {
      key: 'drill_device_loss',
      label: 'Device-loss drill passed',
      passed: inputs.deviceLossDrillPassed,
      blocking: true,
    },
    {
      key: 'drill_reconcile',
      label: 'Reconciliation drill passed',
      passed: inputs.reconciliationDrillPassed,
      blocking: true,
    },
    {
      key: 'findings',
      label: 'No open Critical/High findings',
      passed: inputs.openCriticalFindings === 0,
      blocking: true,
    },
    {
      key: 'activation',
      label: 'Admin activation recorded',
      passed: inputs.adminActivationRecorded,
      blocking: true,
    },
  ];

  const blockingFailed = checks.some((c) => c.blocking && !c.passed);
  const allPassed = checks.every((c) => c.passed);
  let verdict: ActivationVerdict;
  if (blockingFailed) verdict = 'NO_GO';
  else if (allPassed) verdict = 'GO';
  else verdict = 'CONDITIONAL_GO';
  return { verdict, checks };
}

/** Runtime signals that force an immediate downgrade to NO_GO mid-event. */
export interface DowngradeSignals {
  deviceRevoked: boolean;
  manifestExpired: boolean;
  deltaTooStale: boolean;
  queueCorrupt: boolean;
  auditUnavailable: boolean;
  reconciliationUnavailable: boolean;
  securityConfigInvalid: boolean;
}
export function mustDowngrade(s: DowngradeSignals): boolean {
  return (
    s.deviceRevoked ||
    s.manifestExpired ||
    s.deltaTooStale ||
    s.queueCorrupt ||
    s.auditUnavailable ||
    s.reconciliationUnavailable ||
    s.securityConfigInvalid
  );
}
