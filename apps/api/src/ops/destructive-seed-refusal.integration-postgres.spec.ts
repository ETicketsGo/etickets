import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

/**
 * The destructive seed, run for real, under production identity.
 *
 * ── WHY THIS SPAWNS A PROCESS INSTEAD OF CALLING A FUNCTION ────────────────────────
 * `destructive-guard.spec.ts` proves the decision. This proves the WIRING: that the dispatcher
 * consults the guard, that it does so before `require('./seed')` constructs a Prisma client,
 * and that the process actually dies. Those are three different things from "the function
 * returns false", and the incident that prompted all of this was a wiring failure — an
 * API-set start command silently overridden by config-as-code — not a logic failure.
 *
 * ── WHY DATABASE_URL POINTS AT NOTHING ─────────────────────────────────────────────
 * The child is given an unreachable database on purpose. If the guard works, it refuses and
 * exits before anything tries to connect, and the unreachable host is never contacted. If the
 * guard ever regresses, the child gets as far as connecting and fails with a CONNECTION error
 * instead of the refusal — which fails these assertions just as loudly, while making it
 * impossible for a broken guard to empty a real database in order to prove that it is broken.
 */
const prisma = new PrismaClient();
const SCRIPT = join(__dirname, '..', '..', 'prisma', 'seed-operation.ts');
const UNREACHABLE = 'postgresql://nobody:nobody@127.0.0.1:1/definitely-not-a-database';

/** Run the dispatcher exactly as the `db-seed` service does, and capture what happened. */
/**
 * Run the dispatcher exactly as the `db-seed` service does, and capture what happened.
 *
 * Compiler options go through TS_NODE_COMPILER_OPTIONS rather than the `--compiler-options`
 * flag: passing JSON as an argv element needs a shell on Windows, and the shell then eats the
 * quotes and hands ts-node `{module:commonjs}`, which is not JSON. An environment variable has
 * no such problem on any platform.
 */
/**
 * How long the dispatcher gets before the child is killed.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * `execFileSync` without a timeout is unbounded, and it blocks the Jest worker's event loop
 * completely while it waits. A child that never exits is therefore not a failing test, it is
 * a suite that never finishes — and this one did exactly that on CI, holding a step for its
 * entire twenty-minute budget while every other suite had already reported.
 *
 * It went unnoticed because this file was added on the same day the destructive-seed guard
 * broke CI's seed step, so the tests below it never ran there once. The first CI run to get
 * past that step was the first to execute this file at all.
 *
 * Generous enough that a slow runner starting ts-node seven times is never the reason it
 * fires: the guard's whole point is to refuse before touching anything, which takes no time
 * at all.
 */
const RUN_TIMEOUT_MS = 45_000;

/**
 * A directory with nothing in it, used as the child's entire PATH.
 *
 * ── WHY A TEST HAS TO TAKE THE TOOLS AWAY ──────────────────────────────────────────
 * The backup shells out to `pg_dump`, resolved from PATH. A test asserting what happens
 * "when the backup cannot be taken" therefore has to MAKE the backup impossible — and until
 * now it did not: it relied on the machine not having postgresql-client installed.
 *
 * That is true on this laptop and false on the CI runner, so the same test proved two
 * different things depending on where it ran, and on the runner it did not prove anything at
 * all: `pg_dump` existed, ran against a deliberately unreachable database, and sat there
 * until the suite was killed.
 *
 * An empty PATH makes the premise true by construction, on every machine. Nothing else in
 * the child needs it: node is already resolved by the parent, and ts-node resolves through
 * node's own module lookup rather than PATH.
 */
const NO_TOOLS_DIR = mkdtempSync(join(tmpdir(), 'etg-no-tools-'));

const run = (env: Record<string, string>, opts: { withoutExternalTools?: boolean } = {}) => {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: UNREACHABLE,
    TS_NODE_TRANSPILE_ONLY: 'true',
    TS_NODE_COMPILER_OPTIONS: '{"module":"commonjs","moduleResolution":"node"}',
    ...env,
  };
  if (opts.withoutExternalTools) {
    // Windows spells it `Path`, and the spread above carries whichever casing this platform
    // uses — so every variant goes, or the original would quietly still apply.
    for (const key of Object.keys(childEnv)) {
      if (/^path$/i.test(key)) delete childEnv[key];
    }
    childEnv.PATH = NO_TOOLS_DIR;
  }
  try {
    /*
      `process.execPath`, not 'node'.

      Node resolves the command through the PATH it is GIVEN, so emptying PATH to hide
      pg_dump also hid node itself: the child failed to spawn at all and produced no output,
      which looked like the guard saying nothing. The absolute path keeps the interpreter
      reachable while the child's own tool lookups still find nothing.
    */
    const stdout = execFileSync(process.execPath, ['-r', 'ts-node/register', SCRIPT], {
      env: childEnv,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: RUN_TIMEOUT_MS,
      // SIGKILL rather than SIGTERM: a child wedged inside a native call may not handle a
      // polite signal, and the point of the timeout is that it always ends.
      killSignal: 'SIGKILL',
    });
    return { code: 0, output: stdout };
  } catch (e) {
    const err = e as {
      status?: number;
      stdout?: string;
      stderr?: string;
      signal?: string;
      code?: string;
    };
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    /*
      A timeout must NOT be reported as an ordinary non-zero exit.

      Every assertion below checks that the dispatcher refused by exiting non-zero, and a
      killed child also has no exit status -- so a hang would have satisfied the very
      assertions written to prove the guard works. A test that passes because the thing it
      tests never finished is worse than one that fails.
    */
    if (err.signal === 'SIGKILL' || err.code === 'ETIMEDOUT') {
      throw new Error(
        `The seed dispatcher did not exit within ${RUN_TIMEOUT_MS}ms and was killed. ` +
          `This is not a refusal -- the guard never answered. Output so far:\n${output.slice(0, 2000)}`,
      );
    }
    return { code: err.status ?? 1, output };
  }
};

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the destructive seed under production identity', () => {
  it('refuses, exits non-zero, and never reaches the database', () => {
    const before = Date.now();
    const r = run({
      APP_ENV: 'PRODUCTION',
      SEED_OPERATION: 'full-reset',
      // Both authorisation variables set. This is the case the allowlist exists for: two
      // variables make an accident unlikely, and "unlikely" is not the standard here.
      SEED_ALLOW_DESTRUCTIVE: 'yes',
    });

    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/REFUSING TO EMPTY THIS DATABASE/i);
    expect(r.output).toContain('PRODUCTION');

    /*
      The refusal happened BEFORE any database access. If execution had reached the seed, the
      unreachable DATABASE_URL above would have produced a connection failure — so the absence
      of one is the evidence that nothing connected.
    */
    expect(r.output).not.toMatch(/ECONNREFUSED|Can't reach database|P1001|P1000/i);
    expect(Date.now() - before).toBeLessThan(120_000);
  });

  it.each([['STAGING'], ['PROD']])('refuses %s as well', (APP_ENV) => {
    const r = run({ APP_ENV, SEED_OPERATION: 'full-reset', SEED_ALLOW_DESTRUCTIVE: 'yes' });
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/REFUSING TO EMPTY THIS DATABASE/i);
  });

  it('refuses when APP_ENV is absent, rather than treating unknown as safe', () => {
    const r = run({ APP_ENV: '', SEED_OPERATION: 'full-reset', SEED_ALLOW_DESTRUCTIVE: 'yes' });
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/REFUSING TO EMPTY THIS DATABASE/i);
  });
});

describe('the authorisation variables, in an allowed environment', () => {
  it('refuses full-reset without SEED_ALLOW_DESTRUCTIVE', () => {
    const r = run({ APP_ENV: 'QA', SEED_OPERATION: 'full-reset' });
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/Refusing to run full-reset/i);
  });

  it('does nothing destructive when SEED_ALLOW_DESTRUCTIVE is set but no operation is', () => {
    // A stray authorisation variable must not be an instruction. With no operation the
    // dispatcher runs its read-only default, which here fails to CONNECT — proving it took
    // the census path and not the reset path.
    const r = run({ APP_ENV: 'QA', SEED_ALLOW_DESTRUCTIVE: 'yes' });
    expect(r.output).toMatch(/seed-operation: status/);
    expect(r.output).not.toMatch(/about to be emptied/i);
  });

  it('refuses an operation nobody recognises', () => {
    const r = run({ APP_ENV: 'QA', SEED_OPERATION: 'reset-everything-please' });
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/Unknown SEED_OPERATION/i);
    expect(r.output).not.toMatch(/about to be emptied/i);
  });
});

describe('a destructive run with no recovery point', () => {
  it('ABORTS before touching anything when the backup cannot be taken', () => {
    /*
      The single change that would have turned the QA incident into an inconvenience.

      BACKUP_DIR points somewhere that cannot be created even as root, so takeBackup() fails.
      The reset must abort on that failure rather than proceeding — "the backup failed but we
      carried on" is the sentence that precedes every unrecoverable incident.

      DATABASE_URL is still unreachable, so if the abort ever stops working the run gets as far
      as connecting and fails with a CONNECTION error instead. Either way this test fails; only
      the correct behaviour produces the abort message with no connection attempt.
    */
    const r = run(
      {
        APP_ENV: 'QA',
        SEED_OPERATION: 'full-reset',
        SEED_ALLOW_DESTRUCTIVE: 'yes',
        BACKUP_DIR: '/proc/self/cannot-create-this',
      },
      /*
        Both belts. An uncreatable directory should stop `takeBackup` at its first step, and
        an empty PATH stops it at the second even if some platform happens to allow the
        first — which is exactly the difference that made this test meaningless on CI.
      */
      { withoutExternalTools: true },
    );

    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/ABORTING: could not take a recovery point/i);
    expect(r.output).toMatch(/nothing has been touched/i);
    // It never reached the seed, so it never announced the reset and never connected.
    expect(r.output).not.toMatch(/about to be emptied/i);
    expect(r.output).not.toMatch(/ECONNREFUSED|Can't reach database|P1001|P1000/i);
  });
});

describe('the real database is untouched by any of the above', () => {
  it('still holds its rows', async () => {
    // Belt and braces: the child was pointed at an unreachable host, so this can only fail if
    // something ignored DATABASE_URL entirely.
    const policies = await prisma.cinemaPricingPolicy.count();
    expect(policies).toBeGreaterThan(0);
  });
});
