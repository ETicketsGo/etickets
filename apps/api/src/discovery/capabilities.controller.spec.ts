import { CapabilitiesController, smsReachableCountries } from './capabilities.controller';

describe('GET /capabilities phoneSignIn', () => {
  const make = (v?: string) => new CapabilitiesController({ get: () => v } as never).get();

  it('is true by default', () => {
    expect(make(undefined).phoneSignIn).toBe(true);
    expect(make('true').phoneSignIn).toBe(true);
  });

  it('is false when SMS is declared off', () => {
    expect(make('false').phoneSignIn).toBe(false);
  });
});

describe('phoneSignInCountries: the numbers a code can actually reach', () => {
  const config = (values: Record<string, string | undefined>) => ({
    get: (key: string) => values[key],
  });
  const ALL = ['IN', 'US', 'CA', 'GB', 'AU', 'NZ', 'SG', 'AE'].sort();

  it('is empty on a deployed environment whose provider is still log mode (QA today)', () => {
    /*
      The defect this exists for: phoneSignIn said true, the Mobile form was offered, and every
      request-code answered 503 after the person had typed their number.
    */
    expect(smsReachableCountries(config({ APP_ENV: 'QA', SMS_PROVIDER: 'log' }))).toEqual([]);
    expect(smsReachableCountries(config({ APP_ENV: 'PRODUCTION' }))).toEqual([]);
  });

  it('is every market in local development, where the console is the delivery', () => {
    const got = smsReachableCountries(config({ APP_ENV: 'LOCAL', NODE_ENV: 'development' }));
    expect([...got].sort()).toEqual(ALL);
  });

  it('is empty when SMS is declared off, whatever the provider', () => {
    expect(smsReachableCountries(config({ SMS_ENABLED: 'false', SMS_PROVIDER: 'twilio' }))).toEqual(
      [],
    );
  });

  it('follows the market table: India on MSG91, North America still in log mode', () => {
    const got = smsReachableCountries(
      config({ APP_ENV: 'QA', SMS_PROVIDER_BY_MARKET: 'IN=msg91,US=log,CA=log' }),
    );
    expect(got).toEqual(['IN']);
  });

  it('does not claim the United States when only US is routed and +1 is ambiguous', () => {
    // A sign-in code is routed by its number, and +1 is shared with Canada.
    const got = smsReachableCountries(
      config({ APP_ENV: 'QA', SMS_PROVIDER_BY_MARKET: 'IN=msg91,US=twilio' }),
    );
    expect(got).toEqual(['IN']);
    const both = smsReachableCountries(
      config({ APP_ENV: 'QA', SMS_PROVIDER_BY_MARKET: 'US=twilio,CA=twilio' }),
    );
    expect([...both].sort()).toEqual(['CA', 'US']);
  });

  it('reports a real default provider for every market when no table is configured', () => {
    const got = smsReachableCountries(config({ APP_ENV: 'PRODUCTION', SMS_PROVIDER: 'twilio' }));
    expect([...got].sort()).toEqual(ALL);
  });
});
