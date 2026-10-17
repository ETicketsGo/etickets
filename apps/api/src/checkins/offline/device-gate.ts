import { HttpStatus } from '@nestjs/common';
import { CheckInDeviceStatus } from '@eticketsgo/shared-types';
import { AppException, ErrorCodes } from '../../common/errors';

/**
 * The device rule every offline endpoint shares (H5): only an ACTIVE device whose approval has
 * not run out may download a ticket list or have its scans applied.
 *
 * It used to be applied in one place only - reconcile refused REVOKED and nothing else - so a
 * SUSPENDED or PENDING device could still upload scans and have them admitted, and any device,
 * whatever its status, could download a fresh list (the list was not tied to a device at all).
 */
export interface GatedDevice {
  status: string;
  expiresAt: Date | null;
}

export function deviceIsOperational(device: GatedDevice, now = Date.now()): boolean {
  if (device.status !== CheckInDeviceStatus.ACTIVE) return false;
  return !device.expiresAt || device.expiresAt.getTime() > now;
}

/** The status the door should be told about: an ACTIVE device past its expiry is EXPIRED. */
export function effectiveDeviceStatus(device: GatedDevice, now = Date.now()): string {
  if (device.status === CheckInDeviceStatus.ACTIVE && !deviceIsOperational(device, now)) {
    return CheckInDeviceStatus.EXPIRED;
  }
  return device.status;
}

const PLAIN: Record<string, string> = {
  PENDING: 'This device is waiting for a manager to approve it. It cannot check tickets yet.',
  SUSPENDED:
    'This device is suspended. A manager must approve it again before it can check tickets.',
  REVOKED: 'This device was turned off for good. Register a new device to check tickets.',
  EXPIRED: 'The approval for this device has run out. A manager must approve it again.',
};

/** The plain sentence for a device that may not work the door. */
export function deviceNotActiveMessage(status: string): string {
  return PLAIN[status] ?? 'This device cannot check tickets. Ask a manager to look at it.';
}

export function deviceNotActiveError(
  device: GatedDevice,
  extra: Record<string, unknown> = {},
): AppException {
  const status = effectiveDeviceStatus(device);
  return new AppException(
    ErrorCodes.DEVICE_NOT_ACTIVE,
    deviceNotActiveMessage(status),
    HttpStatus.FORBIDDEN,
    { deviceStatus: status, ...extra },
  );
}
