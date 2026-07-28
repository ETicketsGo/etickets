import { redisEnvRoot, bullPrefix, cacheKeyPrefix } from './redis-namespace';

describe('redis-namespace (P6.2 environment isolation)', () => {
  it('roots the keyspace by lower-cased APP_ENV', () => {
    expect(redisEnvRoot('PRODUCTION')).toBe('etg:production');
    expect(redisEnvRoot('STAGING')).toBe('etg:staging');
    expect(redisEnvRoot(undefined)).toBe('etg:local'); // fail-safe default
  });

  it('derives distinct BullMQ prefixes per environment (never shared)', () => {
    expect(bullPrefix('STAGING')).toBe('etg:staging:bull');
    expect(bullPrefix('PRODUCTION')).toBe('etg:production:bull');
    expect(bullPrefix('STAGING')).not.toBe(bullPrefix('PRODUCTION'));
  });

  it('derives distinct cache prefixes per environment', () => {
    expect(cacheKeyPrefix('QA')).toBe('etg:qa:cache');
    expect(cacheKeyPrefix('UAT')).not.toBe(cacheKeyPrefix('PRODUCTION'));
  });
});
