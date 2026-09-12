/**
 * Has somebody authorised emptying the database RECENTLY?
 *
 * ── THE FAILURE THIS CLOSES ────────────────────────────────────────────────────────
 * The `db-seed` service has a nightly `cronSchedule`, and a scheduled run executes with whatever
 * variables the service holds at the time. A manual reset sets `SEED_OPERATION=full-reset` and
 * the authorisation, then clears both afterwards — so if that cleanup is interrupted (a closed
 * laptop, a network error, a Ctrl+C in the wrong second), the variables stay, and the next 02:00
 * run empties QA. Every night. Each of those runs also takes a "recovery point" of the freshly
 * emptied database and prunes an older one, so within two weeks the real backups are gone too.
 *
 * `SEED_ALLOW_DESTRUCTIVE=yes` never stops meaning yes. So the authorisation now carries its own
 * expiry — `yes-until-<ISO timestamp>` — and is refused once that moment has passed. A leftover
 * value is harmless by the next night, whether or not anybody remembered to clear it.
 *
 * ── WHY THE WINDOW IS CAPPED ───────────────────────────────────────────────────────
 * An expiry nobody bounds is `yes-until-2099-01-01T00:00:00Z`, which is `yes` with extra typing.
 * An hour is far longer than a reset takes to deploy and run, and far shorter than the gap
 * before the next scheduled run could find it.
 *
 * Pure: takes the value and a clock, performs no I/O, so it is decided before anything connects.
 */

export const DESTRUCTIVE_AUTHORISATION_PREFIX = 'yes-until-';

/** The furthest ahead an authorisation may expire. */
export const MAX_AUTHORISATION_WINDOW_MS = 60 * 60_000;

/*
  A full ISO 8601 date-time WITH a zone. `Date.parse` alone accepts `2026-09-12` (midnight UTC),
  a zone-less time (read in the container's local zone) and assorted free text, and an
  authorisation for destroying data is not the place for a parser to guess what was meant.
*/
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i;

export interface AuthorisationVerdict {
  allowed: boolean;
  reason: string;
}

export function destructiveAuthorisationVerdict(
  raw: string | undefined,
  now: Date = new Date(),
): AuthorisationVerdict {
  const value = (raw ?? '').trim();
  if (!value) {
    return { allowed: false, reason: 'SEED_ALLOW_DESTRUCTIVE is not set.' };
  }
  if (!value.toLowerCase().startsWith(DESTRUCTIVE_AUTHORISATION_PREFIX)) {
    return {
      allowed: false,
      reason:
        `SEED_ALLOW_DESTRUCTIVE must be ${DESTRUCTIVE_AUTHORISATION_PREFIX}<ISO timestamp>, at most ` +
        '60 minutes ahead. A bare "yes" never expires, so one left behind by an interrupted run ' +
        'would let the nightly schedule empty this database.',
    };
  }
  const stamp = value.slice(DESTRUCTIVE_AUTHORISATION_PREFIX.length);
  const until = ISO_TIMESTAMP.test(stamp) ? Date.parse(stamp) : Number.NaN;
  if (Number.isNaN(until)) {
    return {
      allowed: false,
      reason: `SEED_ALLOW_DESTRUCTIVE has an unreadable expiry "${stamp}"; expected a full ISO timestamp with a zone, e.g. 2026-09-12T10:30:00Z.`,
    };
  }
  if (until <= now.getTime()) {
    return {
      allowed: false,
      reason: `SEED_ALLOW_DESTRUCTIVE expired at ${new Date(until).toISOString()}. It is left over from an earlier run and authorises nothing now.`,
    };
  }
  if (until - now.getTime() > MAX_AUTHORISATION_WINDOW_MS) {
    return {
      allowed: false,
      reason: `SEED_ALLOW_DESTRUCTIVE expires at ${new Date(until).toISOString()}, more than 60 minutes from now. Authorise a reset for the next hour, not indefinitely.`,
    };
  }
  return {
    allowed: true,
    reason: `authorised until ${new Date(until).toISOString()}`,
  };
}

/** A correctly formed authorisation lasting `windowMs` from `now`, for messages and runners. */
export function destructiveAuthorisationUntil(now: Date, windowMs: number): string {
  return `${DESTRUCTIVE_AUTHORISATION_PREFIX}${new Date(now.getTime() + windowMs).toISOString()}`;
}
