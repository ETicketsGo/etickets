import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '@eticketsgo/web-kit';
import type { ManifestMeta } from '@eticketsgo/shared-types';
import {
  deviceRefusalMessage,
  listValidUntilMessage,
  offlineAdmission,
  offlineResultMessage,
} from './offline-messages';
import { outcomeToStatus } from './checkin-queue';

/*
  H5: the door panel must stop admitting once its ticket list is past its validity, and say so
  in words the person at the door can act on. The list's validity is the offline revocation
  window, so this is what stops a phone that was suspended or revoked while it was offline.
*/

const T0 = 1_800_000_000_000;
const WINDOW = 45 * 60_000;
const meta: ManifestMeta = {
  organizationId: 'org1',
  eventId: 'ev1',
  eventSessionId: 'se1',
  version: 4,
  validFrom: T0,
  expiresAt: T0 + WINDOW,
  deviceId: 'dev1',
};
const at = (ms: number) => `T+${Math.round((ms - T0) / 60_000)}m`;

describe('offlineAdmission', () => {
  it('admits on its own device inside the window', () => {
    for (const now of [T0, T0 + 1, T0 + WINDOW / 2, T0 + WINDOW]) {
      expect(offlineAdmission(meta, 'dev1', now, at)).toEqual({ canAdmit: true, message: null });
    }
  });

  it('stops admitting once the list is past its validity, and says so plainly', () => {
    const r = offlineAdmission(meta, 'dev1', T0 + WINDOW + 1, at);
    expect(r.canAdmit).toBe(false);
    expect(r.message).toBe(
      'Offline check-in has stopped on this device. Its ticket list ran out at T+45m. ' +
        'Connect to the internet and download the list again before you let anyone in.',
    );
    // Hours later it is still stopped: nothing but a new list starts it again.
    expect(offlineAdmission(meta, 'dev1', T0 + 6 * 3_600_000, at).canAdmit).toBe(false);
  });

  it('refuses a list made for a different device', () => {
    const r = offlineAdmission(meta, 'dev2', T0 + 60_000, at);
    expect(r.canAdmit).toBe(false);
    expect(r.message).toMatch(/made for a different device/);
  });

  it('refuses a list from before H5 (no device on it)', () => {
    const old = { ...meta, deviceId: undefined } as unknown as ManifestMeta;
    expect(offlineAdmission(old, 'dev1', T0 + 60_000, at).canAdmit).toBe(false);
  });

  it('refuses a clock that is behind the list', () => {
    const r = offlineAdmission(meta, 'dev1', T0 - 60_000, at);
    expect(r.canAdmit).toBe(false);
    expect(r.message).toMatch(/clock on this device is behind/);
  });

  it('asks for a device and a list when there is neither', () => {
    expect(offlineAdmission(null, 'dev1', T0, at).canAdmit).toBe(false);
    expect(offlineAdmission(meta, null, T0, at).canAdmit).toBe(false);
  });

  it('every message is plain ASCII', () => {
    const messages = [
      offlineAdmission(meta, 'dev1', T0 + WINDOW + 1, at).message,
      offlineAdmission(meta, 'dev2', T0, at).message,
      offlineAdmission(meta, 'dev1', T0 - 1, at).message,
      listValidUntilMessage(meta, at),
      offlineResultMessage('MANIFEST_STALE'),
      offlineResultMessage('DEVICE_NOT_AUTHORIZED'),
    ];
    for (const m of messages) expect(m).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe('offlineResultMessage', () => {
  it('replaces result codes with what to do', () => {
    expect(offlineResultMessage('MANIFEST_STALE')).toMatch(/has run out/);
    expect(offlineResultMessage('VALID')).toMatch(/^Valid/);
    expect(offlineResultMessage('ALREADY_CHECKED_IN_LOCAL')).toMatch(/Already let in/);
    expect(offlineResultMessage('MANIFEST_STALE')).not.toMatch(/_/);
  });
});

describe('deviceRefusalMessage', () => {
  const refused = (heldForReview: number) =>
    new ApiRequestError(
      'DEVICE_NOT_ACTIVE',
      'This device is suspended. A manager must approve it again before it can check tickets.',
      { deviceStatus: 'SUSPENDED', heldForReview },
      undefined,
      403,
    );

  it('says the scans were not counted and a manager will review them', () => {
    expect(deviceRefusalMessage(refused(2), true)).toBe(
      'This device is suspended. A manager must approve it again before it can check tickets. ' +
        'The scans saved on this device were not counted. A manager must review them.',
    );
    expect(deviceRefusalMessage(refused(0), true)).toMatch(/were not counted\.$/);
  });

  it('on a list download, says offline check-in is off on this device', () => {
    expect(deviceRefusalMessage(refused(0), false)).toMatch(/Offline check-in is off/);
  });

  it('ignores every other error', () => {
    expect(
      deviceRefusalMessage(new ApiRequestError('FORBIDDEN', 'No.', {}, undefined, 403), true),
    ).toBeNull();
    expect(deviceRefusalMessage(new Error('network'), true)).toBeNull();
  });
});

describe('outcomeToStatus', () => {
  it('shows the H5 holds as needing review, not as a plain conflict', () => {
    expect(outcomeToStatus('DEVICE_NOT_ACTIVE')).toBe('REVIEW_REQUIRED');
    expect(outcomeToStatus('MANIFEST_NOT_VALID')).toBe('REVIEW_REQUIRED');
    expect(outcomeToStatus('SUPERVISOR_REVIEW_REQUIRED')).toBe('REVIEW_REQUIRED');
    expect(outcomeToStatus('WRONG_SESSION')).toBe('CONFLICT');
    expect(outcomeToStatus('ACCEPTED')).toBe('ACCEPTED');
  });
});
