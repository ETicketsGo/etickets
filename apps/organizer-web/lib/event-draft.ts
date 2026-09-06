'use client';

/**
 * The half-written event, kept while the organizer goes somewhere else.
 *
 * ── THE REPORT ─────────────────────────────────────────────────────────────────────
 * "When I am creating an event it showed me general seating, but clicked on rooms and
 * completed the room and seat map section, once I complete it is still in rooms section and
 * the worst part I lost the event details which I entered."
 *
 * Both halves of that are the same defect. The wizard held everything in component state, and
 * the only way to get a seat map is to leave the wizard — so the product told somebody to go
 * to another screen and then punished them for doing it. Ten minutes of typing, gone, with no
 * warning and nothing to recover.
 *
 * ── WHY localStorage AND NOT A SERVER DRAFT ────────────────────────────────────────
 * A server draft is the better long-term answer: it survives a closed laptop and follows the
 * person to another device. It is also a new table, a new endpoint, a lifecycle for
 * abandoned rows, and a decision about who else in the organization can see a half-finished
 * event. None of that is needed to stop the reported loss, which happens inside one browser
 * over a few minutes.
 *
 * So this is deliberately small: one key, one org, one draft, cleared the moment the event is
 * really created. If drafts later need to be shared or to survive a device, this is replaced
 * rather than extended.
 *
 * ── WHY IT IS SCOPED TO THE ORGANIZATION ───────────────────────────────────────────
 * Somebody who runs two organizations and starts an event in each would otherwise have the
 * second overwrite the first, and restore the wrong one — which is worse than losing it,
 * because it looks like their work and is not.
 */

const KEY = 'etg_event_draft';

/** Anything older than this is not a draft, it is litter. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface EventDraftEnvelope<T> {
  organizationId: string;
  savedAt: number;
  /** Bumped when the wizard's shape changes, so an old draft is discarded rather than
   *  restored into fields that no longer mean the same thing. */
  version: number;
  data: T;
}

/** Raised whenever the wizard's state shape changes in a way an old draft cannot satisfy. */
export const EVENT_DRAFT_VERSION = 1;

export function saveEventDraft<T>(organizationId: string, data: T): void {
  try {
    if (typeof window === 'undefined') return;
    const envelope: EventDraftEnvelope<T> = {
      organizationId,
      savedAt: Date.now(),
      version: EVENT_DRAFT_VERSION,
      data,
    };
    window.localStorage.setItem(KEY, JSON.stringify(envelope));
  } catch {
    /* A draft that cannot be saved must not break the form somebody is typing into. */
  }
}

/**
 * The saved draft for this organization, or null.
 *
 * Returns null rather than throwing for every reason it might not apply — wrong org, old
 * version, stale, unparseable, private window. A restore that half-works is worse than one
 * that does not happen: the organizer would be editing a form they did not fill in.
 */
export function readEventDraft<T>(organizationId: string): { data: T; savedAt: number } | null {
  try {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const envelope = JSON.parse(raw) as EventDraftEnvelope<T>;
    if (envelope.organizationId !== organizationId) return null;
    if (envelope.version !== EVENT_DRAFT_VERSION) return null;
    if (Date.now() - envelope.savedAt > MAX_AGE_MS) return null;
    return { data: envelope.data, savedAt: envelope.savedAt };
  } catch {
    return null;
  }
}

export function clearEventDraft(): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
}

/** "2 minutes ago", for telling somebody what they are being offered back. */
export function draftAge(savedAt: number, now = Date.now()): string {
  const minutes = Math.round((now - savedAt) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours === 1) return '1 hour ago';
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}
