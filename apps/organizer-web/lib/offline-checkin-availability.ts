import { ApiRequestError, type OfflineReadinessReport } from '@eticketsgo/web-kit';

/**
 * Whether offline check-in devices are turned on for this platform.
 *
 * The API serves the device endpoints only when OFFLINE_CHECKIN_ENABLED is on, and answers
 * 404 otherwise. The Devices page used to read that 404 as a failed load: "We couldn't load
 * devices. Please try again." with Try again and an active "Register device", which can never
 * succeed. The readiness report says so in advance (its `flag` check, the same one the event
 * tabs read), and a 404 from the device list says so after the fact.
 *
 * - 'off': the feature is off; say so plainly and offer nothing that would fail.
 * - 'on': the feature is on; a device-list error is a real error.
 * - 'unknown': neither has answered yet.
 */
export type OfflineDevicesAvailability = 'on' | 'off' | 'unknown';

export function offlineDevicesAvailability(
  readiness: OfflineReadinessReport | undefined,
  devicesError: unknown,
): OfflineDevicesAvailability {
  const flag = readiness?.checks.find((c) => c.key === 'flag');
  if (flag) return flag.passed ? 'on' : 'off';
  if (devicesError instanceof ApiRequestError && devicesError.status === 404) return 'off';
  return 'unknown';
}
