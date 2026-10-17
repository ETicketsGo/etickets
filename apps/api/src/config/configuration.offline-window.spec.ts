import { loadConfig } from './configuration';
import {
  OFFLINE_REVOCATION_WINDOW_DEFAULT_MINUTES,
  OFFLINE_REVOCATION_WINDOW_PRODUCTION_MAX_MINUTES,
  offlineRevocationWindowMs,
  offlineWindowContradictions,
} from './offline-revocation-window';

/**
 * Offline check-in cannot be switched on in production without a short, deliberate revocation
 * window (H5).
 *
 * A door phone that goes offline cannot hear that it was suspended or revoked. It keeps
 * admitting people from its saved ticket list until that list expires, so the list's lifetime
 * IS the time a lost or revoked phone keeps working. It used to be a fixed 6 hours. These
 * tests pin the default, the production ceiling, and that production must state the value.
 */
describe('offline revocation window (pure rule)', () => {
  it('defaults to 45 minutes when unset', () => {
    expect(OFFLINE_REVOCATION_WINDOW_DEFAULT_MINUTES).toBe(45);
    expect(offlineRevocationWindowMs(undefined)).toBe(45 * 60_000);
    expect(offlineRevocationWindowMs(20)).toBe(20 * 60_000);
  });

  it('has nothing to say while offline check-in is off, anywhere', () => {
    for (const APP_ENV of ['LOCAL', 'QA', 'UAT', 'STAGING', 'PRODUCTION']) {
      expect(
        offlineWindowContradictions({
          APP_ENV,
          OFFLINE_CHECKIN_ENABLED: false,
          OFFLINE_REVOCATION_WINDOW_MINUTES: 360,
        }),
      ).toEqual([]);
    }
  });

  it('leaves lower environments free to rehearse with longer windows', () => {
    for (const APP_ENV of ['LOCAL', 'DEV', 'QA', 'UAT']) {
      expect(
        offlineWindowContradictions({
          APP_ENV,
          OFFLINE_CHECKIN_ENABLED: true,
          OFFLINE_REVOCATION_WINDOW_MINUTES: 360,
        }),
      ).toEqual([]);
      expect(offlineWindowContradictions({ APP_ENV, OFFLINE_CHECKIN_ENABLED: true })).toEqual([]);
    }
  });

  it('in STAGING and PRODUCTION, needs the window set on purpose', () => {
    for (const APP_ENV of ['STAGING', 'PRODUCTION']) {
      const errors = offlineWindowContradictions({ APP_ENV, OFFLINE_CHECKIN_ENABLED: true });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/OFFLINE_REVOCATION_WINDOW_MINUTES set on purpose/);
    }
  });

  it('in STAGING and PRODUCTION, refuses a window over the maximum and accepts up to it', () => {
    const max = OFFLINE_REVOCATION_WINDOW_PRODUCTION_MAX_MINUTES;
    expect(max).toBe(60);
    for (const APP_ENV of ['STAGING', 'PRODUCTION']) {
      const over = offlineWindowContradictions({
        APP_ENV,
        OFFLINE_CHECKIN_ENABLED: true,
        OFFLINE_REVOCATION_WINDOW_MINUTES: max + 1,
      });
      expect(over).toHaveLength(1);
      expect(over[0]).toMatch(/longer than the 60 minutes allowed/);
      for (const ok of [5, 30, 45, max]) {
        expect(
          offlineWindowContradictions({
            APP_ENV,
            OFFLINE_CHECKIN_ENABLED: true,
            OFFLINE_REVOCATION_WINDOW_MINUTES: ok,
          }),
        ).toEqual([]);
      }
    }
  });
});

describe('loadConfig offline check-in guard (boot)', () => {
  const ORIGINAL = process.env;
  const STRONG = 'a'.repeat(40);

  // A production environment that passes every OTHER boot guard, so these cases isolate this one.
  const production = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    APP_ENV: 'PRODUCTION',
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://u:p@db/x',
    JWT_ACCESS_SECRET: STRONG,
    JWT_REFRESH_SECRET: STRONG,
    QR_SIGNING_SECRET: STRONG,
    PAYMENT_WEBHOOK_SECRET: STRONG,
    CORS_ORIGINS: 'https://app.eticketsgo.com',
    PAYMENT_PROVIDER_NAME: 'stripe',
    EMAIL_PROVIDER: 'ses',
    EMAIL_FROM: 'tickets@eticketsgo.com',
    SMS_PROVIDER_BY_MARKET: 'IN=msg91,US=twilio,CA=twilio',
    ...extra,
  });

  beforeEach(() => {
    process.env = { ...ORIGINAL };
  });
  afterAll(() => {
    process.env = ORIGINAL;
  });

  /** Whatever loadConfig says, or null when it boots. */
  const bootError = (env: NodeJS.ProcessEnv): string | null => {
    process.env = env;
    try {
      loadConfig();
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };

  it('production with offline check-in off is not affected by this guard', () => {
    expect(bootError(production())).toBeNull();
  });

  it('refuses to boot production with offline check-in on and no window set', () => {
    expect(bootError(production({ OFFLINE_CHECKIN_ENABLED: 'true' }))).toMatch(
      /Offline check-in is not safe to enable here[\s\S]*OFFLINE_REVOCATION_WINDOW_MINUTES/,
    );
  });

  it('refuses to boot production with a window over 60 minutes', () => {
    expect(
      bootError(
        production({ OFFLINE_CHECKIN_ENABLED: 'true', OFFLINE_REVOCATION_WINDOW_MINUTES: '90' }),
      ),
    ).toMatch(/longer than the 60 minutes allowed in PRODUCTION/);
  });

  it('boots production with offline check-in on and a window of 45', () => {
    expect(
      bootError(
        production({ OFFLINE_CHECKIN_ENABLED: 'true', OFFLINE_REVOCATION_WINDOW_MINUTES: '45' }),
      ),
    ).toBeNull();
  });

  it('refuses a window outside 5-360 minutes in any environment (schema)', () => {
    for (const bad of ['0', '4', '361', 'soon']) {
      expect(
        bootError({ ...production(), APP_ENV: 'LOCAL', OFFLINE_REVOCATION_WINDOW_MINUTES: bad }),
      ).toMatch(/OFFLINE_REVOCATION_WINDOW_MINUTES/);
    }
  });

  it('QA may enable it with the default window (rehearsal)', () => {
    expect(
      bootError({ ...production(), APP_ENV: 'QA', OFFLINE_CHECKIN_ENABLED: 'true' }) ?? '',
    ).not.toMatch(/Offline check-in/);
  });
});
