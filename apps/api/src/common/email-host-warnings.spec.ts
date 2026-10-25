import { isRailwayGeneratedHost, railwayEmailHostWarnings } from './email-host-warnings';

/**
 * The production emails linked to `admin-web-prod-1594.up.railway.app` and named
 * `customer-web-prod.up.railway.app` because the site variables held those hosts. Production is
 * warned at boot, never refused, and nothing is rewritten.
 */
describe('railwayEmailHostWarnings', () => {
  const railway = {
    APP_ENV: 'PRODUCTION',
    CUSTOMER_WEB_URL: 'https://customer-web-prod.up.railway.app',
    ADMIN_WEB_URL: 'https://admin-web-prod-1594.up.railway.app/',
    ORGANIZER_WEB_URL: 'https://organizer.eticketsgo.com',
  };

  it('names each production variable on a generated Railway host and the value it should be', () => {
    const warnings = railwayEmailHostWarnings(railway);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('CUSTOMER_WEB_URL');
    expect(warnings[0]).toContain('customer-web-prod.up.railway.app');
    expect(warnings[0]).toContain('CUSTOMER_WEB_URL=https://www.eticketsgo.com');
    expect(warnings[1]).toContain('ADMIN_WEB_URL=https://admin.eticketsgo.com');
    expect(warnings.join(' ')).not.toContain('ORGANIZER_WEB_URL');
  });

  it('says nothing when production uses the official domains', () => {
    expect(
      railwayEmailHostWarnings({
        APP_ENV: 'PRODUCTION',
        CUSTOMER_WEB_URL: 'https://www.eticketsgo.com',
        ADMIN_WEB_URL: 'https://admin.eticketsgo.com',
        ORGANIZER_WEB_URL: 'https://organizer.eticketsgo.com',
      }),
    ).toEqual([]);
  });

  it('says nothing outside production, for unset variables, or for values that are not URLs', () => {
    for (const appEnv of ['LOCAL', 'DEV', 'QA', 'UAT', 'STAGING', undefined]) {
      expect(railwayEmailHostWarnings({ ...railway, APP_ENV: appEnv })).toEqual([]);
    }
    expect(railwayEmailHostWarnings({ APP_ENV: 'PRODUCTION' })).toEqual([]);
    expect(railwayEmailHostWarnings({ APP_ENV: 'PRODUCTION', ADMIN_WEB_URL: 'not a url' })).toEqual(
      [],
    );
  });

  it('matches the generated suffix only, not a look-alike', () => {
    expect(isRailwayGeneratedHost('admin-web-prod-1594.up.railway.app')).toBe(true);
    expect(isRailwayGeneratedHost('X.UP.RAILWAY.APP.')).toBe(true);
    expect(isRailwayGeneratedHost('up.railway.app.eticketsgo.com')).toBe(false);
    expect(isRailwayGeneratedHost('www.eticketsgo.com')).toBe(false);
  });
});
