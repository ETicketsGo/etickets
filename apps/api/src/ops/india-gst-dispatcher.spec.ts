/**
 * unit - the `india-gst` operations actually EXECUTE when the dispatcher runs them.
 *
 * ── WHY A SOURCE-PATTERN TEST WAS NOT ENOUGH ───────────────────────────────────────
 * `seed-operation.ts` runs this seed with `require('./seed-india-gst')` and depends on the
 * module's import side effect to do the work. A first attempt at tidying that up added
 * `if (require.main === module)` around `main()`, which would have made both GST operations
 * do NOTHING while still exiting zero - the same silent-success shape that left production
 * five days without a backup.
 *
 * Asserting that the source still contains `require('./seed-india-gst')` does not catch that:
 * the require would still be there, and would still "succeed". So this drives the dispatcher
 * for real against a recording Prisma stub and asserts the WRITES it should perform.
 *
 * Nothing here touches a database. `@prisma/client` is mocked, so the only thing that can be
 * observed is what the seed tried to do.
 */

/** Every call the seed makes, in order, so the assertions can be about behaviour. */
const calls: Array<{ model: string; method: string; args: unknown }> = [];

jest.mock('@prisma/client', () => {
  const record = (model: string, method: string) => (args: unknown) => {
    calls.push({ model, method, args });
    if (method === 'findFirst') return Promise.resolve(null);
    if (method === 'count') return Promise.resolve(0);
    return Promise.resolve({ id: 'rule_1' });
  };
  return {
    PrismaClient: class {
      taxRule = {
        findFirst: record('taxRule', 'findFirst'),
        create: record('taxRule', 'create'),
        update: record('taxRule', 'update'),
        count: record('taxRule', 'count'),
      };
      $disconnect = () => Promise.resolve();
    },
  };
});

/** An authorisation window the dispatcher will accept (PR #214 requires one). */
const until = () => new Date(Date.now() + 30 * 60_000).toISOString();

/** Let the seed's un-awaited promise settle - the dispatcher deliberately does not await it. */
const settle = () => new Promise((r) => setTimeout(r, 50));

async function runDispatcher(operation: string) {
  const savedArgv = [...process.argv];
  const savedEnv = { ...process.env };
  calls.length = 0;
  process.env.SEED_OPERATION = operation;
  process.env.SEED_OPERATION_UNTIL = until();
  process.env.APP_ENV = 'LOCAL';
  process.env.DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/none';
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('../../prisma/seed-operation');
  await settle();
  process.argv = savedArgv;
  process.env = savedEnv;
  return [...calls];
}

const creates = (c: ReturnType<typeof Array.prototype.slice>) =>
  (c as Array<{ model: string; method: string; args: { data?: { active?: boolean } } }>).filter(
    (x) => x.method === 'create',
  );

describe('india-gst executes the seed', () => {
  it('writes rules, and writes them INACTIVE', async () => {
    /*
      THE TEST THAT CATCHES THE REGRESSION. With a `require.main === module` guard in the seed,
      this array is empty and the operation still "succeeds".
    */
    const c = await runDispatcher('india-gst');
    const written = creates(c);
    expect(written.length).toBeGreaterThan(0);
    for (const w of written) {
      expect(w.args.data?.active).toBe(false);
    }
  });

  it('looks for an existing rule before writing one', async () => {
    // Idempotency: the seed matches on shape and leaves a rate somebody edited alone.
    const c = await runDispatcher('india-gst');
    expect(c.some((x) => x.method === 'findFirst')).toBe(true);
  });
});

describe('india-gst-activate executes the activation path', () => {
  it('writes rules ACTIVE when activation is deliberately requested', async () => {
    const c = await runDispatcher('india-gst-activate');
    const written = creates(c);
    expect(written.length).toBeGreaterThan(0);
    for (const w of written) {
      expect(w.args.data?.active).toBe(true);
    }
  });

  it('differs from india-gst only in that flag, so the two cannot be confused', async () => {
    const inactive = creates(await runDispatcher('india-gst'));
    const active = creates(await runDispatcher('india-gst-activate'));
    expect(active.length).toBe(inactive.length);
    expect(active.every((w) => w.args.data?.active === true)).toBe(true);
    expect(inactive.every((w) => w.args.data?.active === false)).toBe(true);
  });
});

describe('an operation that does nothing is not a success', () => {
  it('a GST operation that performs no write would fail these tests', async () => {
    /*
      Stated as its own assertion so the intent survives a future refactor: the contract is
      "the dispatcher caused writes", not "the dispatcher exited zero".
    */
    const c = await runDispatcher('india-gst');
    expect(c.length).toBeGreaterThan(0);
    expect(c.map((x) => x.method)).toContain('create');
  });
});
