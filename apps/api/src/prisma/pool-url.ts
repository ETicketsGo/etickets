import { availableParallelism } from 'node:os';

/**
 * The Prisma connection pool of THIS process, made explicit (AR-05).
 *
 * Prisma's default pool is `num_cpus * 2 + 1`, and a container can report the HOST's CPU count:
 * on a large host that is dozens of connections per process, multiplied by every API replica
 * and the worker. `DATABASE_POOL_SIZE` sets `connection_limit` (and `DATABASE_POOL_TIMEOUT_SECONDS`
 * sets `pool_timeout`) on the datasource URL, so `replicas x pool` can be kept under the
 * database's `max_connections`.
 *
 * Unset changes nothing: the URL is used exactly as given, as before. A `connection_limit`
 * already written in `DATABASE_URL` wins over the variable, so an operator who set it there
 * keeps it.
 */
export interface PoolSetting {
  /** The URL to give Prisma, or null to leave Prisma's own datasource alone. */
  url: string | null;
  /** The pool size this process uses. */
  poolSize: number;
  /** Where it came from. */
  source: 'DATABASE_URL' | 'DATABASE_POOL_SIZE' | 'PRISMA_DEFAULT';
  poolTimeoutSeconds: number | null;
}

function positiveInt(raw: string | undefined, max: number): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
}

export function poolSetting(
  env: Record<string, string | undefined> = process.env,
  cpus: number = availableParallelism(),
): PoolSetting {
  const raw = env.DATABASE_URL ?? '';
  const prismaDefault = cpus * 2 + 1;
  let parsed: URL | null = null;
  try {
    parsed = raw ? new URL(raw) : null;
  } catch {
    parsed = null;
  }
  const inUrl = positiveInt(parsed?.searchParams.get('connection_limit') ?? undefined, 10_000);
  const timeoutInUrl = positiveInt(parsed?.searchParams.get('pool_timeout') ?? undefined, 3_600);
  if (inUrl !== null) {
    return { url: null, poolSize: inUrl, source: 'DATABASE_URL', poolTimeoutSeconds: timeoutInUrl };
  }
  const size = positiveInt(env.DATABASE_POOL_SIZE, 200);
  const timeout = positiveInt(env.DATABASE_POOL_TIMEOUT_SECONDS, 300);
  if (size === null || !parsed) {
    return {
      url: null,
      poolSize: prismaDefault,
      source: 'PRISMA_DEFAULT',
      poolTimeoutSeconds: timeoutInUrl,
    };
  }
  parsed.searchParams.set('connection_limit', String(size));
  if (timeout !== null && timeoutInUrl === null) {
    parsed.searchParams.set('pool_timeout', String(timeout));
  }
  return {
    url: parsed.toString(),
    poolSize: size,
    source: 'DATABASE_POOL_SIZE',
    poolTimeoutSeconds: timeoutInUrl ?? timeout,
  };
}
