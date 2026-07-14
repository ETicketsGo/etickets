import {
  isDummyAllowed,
  isFailClosed,
  isLiveAllowed,
  resolvePaymentEnv,
} from './payment-environment';

describe('resolvePaymentEnv', () => {
  it('accepts the known environments (case-insensitively)', () => {
    expect(resolvePaymentEnv('PRODUCTION')).toBe('PRODUCTION');
    expect(resolvePaymentEnv('staging')).toBe('STAGING');
  });
  it('falls back to LOCAL for unknown/empty values (never silently to prod)', () => {
    expect(resolvePaymentEnv(undefined)).toBe('LOCAL');
    expect(resolvePaymentEnv('')).toBe('LOCAL');
    expect(resolvePaymentEnv('prod')).toBe('LOCAL');
  });
});

describe('environment guards', () => {
  it('permits the dummy provider only in local/dev/QA', () => {
    expect(isDummyAllowed('LOCAL')).toBe(true);
    expect(isDummyAllowed('DEV')).toBe(true);
    expect(isDummyAllowed('QA')).toBe(true);
    expect(isDummyAllowed('UAT')).toBe(false);
    expect(isDummyAllowed('PRODUCTION')).toBe(false);
  });
  it('permits LIVE mode only in staging/production', () => {
    expect(isLiveAllowed('PRODUCTION')).toBe(true);
    expect(isLiveAllowed('STAGING')).toBe(true);
    expect(isLiveAllowed('UAT')).toBe(false);
    expect(isLiveAllowed('LOCAL')).toBe(false);
  });
  it('fails closed only in staging/production', () => {
    expect(isFailClosed('PRODUCTION')).toBe(true);
    expect(isFailClosed('STAGING')).toBe(true);
    expect(isFailClosed('QA')).toBe(false);
    expect(isFailClosed('LOCAL')).toBe(false);
  });
});
