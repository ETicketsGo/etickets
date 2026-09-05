import { execFileSync } from 'node:child_process';
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
const run = (env: Record<string, string>) => {
  try {
    const stdout = execFileSync('node', ['-r', 'ts-node/register', SCRIPT], {
      env: {
        ...process.env,
        DATABASE_URL: UNREACHABLE,
        TS_NODE_TRANSPILE_ONLY: 'true',
        TS_NODE_COMPILER_OPTIONS: '{"module":"commonjs","moduleResolution":"node"}',
        ...env,
      },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { code: 0, output: stdout };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
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

describe('the real database is untouched by any of the above', () => {
  it('still holds its rows', async () => {
    // Belt and braces: the child was pointed at an unreachable host, so this can only fail if
    // something ignored DATABASE_URL entirely.
    const policies = await prisma.cinemaPricingPolicy.count();
    expect(policies).toBeGreaterThan(0);
  });
});
