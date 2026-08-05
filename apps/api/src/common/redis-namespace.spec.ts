import {
  redisEnvRoot,
  bullPrefix,
  cacheKeyPrefix,
  opsKeyPrefix,
  bullConnectionFromUrl,
} from './redis-namespace';

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

  it('derives distinct ops (maintenance-flag) prefixes per environment', () => {
    expect(opsKeyPrefix('QA')).toBe('etg:qa:ops');
    expect(opsKeyPrefix('QA')).not.toBe(opsKeyPrefix('PRODUCTION'));
  });
});

describe('bullConnectionFromUrl', () => {
  it('keeps the plain host/port shape for an unauthenticated local Redis', () => {
    expect(bullConnectionFromUrl('redis://localhost:6379')).toEqual({
      host: 'localhost',
      port: 6379,
      maxRetriesPerRequest: null,
    });
  });

  it('defaults the port when the URL omits it', () => {
    expect(bullConnectionFromUrl('redis://redis.railway.internal').port).toBe(6379);
  });

  // The regression this helper exists for: managed Redis (Railway/ElastiCache/Upstash) puts the
  // credentials in the URL. Dropping them made every BullMQ queue fail with NOAUTH at runtime.
  it('preserves username and password from a managed Redis URL', () => {
    const conn = bullConnectionFromUrl('redis://default:s3cr3t@redis.railway.internal:6379');
    expect(conn).toMatchObject({
      host: 'redis.railway.internal',
      port: 6379,
      username: 'default',
      password: 's3cr3t',
    });
  });

  it('supports a password-only URL without sending an empty username', () => {
    const conn = bullConnectionFromUrl('redis://:s3cr3t@example.com:6380');
    expect(conn.password).toBe('s3cr3t');
    expect(conn).not.toHaveProperty('username');
  });

  it('percent-decodes credentials so special characters survive', () => {
    const conn = bullConnectionFromUrl('redis://user%40x:p%40ss%3Aword@example.com:6379');
    expect(conn.username).toBe('user@x');
    expect(conn.password).toBe('p@ss:word');
  });

  it('enables TLS for rediss:// and leaves it off for redis://', () => {
    expect(bullConnectionFromUrl('rediss://default:pw@example.com:6380').tls).toEqual({});
    expect(bullConnectionFromUrl('redis://example.com:6379')).not.toHaveProperty('tls');
  });

  it('carries the logical database index when the URL selects one', () => {
    expect(bullConnectionFromUrl('redis://example.com:6379/3').db).toBe(3);
    expect(bullConnectionFromUrl('redis://example.com:6379/')).not.toHaveProperty('db');
  });
});
