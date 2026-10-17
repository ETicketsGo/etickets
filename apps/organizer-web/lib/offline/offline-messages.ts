import { ApiRequestError } from '@eticketsgo/web-kit';
import {
  manifestValidity,
  type ManifestMeta,
  type ManifestValidity,
  type OfflineCheckInResult,
} from '@eticketsgo/shared-types';

/*
  Plain sentences for the offline door panel (H5).

  The panel used to print the result code with the underscores swapped for spaces ("MANIFEST
  STALE", "DEVICE NOT AUTHORIZED"), which tells the person at the door nothing about what to do.
  Every sentence here says what happened and the next step.
*/

const RESULT: Record<OfflineCheckInResult, string> = {
  VALID: 'Valid. Let them in. The scan is saved and will sync later.',
  ALREADY_CHECKED_IN_LOCAL: 'Already let in on this device. Do not let them in again.',
  ALREADY_CHECKED_IN_SERVER_KNOWN: 'Already let in earlier. Do not let them in again.',
  INVALID_SIGNATURE: 'This is not a ticket code we can read. Ask for the ticket again.',
  WRONG_EVENT: 'This ticket is for a different event.',
  WRONG_SESSION: 'This ticket is for a different show time.',
  REVOKED: 'This ticket was cancelled. Do not let them in.',
  REFUNDED: 'This ticket was refunded. Do not let them in.',
  CANCELLED: 'This ticket was cancelled. Do not let them in.',
  TRANSFERRED: 'This ticket was passed to someone else. Ask for the new ticket.',
  EXPIRED: 'This ticket has expired.',
  MANIFEST_STALE:
    'The ticket list on this device has run out. Connect to the internet and download it again before you let anyone in.',
  DEVICE_NOT_AUTHORIZED:
    'This device cannot check tickets offline. Download the ticket list on this device, or ask a manager to approve it.',
  REQUIRES_ONLINE_VALIDATION:
    'This ticket cannot be checked offline. Check it online, or ask a supervisor.',
  SUPERVISOR_REVIEW_REQUIRED: 'Ask a supervisor before you let them in.',
};

export function offlineResultMessage(result: OfflineCheckInResult): string {
  return RESULT[result] ?? 'Ask a supervisor before you let them in.';
}

/** What the panel shows when it will not admit from the list it holds; null when it will. */
export function listBlockedMessage(
  validity: ManifestValidity,
  expiresAt: number,
  formatTime: (ms: number) => string,
): string | null {
  switch (validity) {
    case 'VALID':
      return null;
    case 'EXPIRED':
      return (
        `Offline check-in has stopped on this device. Its ticket list ran out at ` +
        `${formatTime(expiresAt)}. Connect to the internet and download the list again before ` +
        'you let anyone in.'
      );
    case 'NOT_YET_VALID':
      return (
        'The clock on this device is behind the ticket list. Set the clock to automatic time, ' +
        'then download the list again.'
      );
    case 'OTHER_DEVICE':
      return 'This ticket list was made for a different device. Download the list on this device.';
  }
}

/**
 * Whether this device may admit from the list it holds right now, and if not, why. One place
 * for the rule, so the Validate button and the scan itself cannot disagree.
 */
export function offlineAdmission(
  meta: ManifestMeta | null,
  deviceId: string | null,
  now: number,
  formatTime: (ms: number) => string,
): { canAdmit: boolean; message: string | null } {
  if (!meta || !deviceId) {
    return {
      canAdmit: false,
      message: 'Set up this device and download the ticket list first.',
    };
  }
  const message = listBlockedMessage(
    manifestValidity(meta, deviceId, now),
    meta.expiresAt,
    formatTime,
  );
  return { canAdmit: message === null, message };
}

/** The line under the list: until when it can be used. */
export function listValidUntilMessage(meta: ManifestMeta, formatTime: (ms: number) => string) {
  return `Ticket list valid until ${formatTime(meta.expiresAt)}. Connect before then to get a new one.`;
}

/**
 * The plain sentence for a server refusal because this device is no longer ACTIVE, or null
 * when the error is something else. The server already says which state the device is in; the
 * panel adds what happened to the scans it was holding.
 */
export function deviceRefusalMessage(err: unknown, uploading: boolean): string | null {
  if (!(err instanceof ApiRequestError) || err.code !== 'DEVICE_NOT_ACTIVE') return null;
  const held = Number(err.details?.heldForReview ?? 0);
  if (!uploading) return `${err.message} Offline check-in is off on this device.`;
  return held > 0
    ? `${err.message} The scans saved on this device were not counted. A manager must review them.`
    : `${err.message} The scans saved on this device were not counted.`;
}
