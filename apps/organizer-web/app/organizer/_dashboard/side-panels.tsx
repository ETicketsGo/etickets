'use client';

import Link from 'next/link';
import {
  ChevronDown,
  BadgeCheck,
  Banknote,
  Bell,
  Building2,
  CalendarPlus,
  Film,
  Info,
  ReceiptText,
  Ticket,
  TriangleAlert,
  Users,
  type LucideIcon,
} from 'lucide-react';
import {
  IconTile,
  SectionCard,
  SectionLink,
  Skeleton,
  type NotificationFeedCategory,
  type NotificationFeedGroup,
  type TileTone,
} from '@eticketsgo/web-kit';
import { relativeTime } from '@/lib/notification-feed-view';
import { listSentence } from './model';

export interface QuickAction {
  label: string;
  href: string;
  icon: LucideIcon;
  tone: TileTone;
  /** One line under the label, on the wider tiles. */
  hint: string;
}

/**
 * The quick actions the viewer can actually take. Each one is a page their role opens and their
 * sidebar offers - a tile that leads to "you cannot do this" is worse than no tile.
 */
export function quickActionsFor({
  canCreate,
  canManage,
  doesFilmBusiness,
}: {
  canCreate: boolean;
  canManage: boolean;
  doesFilmBusiness: boolean;
}): QuickAction[] {
  const out: QuickAction[] = [];
  if (canCreate)
    out.push({
      label: 'Create event',
      href: '/organizer/events/new',
      icon: CalendarPlus,
      tone: 'teal',
      hint: 'Start a new event',
    });
  if (canManage) {
    out.push({
      label: 'Add venue',
      href: '/organizer/venues?new=1',
      icon: Building2,
      tone: 'blue',
      hint: 'A place to hold events',
    });
    if (doesFilmBusiness)
      out.push({
        label: 'Manage movies',
        href: '/organizer/movies',
        icon: Film,
        tone: 'purple',
        hint: 'Films and showtimes',
      });
    out.push({
      label: 'View bookings',
      href: '/organizer/bookings',
      icon: ReceiptText,
      tone: 'amber',
      hint: 'Orders and attendees',
    });
  }
  return out;
}

/** Tiles per row from a tablet up: one row of all of them, however many the role has. */
const TABLET_COLUMNS: Record<number, string> = {
  1: 'md:grid-cols-1',
  2: 'md:grid-cols-2',
  3: 'md:grid-cols-3',
  4: 'md:grid-cols-4',
};

/**
 * The quick actions as large tiles in one row under the welcome: an icon tile, the label and a
 * line saying what it opens.
 *
 * They were four small chips in a side card (~38px tall), which the owner found too small to be
 * the page's way in. Now each is at least 3.5rem on a phone (two across, so a thumb lands on
 * one) and 4.5rem from a tablet up (all four across). The console's one solid primary button is in the top bar, so here "Create
 * event" is only the first, teal-edged tile: two solid buttons for one job is what the design
 * direction rules out.
 */
export function QuickActions({ actions }: { actions: QuickAction[] }) {
  if (actions.length === 0) return null;
  return (
    <section aria-labelledby="quick-actions-heading" className="min-w-0">
      <h2 id="quick-actions-heading" className="sr-only">
        Quick actions
      </h2>
      <ul
        className={`grid grid-cols-2 gap-2.5 md:gap-3 ${TABLET_COLUMNS[Math.min(actions.length, 4)]}`}
      >
        {actions.map((a, i) => {
          const primary = a.href === '/organizer/events/new';
          // An odd last tile takes the whole row of a phone's two columns rather than leaving a hole.
          const oddLast = i === actions.length - 1 && actions.length % 2 === 1;
          return (
            <li key={a.href} className={`min-w-0 ${oddLast ? 'max-md:col-span-2' : ''}`}>
              <Link
                href={a.href}
                className={`group flex h-full min-h-[3.5rem] items-center gap-3 rounded-lg border px-3 py-2.5 shadow-xs transition-[box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:shadow-md active:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas motion-reduce:transition-none motion-reduce:hover:translate-y-0 md:min-h-[4.5rem] md:px-4 ${
                  primary
                    ? 'border-action-primary/40 bg-tint-primary text-text-primary'
                    : 'border-border bg-background-surface text-text-primary'
                }`}
              >
                <IconTile
                  icon={a.icon}
                  tone={a.tone}
                  size="lg"
                  className="max-md:!h-9 max-md:!w-9"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-ui font-semibold leading-tight max-md:text-caption lg:truncate">
                    {a.label}
                  </span>
                  <span className="mt-0.5 hidden truncate text-caption text-text-secondary lg:block">
                    {a.hint}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The Overview's fold: a real disclosure button that says exactly what is behind it.
 *
 * The page owns whether it is open (one state for every width) and which regions it opens, so a
 * phone's button and a tablet's can open the same sections. The button stays ABOVE what it opens,
 * so nothing moves from under the thumb that pressed it.
 */
export function FoldButton({
  open,
  onToggle,
  controls,
  parts,
  className = '',
}: {
  open: boolean;
  onToggle: () => void;
  /** The ids of the regions it shows and hides. */
  controls: string;
  /** What is folded, in lower case, in the order it appears. */
  parts: string[];
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className={`min-h-[3.25rem] w-full items-center gap-3 rounded-lg border border-border bg-background-surface px-4 py-2.5 text-left shadow-xs transition-colors duration-150 hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas motion-reduce:transition-none ${className}`}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-ui font-semibold text-text-primary">
          {open ? 'Show less' : 'Show more'}
        </span>
        <span className="block text-caption text-text-muted">{listSentence(parts)}</span>
      </span>
      <ChevronDown
        className={`h-5 w-5 shrink-0 text-text-muted transition-transform duration-150 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
        aria-hidden
      />
    </button>
  );
}

const CATEGORY_TILE: Record<NotificationFeedCategory, { icon: LucideIcon; tone: TileTone }> = {
  ACTION_REQUIRED: { icon: TriangleAlert, tone: 'rose' },
  BOOKINGS_AND_SALES: { icon: Ticket, tone: 'blue' },
  EVENT_APPROVALS: { icon: BadgeCheck, tone: 'teal' },
  PAYMENTS_AND_PAYOUTS: { icon: Banknote, tone: 'amber' },
  CUSTOMER_ACTIVITY: { icon: Users, tone: 'purple' },
  SYSTEM_UPDATES: { icon: Info, tone: 'neutral' },
};

function RetryLine({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <p className="text-caption text-text-muted">
      We could not load {what}.{' '}
      <button
        type="button"
        onClick={onRetry}
        className="rounded-sm font-semibold text-action-primary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Try again
      </button>
    </p>
  );
}

/**
 * The notification feed as a timeline: an icon tile per kind of thing, the title, the feed's own
 * one-line summary and when. Each entry opens what it is about, or the notification centre.
 */
export function ActivityTimeline({
  title,
  groups,
  loading,
  error,
  onRetry,
  empty,
  showAll = true,
  compact = false,
}: {
  title: string;
  groups: NotificationFeedGroup[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  empty: string;
  showAll?: boolean;
  /** Title and time only: the summary line is what made three entries ~250px tall. */
  compact?: boolean;
}) {
  return (
    <SectionCard
      title={title}
      action={
        showAll ? (
          <SectionLink href="/organizer/notifications" srLabel="notifications">
            View all
          </SectionLink>
        ) : undefined
      }
    >
      {loading ? (
        <div className="space-y-4" role="status" aria-label="Loading activity">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex gap-3">
              <Skeleton className="h-9 w-9 shrink-0 rounded-md" />
              <div className="flex-1 space-y-2 pt-0.5">
                <Skeleton className="h-3.5 w-3/4" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <RetryLine what="your notifications" onRetry={onRetry} />
      ) : groups.length === 0 ? (
        <p className="flex items-center gap-2 text-caption text-text-muted">
          <Bell className="h-4 w-4" aria-hidden />
          {empty}
        </p>
      ) : (
        <ol className="relative">
          {groups.map((g, i) => {
            const tile = CATEGORY_TILE[g.category] ?? CATEGORY_TILE.SYSTEM_UPDATES;
            const last = i === groups.length - 1;
            return (
              <li
                key={g.key}
                className={`relative flex gap-3 last:pb-0 ${compact ? 'pb-3' : 'pb-4'}`}
              >
                {/* The thread between entries: decoration, under the tiles. */}
                {!last && (
                  <span
                    aria-hidden
                    className="absolute bottom-0 left-[1.0625rem] top-10 w-px bg-border"
                  />
                )}
                <IconTile icon={tile.icon} tone={tile.tone} size="sm" className="mt-0.5 h-9 w-9" />
                <Link
                  href={g.action?.href ?? '/organizer/notifications'}
                  className="group min-w-0 flex-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="block break-words text-ui font-semibold leading-snug text-text-primary group-hover:text-action-primary">
                    {g.title}
                  </span>
                  {!compact && g.summary && g.summary !== g.title ? (
                    <span className="mt-0.5 line-clamp-2 block text-caption text-text-secondary">
                      {g.summary}
                    </span>
                  ) : null}
                  <span className="mt-0.5 block text-micro text-text-muted">
                    {relativeTime(g.lastAt)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </SectionCard>
  );
}
