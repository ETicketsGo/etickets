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
