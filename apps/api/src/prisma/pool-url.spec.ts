import { poolSetting } from './pool-url';

const URL_ = 'postgresql://u:p@db.internal:5432/app?schema=public';

describe('the connection pool is explicit when configured, and unchanged when not', () => {
  it('unset: the URL is left alone and Prisma uses its default (cpus * 2 + 1)', () => {
    expect(poolSetting({ DATABASE_URL: URL_ }, 8)).toEqual({
      url: null,
      poolSize: 17,
      source: 'PRISMA_DEFAULT',
      poolTimeoutSeconds: null,
    });
  });

  it('DATABASE_POOL_SIZE sets connection_limit (and pool_timeout), keeping the rest', () => {
    const s = poolSetting(
      { DATABASE_URL: URL_, DATABASE_POOL_SIZE: '10', DATABASE_POOL_TIMEOUT_SECONDS: '10' },
      32,
    );
    expect(s.source).toBe('DATABASE_POOL_SIZE');
    expect(s.poolSize).toBe(10);
    const u = new URL(s.url!);
    expect(u.searchParams.get('connection_limit')).toBe('10');
    expect(u.searchParams.get('pool_timeout')).toBe('10');
    expect(u.searchParams.get('schema')).toBe('public');
    expect(u.password).toBe('p');
    expect(u.hostname).toBe('db.internal');
  });

  it('a connection_limit already in DATABASE_URL wins over the variable', () => {
    const s = poolSetting(
      { DATABASE_URL: `${URL_}&connection_limit=5`, DATABASE_POOL_SIZE: '20' },
      8,
    );
    expect(s).toMatchObject({ url: null, poolSize: 5, source: 'DATABASE_URL' });
  });

  it('a nonsense size is ignored rather than breaking the connection', () => {
    for (const bad of ['0', '-1', 'ten', '1.5', '9999']) {
      expect(poolSetting({ DATABASE_URL: URL_, DATABASE_POOL_SIZE: bad }, 4).source).toBe(
        'PRISMA_DEFAULT',
      );
    }
  });
});
