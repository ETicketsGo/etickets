/**
 * Which operation is this `db-seed` run allowed to perform, and may it claim to be the backup?
 *
 * ── THE FAILURE THIS CLOSES ────────────────────────────────────────────────────────
 * Production went five days with no backup, and every night reported SUCCESS.
 *
 * The nightly cron takes a recovery point only when `SEED_OPERATION` is unset, falling through
 * to `SEED_DEFAULT_OPERATION=backup`. Somebody ran a manual `payment-providers` operation and
 * the variable stayed behind. An explicit operation outranks the fallback, so from then on the
 * 02:00 run re-asserted payment provider rows and took no backup - while Railway showed a green
 * scheduled deployment each time. Newest recovery point: 2026-09-29. Noticed: 2026-10-04, at a
 * pre-deploy gate, by a person looking for a dump that was not there.
 *
 * A schedule running the wrong job is indistinguishable from one that works, because both end
 * in SUCCESS. That is the defect - not the stale variable, which is just how it happened.
 *
 * ── WHY AN EXPIRY, AND NOT A CHECK FOR "IS THIS THE CRON" ──────────────────────────
 * `destructive-authorisation.ts` already argues this exact case for `SEED_ALLOW_DESTRUCTIVE`:
 * the service runs nightly with whatever variables it holds, so a manual authorisation left
 * behind by an interrupted run gets picked up by the schedule. Its answer is an authorisation
 * that expires. The same reasoning applies to `SEED_OPERATION` itself, and nobody had extended
 * it there - so the destructive flag could not be left behind, but the operation could.
 *
 * So: an explicit operation is a MANUAL invocation, and manual invocations now carry a window.
 * Inside it, the operation runs. Outside it, the value is leftovers and is refused - loudly,
 * with a non-zero exit, which turns a silent green cron into a failed one on the FIRST night.
 *
 * This needs no knowledge of Railway's cron internals, which is the point: detecting "am I the
 * scheduled run" would be guesswork against someone else's deployment semantics, and guesswork
 * is what the fail-closed direction protects us from. The question asked here is narrower and
 * answerable from the environment alone - "did a human authorise this, recently?"
 *
 * Pure: environment in, verdict out, no I/O. It is decided before anything opens a connection.
 */
import { ISO_TIMESTAMP, MAX_AUTHORISATION_WINDOW_MS } from './destructive-authorisation';

/**
 * Every operation the dispatcher understands.
 *
 * Here so that an operation nobody recognises falls through to the dispatcher's own
 * "Unknown SEED_OPERATION" error. Refusing it here instead would replace a precise message
 * with a vaguer one, and the reason a run was refused would depend on which variable happened
 * to be missing.
 */
export const KNOWN_OPERATIONS = [
  'status',
  'backups',
  'backup',
  'restore-drill',
  'india-gst',
  'india-gst-activate',
  'india-cinema',
  'payment-routes',
  'payment-providers',
  'review-catalogue',
  'backfill-objects',
  'full-reset',
] as const;

/**
 * The operation this guard does NOT cover, because it is already covered better.
 *
 * `full-reset` has its own expiring authorisation (`SEED_ALLOW_DESTRUCTIVE=yes-until-...`) AND
 * an environment guard that refuses production from environment variables alone, before
 * anything opens a connection. Requiring a second window on top added nothing and did real
 * harm: it refused a production reset for the WEAKER reason - a missing window rather than
 * "this is a production database" - which puts the strongest guard out of reach and makes the
 * refusal message depend on which variable is absent. A guard that hides a better guard is a
 * regression, so this one steps aside here.
 */
export const ALREADY_GUARDED = 'full-reset';

/** Operations the FALLBACK may select. Deliberately excludes everything that writes. */
export const DEFAULTABLE = ['status', 'backup', 'backups', 'restore-drill'] as const;

/** What a run does when nothing at all is configured: a read-only census. */
export const SAFE_DEFAULT = 'status';

export type OperationSource = 'manual' | 'scheduled' | 'safe-default';

export interface OperationVerdict {
  /** The operation that will run, when `allowed`. */
  operation: string;
  /** Exactly what `SEED_OPERATION` held, for the evidence line. */
  requested: string;
  /** Where the decision came from. */
  source: OperationSource;
  allowed: boolean;
  reason: string;
}

export const OPERATION_WINDOW_VARIABLE = 'SEED_OPERATION_UNTIL';

/**
 * Is there a live human authorisation for a manual operation?
 *
 * Same shape and the same cap as the destructive authorisation, because it is the same problem
 * and a second format would be a second thing to get wrong.
 */
function windowVerdict(raw: string | undefined, now: Date): { ok: boolean; reason: string } {
  const value = (raw ?? '').trim();
  if (!value) {
    return { ok: false, reason: `${OPERATION_WINDOW_VARIABLE} is not set.` };
  }
  const until = ISO_TIMESTAMP.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(until)) {
    return {
      ok: false,
      reason: `${OPERATION_WINDOW_VARIABLE} has an unreadable expiry "${value}"; expected a full ISO timestamp with a zone, e.g. 2026-10-05T01:30:00Z.`,
    };
  }
  if (until <= now.getTime()) {
    return {
      ok: false,
      reason: `${OPERATION_WINDOW_VARIABLE} expired at ${new Date(until).toISOString()}.`,
    };
  }
  if (until - now.getTime() > MAX_AUTHORISATION_WINDOW_MS) {
    return {
      ok: false,
      reason: `${OPERATION_WINDOW_VARIABLE} is more than ${MAX_AUTHORISATION_WINDOW_MS / 60_000} minutes ahead, which is a permanent authorisation with extra typing.`,
    };
  }
  return { ok: true, reason: `authorised until ${new Date(until).toISOString()}` };
}

/**
 * Decide what this run does.
 *
 * Three outcomes, and only three:
 *   - `SEED_OPERATION` set WITH a live window  -> that operation runs (manual maintenance)
 *   - `SEED_OPERATION` set WITHOUT one         -> REFUSED; it is leftovers shadowing the schedule
 *   - `SEED_OPERATION` unset                   -> the fallback, or a read-only census
 */
export function resolveOperation(
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date(),
): OperationVerdict {
  const requested = (env.SEED_OPERATION ?? '').trim().toLowerCase();
  const fallback = (env.SEED_DEFAULT_OPERATION ?? '').trim().toLowerCase();

  if (requested !== '') {
    /*
      Hand straight back anything this guard should not be the one to judge: an unrecognised
      operation (the dispatcher has a better message) and `full-reset` (it has stronger guards,
      which must run first).
    */
    if (
      requested === ALREADY_GUARDED ||
      !(KNOWN_OPERATIONS as readonly string[]).includes(requested)
    ) {
      return {
        operation: requested,
        requested,
        source: 'manual',
        allowed: true,
        reason: 'judged by its own guards further down',
      };
    }
    const w = windowVerdict(env[OPERATION_WINDOW_VARIABLE], now);
    if (!w.ok) {
      /*
        The message has to tell whoever reads a failed cron what actually happened, because the
        person reading it is not the person who left the variable behind.
      */
      return {
        operation: requested,
        requested,
        source: 'manual',
        allowed: false,
        reason:
          `SEED_OPERATION="${requested}" is set but not authorised: ${w.reason} ` +
          'A left-behind SEED_OPERATION silently replaces the scheduled backup, ' +
          'which is how production went five days with no recovery point. ' +
          'Run operations through scripts/deploy/run-seed-operation.mjs, which sets the window; ' +
          'or clear SEED_OPERATION to let the schedule take its backup.',
      };
    }
    return {
      operation: requested,
      requested,
      source: 'manual',
      allowed: true,
      reason: `manual operation, ${w.reason}`,
    };
  }

  if ((DEFAULTABLE as readonly string[]).includes(fallback)) {
    return {
      operation: fallback,
      requested,
      source: 'scheduled',
      allowed: true,
      reason: `scheduled operation from SEED_DEFAULT_OPERATION=${fallback}`,
    };
  }

  return {
    operation: SAFE_DEFAULT,
    requested,
    source: 'safe-default',
    allowed: true,
    reason: fallback
      ? `SEED_DEFAULT_OPERATION=${fallback} is not one a schedule may select; falling back to ${SAFE_DEFAULT}`
      : `nothing configured; falling back to the read-only ${SAFE_DEFAULT}`,
  };
}

/**
 * One machine-readable line saying what this run actually did.
 *
 * The old evidence was `BACKUP_JSON {name,bytes,kept}`, printed only by the backup branch - so a
 * run that took no backup printed nothing distinguishable from a run that did, and the absence
 * was only visible to somebody who already suspected it. This prints on EVERY run, carries the
 * requested and the resolved operation side by side, and is greppable across a month of logs.
 */
export function evidenceLine(fields: Record<string, unknown>): string {
  return `SEED_EVIDENCE ${JSON.stringify(fields)}`;
}
