/**
 * Small, pure readers for the event details a buyer checks before paying.
 *
 * Shared by the storefront, the organizer console and the admin console, so all three read an
 * event's terms and a show's length the same way.
 */

/**
 * How long a show runs, in whole minutes, from its own start and end - or null.
 *
 * ── WHY IT IS NOT STORED ──────────────────────────────────────────────────────────
 * Every show already carries a start and an end, set by the organizer. A separate "duration"
 * field would be a second answer to the same question, and the first time an organizer
 * extended a show's end time without touching the duration box, the page would tell buyers one
 * thing and the ticket another.
 *
 * Null when the end is not after the start, or the span is more than a day: a festival pass
 * that runs from Friday to Sunday has a date range, not a duration, and "72 hours" is not how
 * anybody describes one.
 */
export function showDurationMinutes(startsAt: string | Date, endsAt: string | Date): number | null {
  const start = new Date(startsAt).getTime();
  const end = new Date(endsAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const minutes = Math.round((end - start) / 60_000);
  if (minutes <= 0 || minutes > 24 * 60) return null;
  return minutes;
}

/** The same duration split for display: 90 becomes { hours: 1, minutes: 30 }. */
export function splitMinutes(total: number): { hours: number; minutes: number } {
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}

/**
 * The organizer's terms as a list, one entry per line.
 *
 * Organizers paste terms from wherever they keep them, often already numbered or bulleted. The
 * page numbers them itself, so a leading "1.", "2)", "-" or bullet is removed rather than
 * shown twice ("1. 1. Tickets cannot be..."). Blank lines are dropped.
 */
export function termsList(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .trim()
        .replace(/^(?:\d{1,3}[.)]|[-*•])\s+/, '')
        .trim(),
    )
    .filter(Boolean);
}
