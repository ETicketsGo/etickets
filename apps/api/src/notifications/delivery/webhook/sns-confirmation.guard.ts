/**
 * Where an SNS confirmation token may be held at all.
 *
 * ── WHY A SEPARATE GUARD, AND WHY AN ALLOWLIST ─────────────────────────────────────
 * Holding a live SubscribeURL in a database row is a deliberate, bounded exception to this
 * platform's rule that confirmation tokens never come to rest. It is worth making in QA, where
 * the alternative is that the manual-confirmation design cannot be completed by a human at
 * all. It is not worth making in production, where the same row is a way to attach the
 * production endpoint to somebody else's topic using nothing but an admin session.
 *
 * So the decision is an ALLOWLIST, in the same shape as the destructive-seed guard: an
 * environment that is not named is refused. A denylist would mean a new environment name — or
 * a typo, or an unset variable — silently defaults to permitted, which is the wrong direction
 * for a mistake in this particular file.
 *
 * ── WHY APP_ENV AND NOT NODE_ENV ───────────────────────────────────────────────────
 * QA and UAT both run with `NODE_ENV=production`, because they are built and served like
 * production. A guard keyed on NODE_ENV would therefore refuse in exactly the environments
 * this feature exists for, and a guard that treated `NODE_ENV !== 'production'` as safe would
 * permit it in both. Only APP_ENV distinguishes "built like production" from "serving real
 * customers", which is the question being asked here.
 */

/** Environments where capturing a confirmation token is a legitimate thing to want. */
const CAPTURE_ALLOWED = ['LOCAL', 'DEV', 'TEST', 'CI', 'QA', 'UAT'] as const;

/**
 * Environments that must never capture, listed explicitly.
 *
 * Redundant against the allowlist — anything absent is refused anyway. Named so that an edit
 * adding an environment to the allowlist has to walk past them, and so the refusal for
 * production says "production" rather than "unrecognised".
 */
const NEVER_CAPTURE = ['PRODUCTION', 'PROD', 'STAGING'] as const;

export interface CaptureVerdict {
  allowed: boolean;
  /** The environment as identified, for logging and for the refusal message. Never a secret. */
  appEnv: string | null;
  reason: string;
}

/**
 * Decide from the environment alone.
 *
 * Pure, and performs no I/O, so it can be consulted before anything is written and before any
 * row is read — the refusal must happen before the token comes to rest, not after.
 */
export function snsCaptureVerdict(appEnvRaw: string | null | undefined): CaptureVerdict {
  const appEnv = (appEnvRaw ?? '').trim().toUpperCase() || null;

  if (!appEnv) {
    return {
      allowed: false,
      appEnv: null,
      reason:
        'APP_ENV is not set. A confirmation token is only held in a named non-production ' +
        'environment, and an unset variable is not one.',
    };
  }
  if ((NEVER_CAPTURE as readonly string[]).includes(appEnv)) {
    return {
      allowed: false,
      appEnv,
      reason: `APP_ENV=${appEnv} never holds SNS confirmation tokens.`,
    };
  }
  if (!(CAPTURE_ALLOWED as readonly string[]).includes(appEnv)) {
    return {
      allowed: false,
      appEnv,
      reason:
        `APP_ENV=${appEnv} is not a recognised non-production environment, so it is refused. ` +
        `Permitted: ${CAPTURE_ALLOWED.join(', ')}.`,
    };
  }
  return { allowed: true, appEnv, reason: `APP_ENV=${appEnv} permits capture.` };
}
