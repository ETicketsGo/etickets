import type { SellabilityIssue } from './event-sellability.service';

/**
 * The identity of one ROOT CAUSE of an unsellable event, shared by the producer that notifies
 * about it and the notification centre that asks whether it is still true.
 *
 * ── WHY THE CODE IS NOT ENOUGH ON ITS OWN ──────────────────────────────────────────
 * "Balcony has no regulatory class" and "Box has no regulatory class" are the same code and
 * two different edits; two cinemas missing the same mapping are two different pages to open.
 * The subject and the fix path are what separate them, so they are part of the identity.
 *
 * ── WHY THE MESSAGE IS NOT PART OF IT ──────────────────────────────────────────────
 * The sentence names the date the policy was checked on ("none covers Telangana on
 * 2026-10-09"), so it changes every day the fault persists. Keyed on it, the same fault would
 * notify the organizer again every morning, which is the flood this exists to prevent.
 *
 * A cause with no subject and no fix path is its bare code. That is deliberately what the
 * earlier one-message-per-event sweep stored for an event with a single platform fault, so
 * those faults are not re-announced the first time this version runs.
 */
export function causeIdentity(issue: Pick<SellabilityIssue, 'code' | 'subject' | 'fixPath'>) {
  let id = issue.code;
  if (issue.subject) id += `:${issue.subject}`;
  if (issue.fixPath) id += `@${issue.fixPath}`;
  return id;
}

/**
 * How many affected shows a notification lists by name.
 *
 * The payload is stored once per recipient per channel. A long season can carry hundreds of
 * shows, and nobody reads past the first screenful in a notification anyway; the count still
 * carries the full number.
 */
export const MAX_LISTED_SESSIONS = 100;
