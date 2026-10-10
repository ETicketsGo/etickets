import type { BadgeTone, SellabilityIssue } from '@eticketsgo/web-kit';
import { eventZone, localDate } from './event-list-model';

/**
 * The three separate things an organizer asks about an event, kept apart on purpose:
 *
 * - LIFECYCLE: where it is on the road from draft to ended (Draft, In review, Approved,
 *   Published, Ended, Cancelled).
 * - SALE STATE: whether a buyer can buy right now ("Selling" or "Not selling: <reason>"),
 *   read from the event's status and the server's own sale check - never guessed here.
 * - SETUP: what is still the organizer's to do ("Setup complete" or "<n> things to set up").
 *
 * The old console said "Ready to sell" for a draft, because it answered the third question
 * and the reader heard the second. Three answers, three labels. Pure, so each rule is tested.
 */

export type LifecycleLabel =
  'Draft' | 'In review' | 'Approved' | 'Published' | 'Ended' | 'Cancelled';

export interface Lifecycle {
  label: LifecycleLabel | string;
  tone: BadgeTone;
  /** A second fact the stage alone hides: "Paused", "Changes requested", "Sold out". */
  detail: { label: string; tone: BadgeTone } | null;
}

export interface LifecycleInput {
  status: string;
  publishedAt?: string | null;
  reviewNote?: string | null;
  needsReviewOnResume?: boolean;
  pausedByAdmin?: boolean;
}

export function lifecycleOf(e: LifecycleInput): Lifecycle {
  switch (e.status) {
    case 'DRAFT':
      return {
        label: 'Draft',
        tone: 'neutral',
        // A rejection puts the event back to DRAFT with the reviewer's note and no publish date.
        detail:
          e.reviewNote && !e.publishedAt ? { label: 'Changes requested', tone: 'error' } : null,
      };
    case 'UNDER_REVIEW':
      return { label: 'In review', tone: 'info', detail: null };
    case 'PUBLISHED':
      return { label: 'Published', tone: 'success', detail: null };
    case 'SOLD_OUT':
      return { label: 'Published', tone: 'success', detail: { label: 'Sold out', tone: 'info' } };
    case 'PAUSED':
      /*
        Approved, not Published: a paused event passed review but is off sale. Which kind of
        pause is the detail, because it decides who can lift it.
      */
      return {
        label: 'Approved',
        tone: 'neutral',
        detail: e.pausedByAdmin
          ? { label: 'Paused by platform', tone: 'error' }
          : e.needsReviewOnResume
            ? { label: 'Paused, review needed to resume', tone: 'warning' }
            : { label: 'Paused', tone: 'warning' },
      };
    case 'COMPLETED':
      return { label: 'Ended', tone: 'neutral', detail: null };
    case 'CANCELLED':
      return { label: 'Cancelled', tone: 'error', detail: null };
    default:
      return {
        label: e.status.charAt(0) + e.status.slice(1).toLowerCase().replaceAll('_', ' '),
        tone: 'neutral',
        detail: null,
      };
  }
}

export interface SaleState {
  /** True only when the server's check says a purchase would succeed. Null while unknown. */
  selling: boolean | null;
  /** "Selling", "Not selling: <reason>", or a sentence saying the check has not answered. */
  label: string;
}

/** The server's sale check, as far as this needs it. Undefined while loading. */
export interface SaleCheck {
  sellable: boolean;
  blockers: Pick<SellabilityIssue, 'message' | 'owner'>[];
}

const stripStop = (s: string) => s.trim().replace(/\.$/, '');
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * Whether a buyer can buy, with the reason when not.
 *
 * Status speaks first because it is decisive: a draft cannot sell however well it is set up.
 * Only a published event with something to come is put to the server's check, and only the
 * server's "sellable" turns this into "Selling". A check that has not answered is said to be
 * unanswered, never assumed either way.
 */
export function saleStateOf(input: {
  status: string;
  pausedByAdmin?: boolean;
  upcomingSessions: number;
  check: SaleCheck | undefined;
  checkFailed?: boolean;
}): SaleState {
  const no = (reason: string): SaleState => ({ selling: false, label: `Not selling: ${reason}` });
  switch (input.status) {
    case 'CANCELLED':
      return no('the event is cancelled');
    case 'COMPLETED':
      return no('the event has ended');
    case 'DRAFT':
      return no('not published yet');
    case 'UNDER_REVIEW':
      return no('waiting for approval');
    case 'PAUSED':
      return no(input.pausedByAdmin ? 'paused by the platform team' : 'you paused sales');
    case 'SOLD_OUT':
      return no('sold out');
  }
  if (input.upcomingSessions === 0) return no('no sessions to come');
  if (input.checkFailed) return { selling: null, label: 'Sale check unavailable' };
  if (!input.check) return { selling: null, label: 'Checking sales' };
  if (input.check.sellable) return { selling: true, label: 'Selling' };
  const first = input.check.blockers[0];
  return no(first ? lowerFirst(stripStop(first.message)) : 'a sale would be refused');
}

export interface SetupItem {
  label: string;
  href: string | null;
}

export interface Setup {
  complete: boolean;
  /** "Setup complete", "1 thing to set up", "3 things to set up". */
  label: string;
  items: SetupItem[];
}

/**
 * What is still the organizer's to set up.
 *
 * The server's blockers and warnings that are THEIRS (a platform-owned fault is not a task for
 * them, and counting it made a checklist that could never be finished), plus the two things a
 * buyer notices that no sale rule checks: a description and a picture.
 */
export function setupOf(input: {
  eventId: string;
  description: string | null | undefined;
  hasImage: boolean;
  issues: Pick<SellabilityIssue, 'message' | 'owner' | 'fixPath'>[];
}): Setup {
  const items: SetupItem[] = [];
  const seen = new Set<string>();
  for (const issue of input.issues) {
    if (issue.owner === 'PLATFORM') continue;
    // One fault on twenty shows is one task, not twenty.
    if (seen.has(issue.message)) continue;
    seen.add(issue.message);
    items.push({ label: stripStop(issue.message), href: issue.fixPath });
  }
  const edit = `/organizer/events/${input.eventId}/edit`;
  if (!input.description?.trim()) items.push({ label: 'Add a description', href: edit });
  if (!input.hasImage) items.push({ label: 'Add a cover picture', href: edit });
  const n = items.length;
  return {
    complete: n === 0,
    label: n === 0 ? 'Setup complete' : `${n} thing${n === 1 ? '' : 's'} to set up`,
    items,
  };
}

/** True when a session starts on today's date at its venue, or is running now. */
export function hasSessionToday(
  sessions: { startsAt: string; endsAt: string; status: string }[],
  venue: { timezone?: string | null; country?: string | null },
  now: number,
): boolean {
  const { zone } = eventZone(venue);
  const today = localDate(new Date(now).toISOString(), zone);
  return sessions.some((s) => {
    if (s.status === 'CANCELLED') return false;
    const start = new Date(s.startsAt).getTime();
    const end = new Date(s.endsAt).getTime();
    if (start <= now && end > now) return true;
    return end > now && localDate(s.startsAt, zone) === today;
  });
}

export type NextStep =
  | { kind: 'submit'; title: string; body: string }
  | { kind: 'resume'; title: string; body: string }
  | { kind: 'link'; title: string; body: string; label: string; href: string }
  | { kind: 'none'; title: string; body: string };

/**
 * The one thing to do next, which the overview leads with.
 *
 * In the order an organizer would want it: run the door when there is a show today; fix what
 * stops a sale before anything else; then whatever moves the event forward (submit, resume,
 * share). Never more than one primary action - the rest of the page holds the others.
 */
export function nextStepOf(input: {
  eventId: string;
  status: string;
  pausedByAdmin?: boolean;
  needsReviewOnResume?: boolean;
  sessionToday: boolean;
  sale: SaleState;
  /** Organizer-owned blockers from the server's check. */
  ownBlockers: number;
}): NextStep {
  const base = `/organizer/events/${input.eventId}`;
  const fix = (title: string): NextStep => ({
    kind: 'link',
    title,
    body: 'A buyer would be turned away at checkout until these are fixed.',
    label: 'See what to fix',
    href: '#readiness',
  });
  switch (input.status) {
    case 'CANCELLED':
      return {
        kind: 'link',
        title: 'This event is cancelled',
        body: 'Bookings and refunds stay on the Orders page.',
        label: 'See orders',
        href: `${base}/orders`,
      };
    case 'COMPLETED':
      return {
        kind: 'link',
        title: 'This event has ended',
        body: 'Sales and attendance are in the report.',
        label: 'See the report',
        href: `${base}/reports`,
      };
    case 'DRAFT':
      if (input.ownBlockers > 0)
        return fix(
          `Fix ${input.ownBlockers} thing${input.ownBlockers === 1 ? '' : 's'} before you submit`,
        );
      return {
        kind: 'submit',
        title: 'Send it for approval',
        body: 'The platform team reviews new events before they go on sale.',
      };
    case 'UNDER_REVIEW':
      return {
        kind: 'none',
        title: 'Waiting for approval',
        body: 'The platform team is reviewing this event. You can keep editing while you wait.',
      };
    case 'PAUSED':
      if (input.pausedByAdmin)
        return {
          kind: 'none',
          title: 'Paused by the platform team',
          body: 'Only the platform team can lift this pause. Contact support to resume sales.',
        };
      return {
        kind: 'resume',
        title: 'Sales are paused',
        body: input.needsReviewOnResume
          ? 'Details were edited while paused, so resuming may send it for review first.'
          : 'Resume to put tickets back on sale.',
      };
  }
  if (input.sessionToday)
    return {
      kind: 'link',
      title: 'Doors open today',
      body: 'Scan tickets at the entrance, or look a guest up by name.',
      label: 'Open check-in',
      href: `${base}/checkin`,
    };
  if (input.sale.selling === false && input.ownBlockers > 0) return fix('Fix what stops sales');
  if (input.status === 'SOLD_OUT')
    return {
      kind: 'link',
      title: 'Sold out',
      body: 'Every ticket is gone. See who is coming.',
      label: 'See attendees',
      href: `${base}/attendees`,
    };
  return {
    kind: 'link',
    title: input.sale.selling ? 'On sale now' : 'Published',
    body: 'Share the event page so people can find it.',
    label: 'Share the event',
    href: `${base}/promote`,
  };
}
