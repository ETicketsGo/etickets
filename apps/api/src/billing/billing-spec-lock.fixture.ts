/**
 * Serialises the billing real-Postgres specs against each other.
 *
 * They share the plan catalogue (BillingPlan codes are unique: FREE, PRO, PREMIUM), and each
 * removes the plans IT created when it ends. Run in parallel Jest workers, one spec could delete
 * the catalogue under the other, or fail its own cleanup on the other's subscriptions. A session
 * advisory lock, held on a dedicated one-connection client for the whole spec, makes them take
 * turns. Test-only; never imported by application code.
 */
const BILLING_SPEC_LOCK_KEY = 7_310_001;

export async function holdBillingSpecLock(url: string): Promise<() => Promise<void>> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PrismaClient } = require('@prisma/client');
  const single = `${url}${url.includes('?') ? '&' : '?'}connection_limit=1`;
  const client = new PrismaClient({ datasources: { db: { url: single } } });
  // `::text`: the function returns void, which the client cannot read back as a column.
  await client.$queryRawUnsafe(`SELECT pg_advisory_lock(${BILLING_SPEC_LOCK_KEY})::text AS held`);
  return async () => {
    try {
      await client.$queryRawUnsafe(`SELECT pg_advisory_unlock(${BILLING_SPEC_LOCK_KEY})`);
    } finally {
      await client.$disconnect();
    }
  };
}
