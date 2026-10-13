import { money, type PayoutSummary } from '@eticketsgo/web-kit';
import { venueInputZone } from '../../../lib/zoned-time';
import { zoneShortName, type EventListRow } from '../../../components/events/event-list-model';
import { localPlace } from '../../../lib/calendar';
import {
  ON_SALE_STATUSES,
  notYetOnSale,
  type MoneyPanel,
  type NeedsAction,
} from './overview-model';

/**
 * The desk Overview's rules (docs/design/DESIGN-SYSTEM.md, the organizer slice), as values.
 *
 * The page answers five questions and nothing else: what is happening with my events (Coming
 * up), what needs me (Needs you, costliest first), how many tickets have I sold, where is my
 * money (two figures, one currency each), and what should I do next (one step). Everything else
 * is one click away in the sidebar.
 *
 * ── NO NEW FIGURES ─────────────────────────────────────────────────────────────────
 * Every number is an API field or a count of rows the API returned. Money is shown in ONE
 * currency per figure and never added across currencies; a second currency is named beside it,
 * in its own unit, never folded in.
 */

/** Most rows "Coming up" shows before "All events". */
export const COMING_UP_ROWS = 6;
/** Of those, at most this many are drafts or events in review: the table is about what is on. */
export const COMING_UP_NOT_YET = 2;

export interface ComingUpRow {
  event: EventListRow;
  /** On sale (published, paused, sold out) with a date to come, or not on sale yet. */
  kind: 'on-sale' | 'not-yet';
  /** The next show still to come, or null when the event has none. */
  startsAt: string | null;
  /** The venue's zone, for the date and time AT the venue. */
  zone: string;
}

const isOnSale = (s: string) => (ON_SALE_STATUSES as readonly string[]).includes(s);

/**
 * The events that are happening: published ones with a show still to come, soonest first, then
 * the newest drafts or events in review to fill the table. Read from the event list's own
 * schedule summary, so an event three months out is listed - the calendar's four-week window
 * used to say "Nothing in the next four weeks" above two events on sale.
 */
export function comingUpRows(
  events: EventListRow[] | undefined,
  now: Date = new Date(),
  limit = COMING_UP_ROWS,
  maxNotYet = COMING_UP_NOT_YET,
): ComingUpRow[] {
  const t = now.getTime();
  const zoneOf = (e: EventListRow) => venueInputZone(e.venue).zone;
  const onSale = (events ?? [])
    .filter((e) => {
      const next = e.schedule?.nextStartsAt;
      return isOnSale(e.status) && !!next && Date.parse(next) >= t;
    })
    .sort((a, b) => Date.parse(a.schedule!.nextStartsAt!) - Date.parse(b.schedule!.nextStartsAt!))
    .map<ComingUpRow>((e) => ({
      event: e,
      kind: 'on-sale',
      startsAt: e.schedule!.nextStartsAt!,
      zone: zoneOf(e),
    }));
  const notYet = notYetOnSale(events, now)
    .slice(0, maxNotYet)
    .map<ComingUpRow>((e) => ({
      event: e,
      kind: 'not-yet',
      startsAt: e.schedule?.nextStartsAt ?? null,
      zone: zoneOf(e),
    }));
  const head = onSale.slice(0, limit);
  return [...head, ...notYet.slice(0, Math.max(0, limit - head.length))];
}

/** How many events "All events" would list beyond the table: everything on sale or not yet. */
export function comingUpTotal(events: EventListRow[] | undefined, now: Date = new Date()): number {
  const t = now.getTime();
  const onSale = (events ?? []).filter((e) => {
    const next = e.schedule?.nextStartsAt;
    return isOnSale(e.status) && !!next && Date.parse(next) >= t;
  }).length;
  return onSale + notYetOnSale(events, now).length;
}

/** "Sat 21 Nov": the date AT the venue. */
export function venueDate(iso: string, zone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
    .format(new Date(iso))
    .replace(',', '');
}

/** "6:30 PM IST": the time AT the venue, with its zone. */
export function venueTime(iso: string, zone: string): string {
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso));
  return `${time} ${zoneShortName(iso, zone)}`;
}

/** "Sat 21 Nov, 6:30 PM IST": the date and time AT the venue, with its zone. */
export function venueWhen(iso: string, zone: string): string {
  return `${venueDate(iso, zone)}, ${venueTime(iso, zone)}`;
}

/** Whether a show is on today's date AT ITS VENUE - the one place the desk uses marigold. */
export function isTodayAtVenue(iso: string, zone: string, now: Date = new Date()): boolean {
  return localPlace(iso, zone).day === localPlace(now, zone).day;
}

/** Sold as a share of capacity, 0-100, for the bar. Nothing to sell is 0, never a division by 0. */
export function soldShare(sold: number, capacity: number): number {
  if (capacity <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((sold / capacity) * 100)));
}

// ─── The money figures ──────────────────────────────────────────────────────────

export interface MoneyFigures {
  currency: string;
  gross: { value: string; context: string };
  /** Null when the payout ledger was not read (no financial access) or has no row. */
  payable: { value: string; context: string } | null;
}

function shortDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(iso));
}

/**
 * The two money figures, for the first panel's currency (the organizer's home market first).
 * Other currencies are named in the gross figure's line, each in its own unit; nothing is added.
 */
export function moneyFigures(
  panels: MoneyPanel[],
  summary: PayoutSummary | undefined,
): MoneyFigures | null {
  const first = panels[0];
  if (!first) return null;
  const fmt = (minor: number, currency = first.currency) => money(minor, currency);
  const others = panels.slice(1).filter((p) => p.sales.grossMinor !== 0);
  const gross = {
    value: fmt(first.sales.grossMinor),
    context:
      others.length > 0
        ? `In ${first.currency}. Also ${others.map((p) => fmt(p.sales.grossMinor, p.currency)).join(', ')} in ${others.map((p) => p.currency).join(', ')}.`
        : 'Ticket sales before fees and refunds',
  };

  const ledger = first.payout;
  let payable: MoneyFigures['payable'] = null;
  if (ledger) {
    const release = (summary?.heldRevenue ?? [])
      .filter((h) => h.currency === first.currency)
      .map((h) => h.payableFrom)
      .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
    const context =
      ledger.heldMinor > 0
        ? `${fmt(ledger.heldMinor)} held${release ? `, first release ${shortDate(release)}` : ' until shows end'}`
        : ledger.inPayoutMinor > 0
          ? `${fmt(ledger.inPayoutMinor)} in a payout being prepared`
          : ledger.payableMinor > 0
            ? 'Ready for your next payout'
            : ledger.paidMinor > 0
              ? `${fmt(ledger.paidMinor)} paid to you so far`
              : 'Nothing waiting to be paid';
    payable = { value: fmt(ledger.payableMinor), context };
  }
  return { currency: first.currency, gross, payable };
}

// ─── The next step ──────────────────────────────────────────────────────────────

export interface NextStep {
  title: string;
  detail: string;
  href: string;
  actionLabel: string;
}

/**
 * The one thing to do next when nothing needs fixing. (When something does, the costliest item
 * in "Needs you" is the next step and this is not asked.) Plain rules, in order: a first event,
 * a draft to finish, the soonest event to look in on, or the next event to plan.
 */
export function nextStepWhenClear({
  events,
  rows,
  canCreate,
}: {
  events: EventListRow[];
  rows: ComingUpRow[];
  canCreate: boolean;
}): NextStep | null {
  if (events.length === 0) {
    return canCreate
      ? {
          title: 'Create your first event',
          detail:
            'Add the date, the venue and your tickets. You can save a draft and finish later.',
          href: '/organizer/events/new',
          actionLabel: 'Create event',
        }
      : null;
  }
  const draft = rows.find((r) => r.kind === 'not-yet' && r.event.status === 'DRAFT');
  if (draft) {
    return {
      title: `Finish ${draft.event.title}`,
      detail: 'It is a draft. Buyers cannot see it until it is approved and published.',
      href: `/organizer/events/${draft.event.id}`,
      actionLabel: 'Open draft',
    };
  }
  const soonest = rows.find((r) => r.kind === 'on-sale');
  if (soonest) {
    return {
      title: `See who is coming to ${soonest.event.title}`,
      detail: 'Orders and attendees for your next event.',
      href: `/organizer/events/${soonest.event.id}/orders`,
      actionLabel: 'Open orders',
    };
  }
  return canCreate
    ? {
        title: 'Plan your next event',
        detail: 'Nothing is on sale right now.',
        href: '/organizer/events/new',
        actionLabel: 'Create event',
      }
    : null;
}

/** The figure's line under "Needs you": what kind of items they are, in words. */
export function needsContext(needs: NeedsAction): string {
  if (needs.items.length === 0) return 'All clear';
  if (needs.blocking > 0)
    return needs.blocking === 1
      ? '1 item blocks sales or payouts'
      : `${needs.blocking} items block sales or payouts`;
  return needs.warnings === 1 ? '1 item to check' : `${needs.warnings} items to check`;
}

/**
 * The organization's standing with the platform, in plain words beside the page title.
 */
export function orgStanding(status: string): {
  label: string;
  tone: 'positive' | 'caution' | 'critical';
} {
  switch (status) {
    case 'APPROVED':
      // Said quietly, as the old welcome band did: organizers look for it.
      return { label: 'Approved organizer', tone: 'positive' };
    case 'PENDING':
    case 'PENDING_REVIEW':
    case 'UNDER_REVIEW':
      return { label: 'Waiting for approval', tone: 'caution' };
    case 'SUSPENDED':
      return { label: 'Suspended', tone: 'critical' };
    case 'REJECTED':
      return { label: 'Not approved', tone: 'critical' };
    default:
      return {
        label: status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, ' '),
        tone: 'caution',
      };
  }
}

export interface ChosenStep {
  step: NextStep;
  /** The "Needs you" item this step IS, so the list does not show it twice; null otherwise. */
  itemKey: string | null;
  blocking: boolean;
}

/**
 * The page's ONE next step.
 *
 * The costliest open item, as "Needs you" orders them - with one exception: an organization
 * with no event at all is told to create one first. Its bank account blocks payouts, but there
 * is nothing to pay out yet, and a first-run page that opens on paperwork is the wall of alarms
 * the audit (O2) asked us to remove. The paperwork stays listed right under it, in order.
 */
export function pickNextStep({
  needs,
  events,
  rows,
  canCreate,
}: {
  needs: NeedsAction;
  events: EventListRow[];
  rows: ComingUpRow[];
  canCreate: boolean;
}): ChosenStep | null {
  const first = needs.items[0];
  if (first && !(events.length === 0 && canCreate)) {
    return {
      step: {
        title: first.title,
        detail: first.detail,
        href: first.href,
        actionLabel: first.actionLabel,
      },
      itemKey: first.key,
      blocking: first.severity === 'blocking',
    };
  }
  const plain = nextStepWhenClear({ events, rows, canCreate });
  return plain ? { step: plain, itemKey: null, blocking: false } : null;
}
