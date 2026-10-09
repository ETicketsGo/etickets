import type { NotificationFeedGroup, NotificationFeedSeverity } from '@eticketsgo/web-kit';

/**
 * Presentation for the notification centre. What folds into what, and whether a problem is
 * still there, is decided on the server; this only decides how it reads.
 */

/**
 * Severity as words AND colour. A dot or a border colour alone tells nothing to somebody who
 * cannot tell red from green, and nothing at all to a screen reader.
 */
export const SEVERITY_VIEW: Record<
  NotificationFeedSeverity,
  { label: string; tone: 'error' | 'warning' | 'success' | 'info'; accent: string }
> = {
  CRITICAL: { label: 'Needs action', tone: 'error', accent: 'border-l-status-error' },
  WARNING: { label: 'Check this', tone: 'warning', accent: 'border-l-status-warning' },
  SUCCESS: { label: 'Done', tone: 'success', accent: 'border-l-status-success' },
  INFO: { label: 'For your information', tone: 'info', accent: 'border-l-status-info' },
};

/** The badge for one card. A fixed problem says "Fixed", not "Done": it was never a task. */
export function severityView(group: Pick<NotificationFeedGroup, 'severity' | 'resolved'>) {
  const base = SEVERITY_VIEW[group.severity];
  return group.resolved === true ? { ...base, label: 'Fixed' } : base;
}

/**
 * "5 minutes ago", for scanning a list. The exact time goes in the element's title, because a
 * relative time is useless to anybody comparing it with something else.
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const seconds = Math.round((now.getTime() - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (days < 30) return `${weeks} ${weeks === 1 ? 'week' : 'weeks'} ago`;
  return new Date(then).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Which cards a section shows straight away, and which wait behind "Show earlier".
 *
 * A problem still standing is ALWAYS shown, read or not: reading about it does not fix it, and
 * a page that hid it once opened would let the one thing that matters slip out of sight. Only
 * information the organizer has already read - or a problem that is fixed and read - is put
 * away, and it is put away rather than removed, one click from coming back.
 */
export function splitByAttention(groups: NotificationFeedGroup[]): {
  shown: NotificationFeedGroup[];
  earlier: NotificationFeedGroup[];
} {
  const shown: NotificationFeedGroup[] = [];
  const earlier: NotificationFeedGroup[] = [];
  for (const g of groups) {
    const standingProblem = g.category === 'ACTION_REQUIRED' && g.resolved !== true;
    if (standingProblem || !g.read) shown.push(g);
    else earlier.push(g);
  }
  return { shown, earlier };
}

/** "18 showtimes affected", or nothing when the card is not about particular shows. */
export function affectedLabel(count: number): string | null {
  if (count <= 0) return null;
  return `${count} ${count === 1 ? 'showtime' : 'showtimes'} affected`;
}
