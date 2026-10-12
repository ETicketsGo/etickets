import type {
  NotificationFeedGroup,
  OrganizerAction,
  OrganizerAnalytics,
  OrganizerCalendarSession,
  PayoutSummary,
  PayoutSummaryCurrency,
} from '@eticketsgo/web-kit';
import { nextShowByEvent, moneyFor, type MarketMoney } from './model';
import { setupSummary } from './status';

/**
 * The adaptive Overview's rules, as values: which events are "upcoming" and which are not yet on
 * sale, how the upcoming block is laid out, what needs action and in what order, what each
 * figure means, and how the money panel is assembled per currency.
 *
 * ── NO NEW FIGURES ─────────────────────────────────────────────────────────────────
 * Everything is a selection, a count or a re-labelling of fields the API already returns. Money
 * is never added across currencies, and the two ways of looking at money - what was SOLD
 * (analytics) and where it stands in the PAYOUT LEDGER (payouts summary) - are kept as separate
 * groups: a held amount is a gross and a payable amount is a net, so they are never summed.
 */

/** Events a buyer can find: published, sold out, or paused after being published. */
export const ON_SALE_STATUSES = ['PUBLISHED', 'SOLD_OUT', 'PAUSED'] as const;
/** Events a buyer cannot see yet. */
export const NOT_YET_STATUSES = ['DRAFT', 'UNDER_REVIEW'] as const;

const isOnSaleStatus = (s: string) => (ON_SALE_STATUSES as readonly string[]).includes(s);
const isNotYetStatus = (s: string) => (NOT_YET_STATUSES as readonly string[]).includes(s);

interface EventLike {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  schedule?: {
    firstStartsAt: string | null;
    lastStartsAt: string | null;
    upcomingSessions: number;
  } | null;
}

/**
 * The next show of each PUBLISHED event, soonest first. A draft is never "upcoming": nobody
 * can buy it, and mixing it in made "Upcoming events" overstate what was actually on sale.
 */
export function upcomingPublishedShows(
  sessions: OrganizerCalendarSession[] | undefined,
  now: Date = new Date(),
  limit = 5,
): OrganizerCalendarSession[] {
  const onSale = (sessions ?? []).filter((s) => isOnSaleStatus(s.event.status));
  return [...nextShowByEvent(onSale, now).values()].slice(0, limit);
}

/** How many published events still have a show to come (the event list's own schedule summary). */
export function upcomingPublishedCount(events: EventLike[] | undefined): number {
  return (events ?? []).filter(
    (e) => isOnSaleStatus(e.status) && (e.schedule?.upcomingSessions ?? 0) > 0,
  ).length;
}

/**
 * Draft and in-review events, newest first. One whose every date has passed is left out: it can
 * no longer be put on sale as it stands, so listing it would be a to-do that cannot be done.
 */
export function notYetOnSale<T extends EventLike>(
  events: T[] | undefined,
  now: Date = new Date(),
): T[] {
  return (events ?? [])
    .filter((e) => {
      if (!isNotYetStatus(e.status)) return false;
      const last = e.schedule?.lastStartsAt;
      return !last || Date.parse(last) >= now.getTime();
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** The draft to offer when nothing is on sale: the newest one that is still a draft. */
export function latestDraft<T extends EventLike>(
  events: T[] | undefined,
  now: Date = new Date(),
): T | null {
  return notYetOnSale(events, now).find((e) => e.status === 'DRAFT') ?? null;
}

export type UpcomingMode =
  /** Nothing published is coming up: say so and offer the draft or Create event. */
  | 'empty'
  /** One event: a single card across the width. */
  | 'featured'
  /** Two or three events that each have their own artwork: image cards side by side. */
  | 'cards'
  /** Four or more, or several without artwork: compact rows with a small category icon. */
  | 'rows';

/** Most rows the compact list draws before "View all". */
export const UPCOMING_ROWS = 5;

/**
 * How the "Upcoming events" block is laid out for what there is.
 *
 * Several large cards each showing the same drawn placeholder looked artificial, so image cards
 * are used only when at most one of the events lacks artwork; otherwise a compact row with a small
 * category icon says the same thing in a fraction of the height.
 */
export function upcomingMode(items: { hasImage: boolean }[]): UpcomingMode {
  const n = items.length;
  if (n === 0) return 'empty';
  if (n === 1) return 'featured';
  const without = items.filter((i) => !i.hasImage).length;
  if (n <= 3 && without <= 1) return 'cards';
  return 'rows';
}

// ─── Needs action ───────────────────────────────────────────────────────────────

export type ActionSeverity = 'blocking' | 'warning';

export interface NeedsActionItem {
  key: string;
  severity: ActionSeverity;
  title: string;
  /** One line: what is stopped, or what could be. */
  detail: string;
  href: string;
  /** The button's words ("Fix this", "Open"). */
  actionLabel: string;
  /** Where it came from, for the reader's trust: the organization's setup or the notification feed. */
  source: 'setup' | 'notification';
}

export interface NeedsAction {
  /** Blocking first, then warnings; within each, setup before notifications, newest first. */
  items: NeedsActionItem[];
  blocking: number;
  warnings: number;
  /** Recommended-only steps that are not listed here, so the list is honest about what it leaves out. */
  suggestions: number;
}

/**
 * What needs the organizer, ranked by severity.
 *
 * Sources are the two the console already has: the organization's setup actions (the server marks
 * each BLOCKING, IMPORTANT or SUGGESTED) and the notification feed's still-open action items (each
 * CRITICAL or WARNING). A blocker is something that stops selling or payment today; a warning is
 * something that may. SUGGESTED and optional steps are counted, not listed: a profile picture is
 * not an emergency and listing it beside one buried the real ones.
 */
export function needsAction(
  actions: OrganizerAction[] | undefined,
  pending: NotificationFeedGroup[] | undefined,
): NeedsAction {
  const setup = setupSummary(actions);
  const fromSetup: NeedsActionItem[] = [
    ...setup.blockers.map((a) => ({ a, severity: 'blocking' as const })),
    ...setup.todo
      .filter((a) => !a.optional && a.severity === 'IMPORTANT')
      .map((a) => ({ a, severity: 'warning' as const })),
  ].map(({ a, severity }) => ({
    key: `setup:${a.key}`,
    severity,
    title: a.title,
    detail: a.consequence,
    href: a.fixPath,
    actionLabel: a.actionLabel,
    source: 'setup' as const,
  }));
  const fromFeed: NeedsActionItem[] = [...(pending ?? [])]
    .sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt))
    .map((g) => ({
      key: `feed:${g.key}`,
      severity: (g.severity === 'CRITICAL' ? 'blocking' : 'warning') as ActionSeverity,
      title: g.title,
      detail: g.summary && g.summary !== g.title ? g.summary : (g.ownerNote ?? ''),
      href: g.action?.href ?? '/organizer/notifications',
      actionLabel: g.action?.label ?? 'Open',
      source: 'notification' as const,
    }));
  const all = [...fromSetup, ...fromFeed];
  const rank = (s: ActionSeverity) => (s === 'blocking' ? 0 : 1);
  // Array.prototype.sort is stable, so the within-severity order above is kept.
  const items = all.sort((a, b) => rank(a.severity) - rank(b.severity));
  const suggestions = setup.todo.filter((a) => a.optional || a.severity === 'SUGGESTED').length;
  return {
    items,
    blocking: items.filter((i) => i.severity === 'blocking').length,
    warnings: items.filter((i) => i.severity === 'warning').length,
    suggestions,
  };
}

// ─── What each figure means ─────────────────────────────────────────────────────

/**
 * The one-line definition shown under every KPI. Each states the rule the API or the page applies,
 * so two organizers reading "Tickets sold" mean the same thing.
 */
export const KPI_DEFINITIONS = {
  upcoming: 'Published events with a show still to come. Drafts are not counted.',
  notYet: 'Drafts and events in review. Buyers cannot see them.',
  tickets: 'Valid tickets held now: active or checked in.',
  needsAction: 'Open items that stop, or may stop, sales or payouts.',
} as const;

// ─── Money, per currency, in two separate groups ────────────────────────────────

export interface MoneyPanel {
  currency: string;
  /** What was sold, and what the organizer keeps of it. All from the organizer analytics. */
  sales: {
    grossMinor: number;
    organizerFeesMinor: number;
    refundsMinor: number;
    /** Gross less the organizer's fees and completed refunds, as the API computes it. */
    proceedsMinor: number;
    /** Charged to buyers on top of the ticket price; never part of the proceeds. */
    buyerFeesMinor: number;
  };
  /**
   * Where the money stands in the payout ledger, or null when the ledger was not read (a role
   * without financial access) or has nothing in this currency.
   *
   * Four stages, never added: held is a gross, the others are nets.
   */
  payout: {
    /** Ticket sales of shows not yet finished or still inside the hold period. */
    heldMinor: number;
    /** Payable now and not yet in a payout. */
    payableMinor: number;
    /** In a payout that has not been sent. */
    inPayoutMinor: number;
    /** In a payout that has been sent. */
    paidMinor: number;
  } | null;
}

const hasMoney = (m: MarketMoney) =>
  m.grossMinor !== 0 ||
  m.netMinor !== 0 ||
  m.refundsMinor !== 0 ||
  m.organizerFeesMinor !== 0 ||
  m.bookingFeesMinor !== 0;

const ledgerHasMoney = (r: PayoutSummaryCurrency) =>
  r.held !== 0 || r.net !== 0 || r.pending !== 0 || r.paid !== 0;

/**
 * One panel per currency that has any money in either source, the organizer's home market first.
 * A currency appears once: INR and USD are two panels, never one blended total. When no currency
 * has money at all, a single empty panel for the home (or first) market, so the page still says
 * where the figures will appear.
 */
export function moneyPanels(
  analytics: OrganizerAnalytics | undefined,
  summary: PayoutSummary | undefined,
  homeCurrency: string | null,
  knownCurrencies: string[],
): MoneyPanel[] {
  const currencies = new Set<string>();
  for (const r of analytics?.revenue ?? []) currencies.add(r.currency);
  for (const r of analytics?.refunds ?? []) currencies.add(r.currency);
  for (const r of summary?.currencies ?? []) currencies.add(r.currency);

  const build = (currency: string): MoneyPanel => {
    const m = moneyFor(analytics, currency);
    const ledger = summary?.currencies.find((c) => c.currency === currency);
    return {
      currency,
      sales: {
        grossMinor: m.grossMinor,
        organizerFeesMinor: m.organizerFeesMinor,
        refundsMinor: m.refundsMinor,
        proceedsMinor: m.netMinor,
        buyerFeesMinor: m.bookingFeesMinor,
      },
      payout: ledger
        ? {
            heldMinor: ledger.held,
            payableMinor: ledger.net,
            inPayoutMinor: ledger.pending,
            paidMinor: ledger.paid,
          }
        : summary
          ? { heldMinor: 0, payableMinor: 0, inPayoutMinor: 0, paidMinor: 0 }
          : null,
    };
  };

  const withMoney = [...currencies].filter((c) => {
    const ledger = summary?.currencies.find((r) => r.currency === c);
    return hasMoney(moneyFor(analytics, c)) || (ledger ? ledgerHasMoney(ledger) : false);
  });
  const ordered = withMoney.sort((a, b) => {
    if (a === homeCurrency) return -1;
    if (b === homeCurrency) return 1;
    return a.localeCompare(b);
  });
  if (ordered.length > 0) return ordered.map(build);

  const fallback =
    (homeCurrency && knownCurrencies.includes(homeCurrency) ? homeCurrency : knownCurrencies[0]) ??
    homeCurrency;
  return fallback ? [build(fallback)] : [];
}
