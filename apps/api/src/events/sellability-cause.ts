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

/**
 * The fault codes an EARLIER-SHAPED message already told its recipient about.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * Before causes had an identity, the sweep sent one message per event and keyed it on the
 * sorted, "+"-joined set of bare codes ("PRICE_OVER_CEILING+SEAT_CLASS_UNMAPPED"). The key a
 * cause carries now names its subject and fix path as well, so it can never equal one of
 * those, and the first run of the new sweep would announce every fault of every event that is
 * still broken all over again - one email and one inbox row per cause, about things the
 * organizer was told weeks ago and can already see in the notification centre.
 *
 * So a cause whose code is in such a set counts as already announced to whoever received that
 * message. Nothing is migrated and no stored row is rewritten: the old rows stay exactly as
 * they were sent, and this only reads them.
 *
 * ── WHAT DOES NOT COUNT ────────────────────────────────────────────────────────────
 * - A row that names its own cause (`blockerCode`). It was written by this version, and its
 *   identity is already in the dedupe key; reading its code as a bare set member would let
 *   "Balcony is unmapped" silence "Box is unmapped", which is a different edit.
 * - The platform team's copy (it names the `organizationId`, the organizer's never did). It
 *   tells an admin what the platform must fix and is no evidence the organizer was told.
 * - Anything that is not a set of plain codes. A value with a subject or fix path in it is
 *   a cause identity, not a set, and a value we cannot read is treated as covering nothing -
 *   the cost of guessing wrong that way is one extra message, not a fault nobody hears about.
 *
 * Returns an empty set for every row that is not of the earlier shape.
 */
export function legacyAnnouncedCodes(payload: unknown): ReadonlySet<string> {
  const none = new Set<string>();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return none;
  const p = payload as Record<string, unknown>;
  if (p.blockerCode !== undefined || p.organizationId !== undefined) return none;
  if (typeof p.blockerCodes !== 'string' || p.blockerCodes.length === 0) return none;
  const codes = p.blockerCodes.split('+');
  if (!codes.every((c) => LEGACY_CODE.test(c))) return none;
  return new Set(codes);
}

/** A bare blocker code, as the earlier sweep joined them: upper case, digits, underscores. */
const LEGACY_CODE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Per recipient, every code an earlier-shaped message about one event already announced.
 *
 * Per RECIPIENT and not per event, because the message went to the owners at the time. An
 * owner added since then was never told anything, and must still hear about each cause once.
 */
export function legacyCoverage(
  rows: ReadonlyArray<{ userId: string | null; payload: unknown }>,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.userId) continue;
    const codes = legacyAnnouncedCodes(row.payload);
    if (codes.size === 0) continue;
    const seen = out.get(row.userId) ?? new Set<string>();
    for (const c of codes) seen.add(c);
    out.set(row.userId, seen);
  }
  return out;
}
