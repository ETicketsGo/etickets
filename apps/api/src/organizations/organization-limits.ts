/**
 * How many organizations one account may have waiting, and how quickly anybody may register
 * them.
 *
 * ── WHY LIMITS AT ALL, WHEN NOTHING PENDING CAN SELL ───────────────────────────────
 * A new organization cannot take money until an admin approves it, so this is not a fraud
 * control. The harm of unlimited registration is operational: a flood of junk buries the
 * genuine organizers waiting for review, and every registration used to email every admin —
 * so enough of them would spend the day's sending allowance and the booking confirmations
 * after them would not go out.
 */

/**
 * Organizations one account may have awaiting review at once.
 *
 * PENDING only. An agency legitimately runs several brands; once an organization is approved
 * or rejected it stops counting, so a real business is never stuck, while an account with
 * several unreviewed registrations is plainly not waiting on one.
 */
export const MAX_PENDING_ORGANIZATIONS_PER_ACCOUNT = 2;

/**
 * Registrations allowed from one source per hour.
 *
 * The environment override exists for test runners — one machine standing in for many
 * organizers, the case this limit is not aimed at — and follows the auth limit's precedent.
 * Deployments that set nothing get the production value.
 */
export const ORG_REGISTRATION_THROTTLE = {
  default: {
    limit: Number(process.env.ORG_REGISTRATION_THROTTLE_LIMIT ?? 5),
    ttl: 60 * 60 * 1000,
  },
};

/** The advisory-lock name that serialises one account's registrations. */
export function registrationLockKey(userId: string): string {
  return `organization-registration:${userId}`;
}

/**
 * The notification intent for "organizations are awaiting review", per clock hour (UTC).
 *
 * Notifications sharing an intent are sent once per recipient, so every registration within
 * the hour collapses into one email per admin.
 */
export function registrationDigestIntent(at: Date = new Date()): string {
  return `organization-registered:${at.toISOString().slice(0, 13)}`;
}
