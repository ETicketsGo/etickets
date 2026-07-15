import { describe, it, expect } from 'vitest';
import {
  validateOfflineScan,
  classifyReconciliation,
  isOverridable,
  type DecodedQr,
  type ManifestEntry,
  type ManifestMeta,
  type DeviceScope,
  type QueuedCheckIn,
  type ServerTicketState,
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
