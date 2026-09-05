/**
 * May this process empty the database it is pointed at?
 *
 * ── AN ALLOWLIST, NOT A PRODUCTION CHECK ───────────────────────────────────────────
 * The obvious guard is "refuse if this is production". It fails the moment the environment
 * cannot be identified: an unset APP_ENV, a typo, a new environment nobody added to the list —
 * every one of those reads as "not production" and the tables go.
 *
 * So the question asked here is the opposite one. An environment must be NAMED as resettable.
 * Anything else — production, staging, a value nobody recognises, no value at all — is refused
 * without needing to know what it is.
 *
 * ── WHY NOT NODE_ENV ───────────────────────────────────────────────────────────────
 * QA and UAT both run with `NODE_ENV=production`, because they are production builds. A guard
 * keyed on NODE_ENV would refuse to reset QA (annoying) while telling you it had protected
 * production (false). `APP_ENV` is the repository's authoritative environment identity and is
 * what every other environment-sensitive check in the codebase already uses.
 *
 * ── WHY IT NEVER RETURNS "ALLOWED" FOR PRODUCTION, EVEN WITH BOTH VARIABLES SET ────
 * Requiring two environment variables makes an accident unlikely. It does not make a
 * production reset impossible, and "unlikely" is not the standard for an operation that
 * destroys a company's records. PRODUCTION and STAGING are absent from the allowlist and
 * cannot be added through configuration — the only way to reset production is to edit this
 * file, in a commit, with a reviewer.
 */

/** Environments where emptying the database is a legitimate thing to want. */
const RESETTABLE = ['LOCAL', 'DEV', 'TEST', 'CI', 'QA', 'UAT'] as const;

/**
 * Environments that must never be reset, listed explicitly.
 *
 * Redundant against the allowlist — anything not on that list is refused anyway. Named here so
 * that a future edit adding an environment to RESETTABLE has to walk past them, and so the
 * refusal for production says "production" rather than "unrecognised".
 */
const NEVER = ['PRODUCTION', 'PROD', 'STAGING'] as const;

export interface GuardVerdict {
  allowed: boolean;
  /** The environment as identified, for logging. Never a secret. */
  appEnv: string | null;
  railwayEnv: string | null;
  reason: string;
}

/**
 * Decide, from environment variables alone. Performs no I/O and touches no database, so it can
 * be called before a client is constructed — which is the point: the refusal must happen
 * before anything opens a connection, not inside the transaction that would do the damage.
 */
export function destructiveResetVerdict(env: NodeJS.ProcessEnv = process.env): GuardVerdict {
  const appEnv = (env.APP_ENV ?? '').trim().toUpperCase() || null;
  const railwayEnv = (env.RAILWAY_ENVIRONMENT_NAME ?? '').trim().toUpperCase() || null;
  const base = { appEnv, railwayEnv };

  if (!appEnv) {
    return {
      ...base,
      allowed: false,
      reason:
        'APP_ENV is not set, so this process cannot tell which environment it is pointed at. ' +
        'Refusing to empty a database it cannot identify.',
    };
  }

  if ((NEVER as readonly string[]).includes(appEnv)) {
    return {
      ...base,
      allowed: false,
      reason: `APP_ENV is ${appEnv}. This operation empties every table and is not available in that environment through any configuration.`,
    };
  }

  if (!(RESETTABLE as readonly string[]).includes(appEnv)) {
    return {
      ...base,
      allowed: false,
      reason: `APP_ENV is "${appEnv}", which is not one of the environments where a destructive reset is permitted (${RESETTABLE.join(', ')}). Refusing rather than assuming it is safe.`,
    };
  }

  /*
    Two sources of truth that disagree.

    Railway sets RAILWAY_ENVIRONMENT_NAME itself; APP_ENV is set by whoever configured the
    service. If one says QA and the other says production, something is misconfigured and the
    honest answer is that this process does not know where it is. Guessing which to believe is
    how a "QA" reset lands on production data.
  */
  if (railwayEnv && (NEVER as readonly string[]).includes(railwayEnv)) {
    return {
      ...base,
      allowed: false,
      reason: `APP_ENV says ${appEnv} but the platform reports the environment as ${railwayEnv}. That disagreement is itself the problem; refusing until it is resolved.`,
    };
  }

  return {
    ...base,
    allowed: true,
    reason: `APP_ENV is ${appEnv}${railwayEnv ? ` (platform: ${railwayEnv})` : ''}, which permits a destructive reset.`,
  };
}

/**
 * Refuse loudly, and exit, if this environment may not be reset.
 *
 * Exits the process rather than throwing: a thrown error can be caught by a well-meaning
 * wrapper and turned into a warning, and there is no version of "carry on" that is correct
 * here.
 */
export function assertDestructiveResetAllowed(env: NodeJS.ProcessEnv = process.env): void {
  const verdict = destructiveResetVerdict(env);
  if (verdict.allowed) return;
  // eslint-disable-next-line no-console
  console.error(`\nREFUSING TO EMPTY THIS DATABASE.\n  ${verdict.reason}\n`);
  process.exit(1);
}
