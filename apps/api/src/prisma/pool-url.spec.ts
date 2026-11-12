import { poolSetting } from './pool-url';

const URL_ = 'postgresql://u:p@db.internal:5432/app?schema=public';

describe('the connection pool is explicit when configured, and unchanged when not', () => {
  it('unset: the URL is left alone and Prisma uses its default (cpus * 2 + 1)', () => {
    expect(poolSetting({ DATABASE_URL: URL_ }, 8)).toEqual({
      url: null,
      credential: 'DATABASE_URL',
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

describe('APP_DATABASE_URL: the runtime connects as the least-privilege login', () => {
  const OWNER = 'postgresql://postgres:owner@db.internal:5432/app?schema=public';
  const APP = 'postgresql://etg_app:app@db.internal:5432/app?schema=public';

  it('unset: nothing changes (DATABASE_URL, Prisma default datasource)', () => {
    const s = poolSetting({ DATABASE_URL: OWNER }, 2);
    expect(s.credential).toBe('DATABASE_URL');
    expect(s.url).toBeNull();
  });

  it('set: it is handed to Prisma explicitly, so the owner URL is never the runtime connection', () => {
    const s = poolSetting({ DATABASE_URL: OWNER, APP_DATABASE_URL: APP }, 2);
    expect(s.credential).toBe('APP_DATABASE_URL');
    expect(new URL(s.url!).username).toBe('etg_app');
  });

  it('set with a pool size: the size is applied to the APP url', () => {
    const s = poolSetting(
      { DATABASE_URL: OWNER, APP_DATABASE_URL: APP, DATABASE_POOL_SIZE: '7' },
      2,
    );
    const u = new URL(s.url!);
    expect(u.username).toBe('etg_app');
    expect(u.searchParams.get('connection_limit')).toBe('7');
  });

  it('set with connection_limit in the APP url: still the APP url, not Prisma default', () => {
    const s = poolSetting(
      { DATABASE_URL: OWNER, APP_DATABASE_URL: APP + '&connection_limit=4' },
      2,
    );
    expect(s.poolSize).toBe(4);
    expect(new URL(s.url!).username).toBe('etg_app');
  });

  it('blank is treated as unset', () => {
    expect(poolSetting({ DATABASE_URL: OWNER, APP_DATABASE_URL: '  ' }, 2).credential).toBe(
      'DATABASE_URL',
    );
  });
});
