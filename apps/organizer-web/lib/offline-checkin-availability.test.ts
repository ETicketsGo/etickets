import { describe, expect, it } from 'vitest';
import { ApiRequestError, type OfflineReadinessReport } from '@eticketsgo/web-kit';
import { offlineDevicesAvailability } from './offline-checkin-availability';

const report = (flag: boolean): OfflineReadinessReport => ({
  verdict: flag ? 'CONDITIONAL_GO' : 'NO_GO',
  checks: [
    { key: 'flag', label: 'Offline check-in enabled', passed: flag },
    { key: 'device', label: 'An approved device exists', passed: false },
  ],
  note: '',
});
const notFound = new ApiRequestError('NOT_FOUND', 'Not found.', undefined, undefined, 404);
const serverError = new ApiRequestError('INTERNAL', 'Boom.', undefined, undefined, 500);

describe('offline check-in devices availability', () => {
  it('is off when the readiness flag says the platform has it turned off', () => {
    expect(offlineDevicesAvailability(report(false), undefined)).toBe('off');
    // The flag wins over the device list's own answer.
    expect(offlineDevicesAvailability(report(false), serverError)).toBe('off');
  });

  it('is off when the device list answers 404, before the readiness report arrives', () => {
    expect(offlineDevicesAvailability(undefined, notFound)).toBe('off');
  });

  it('is on when the flag is on, so a failed load stays a real error', () => {
    expect(offlineDevicesAvailability(report(true), serverError)).toBe('on');
    expect(offlineDevicesAvailability(report(true), notFound)).toBe('on');
  });

  it('is unknown while nothing has answered, and for errors that are not a 404', () => {
    expect(offlineDevicesAvailability(undefined, undefined)).toBe('unknown');
    expect(offlineDevicesAvailability(undefined, serverError)).toBe('unknown');
    expect(offlineDevicesAvailability(undefined, new Error('offline'))).toBe('unknown');
  });
});
