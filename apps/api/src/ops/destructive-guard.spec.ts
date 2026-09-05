import { destructiveResetVerdict } from '../../prisma/destructive-guard';

/**
 * The guard that decides whether this process may empty a database.
 *
 * ── WHY EVERY ONE OF THESE MATTERS ─────────────────────────────────────────────────
 * A QA environment was emptied by accident: an API-set start command was silently overridden
 * by config-as-code, and the old command was the destructive seed. The recovery for that is
 * not "be more careful" — it is that the destructive path refuses unless the environment has
 * been NAMED as one where emptying the database is a legitimate thing to want.
 *
 * These are pure-function tests on purpose. The guard takes an env object and returns a
 * verdict, touching no database, so it can be consulted before a client is constructed. A
 * guard that has to connect in order to decide has already connected to the thing it is
 * deciding about.
 */
const env = (over: Record<string, string | undefined>) => over as NodeJS.ProcessEnv;

describe('environments where the database may be emptied', () => {
  it.each(['LOCAL', 'DEV', 'TEST', 'CI', 'QA', 'UAT'])('allows %s', (APP_ENV) => {
    expect(destructiveResetVerdict(env({ APP_ENV })).allowed).toBe(true);
  });

  it('is case-insensitive, because APP_ENV is typed by humans', () => {
    expect(destructiveResetVerdict(env({ APP_ENV: 'qa' })).allowed).toBe(true);
  });
});

describe('environments where it must be impossible', () => {
  it.each(['PRODUCTION', 'PROD', 'STAGING'])('refuses %s', (APP_ENV) => {
    const v = destructiveResetVerdict(env({ APP_ENV }));
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain(APP_ENV);
  });

  it('refuses production even when both authorisation variables are set', () => {
    /*
      The point of the allowlist. Requiring two variables makes an accident unlikely; it does
      not make a production reset impossible, and "unlikely" is not the standard for an
      operation that destroys a company's records. There is no configuration that switches
      this on — only an edit to the allowlist, in a commit, with a reviewer.
    */
    const v = destructiveResetVerdict(
      env({
        APP_ENV: 'PRODUCTION',
        SEED_OPERATION: 'full-reset',
        SEED_ALLOW_DESTRUCTIVE: 'yes',
      }),
    );
    expect(v.allowed).toBe(false);
  });

  it('refuses production even when NODE_ENV claims otherwise', () => {
    const v = destructiveResetVerdict(env({ APP_ENV: 'PRODUCTION', NODE_ENV: 'development' }));
    expect(v.allowed).toBe(false);
  });
});

describe('when the environment cannot be identified', () => {
  it('refuses when APP_ENV is not set at all', () => {
    // The failure mode of a "refuse if production" check: an unset variable is not production,
    // so the tables go. An allowlist refuses instead of assuming.
    const v = destructiveResetVerdict(env({}));
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/not set/i);
  });

  it('refuses when APP_ENV is empty or whitespace', () => {
    expect(destructiveResetVerdict(env({ APP_ENV: '' })).allowed).toBe(false);
    expect(destructiveResetVerdict(env({ APP_ENV: '   ' })).allowed).toBe(false);
  });

  it('refuses a value nobody recognises, rather than assuming it is safe', () => {
    const v = destructiveResetVerdict(env({ APP_ENV: 'SANDBOX-2' }));
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('SANDBOX-2');
  });

  it('refuses a near-miss typo of an allowed environment', () => {
    expect(destructiveResetVerdict(env({ APP_ENV: 'QAA' })).allowed).toBe(false);
  });
});

describe('when two sources of truth disagree', () => {
  it('refuses when APP_ENV says QA and the platform says production', () => {
    /*
      Railway sets RAILWAY_ENVIRONMENT_NAME itself; APP_ENV is set by whoever configured the
      service. If they disagree, this process does not know where it is — and choosing which
      to believe is how a "QA" reset lands on production data.
    */
    const v = destructiveResetVerdict(
      env({ APP_ENV: 'QA', RAILWAY_ENVIRONMENT_NAME: 'production' }),
    );
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/disagreement/i);
  });

  it('allows when both agree', () => {
    const v = destructiveResetVerdict(env({ APP_ENV: 'QA', RAILWAY_ENVIRONMENT_NAME: 'QA' }));
    expect(v.allowed).toBe(true);
  });
});
