'use client';

import Link from 'next/link';
import type { CSSProperties } from 'react';
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
  tileClasses,
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
    });
  if (canManage) {
    out.push({
      label: 'Add venue',
      href: '/organizer/venues?new=1',
      icon: Building2,
      tone: 'blue',
    });
    if (doesFilmBusiness)
      out.push({ label: 'Manage movies', href: '/organizer/movies', icon: Film, tone: 'purple' });
    out.push({
      label: 'View bookings',
      href: '/organizer/bookings',
      icon: ReceiptText,
      tone: 'amber',
    });
  }
  return out;
}

/**
 * The quick actions, as ONE list at every width - arranged by CSS, never swapped by a hook.
 *
 * - Phone: "Create event" is the page's one primary button, full width, and the rest are a row
 *   of small tiles under it. The desktop's 2x2 card of equal tiles took ~200px of a phone and
 *   made the main action look like any other.
 * - Tablet: one row of tiles across the page, ~60px tall where the 2x2 card was ~200px.
 * - Wide screen: the reference's card beside the welcome, two by two.
 *
 * It used to be two components, picked after hydration by `usePhone`: a phone painted the
 * desktop card first and then jumped. One list, styled per breakpoint, paints once.
 */
export function QuickActions({ actions }: { actions: QuickAction[] }) {
  if (actions.length === 0) return null;
  const primaryFirst = actions[0].href === '/organizer/events/new';
  const others = primaryFirst ? actions.length - 1 : actions.length;
  return (
    <section
      aria-labelledby="quick-actions-heading"
      className="min-w-0 xl:rounded-lg xl:border xl:border-border xl:bg-background-surface xl:p-5 xl:shadow-xs"
      // How many tiles share a row: the phone's row under the button, and the tablet's one row.
      style={{ '--qa-row': Math.max(others, 1), '--qa-all': actions.length } as CSSProperties}
    >
      <h2
        id="quick-actions-heading"
        className="sr-only xl:not-sr-only xl:mb-4 xl:font-display xl:text-[1.0625rem] xl:font-bold xl:text-text-primary"
      >
        Quick actions
      </h2>
      <ul className="grid grid-cols-[repeat(var(--qa-row),minmax(0,1fr))] gap-2 md:grid-cols-[repeat(var(--qa-all),minmax(0,1fr))] md:gap-3 xl:grid-cols-2 xl:gap-2.5">
        {actions.map((a, i) => {
          const primary = primaryFirst && i === 0;
          // An odd last tile takes the whole row of the 2x2 card rather than leaving a hole.
          const oddLast = i === actions.length - 1 && actions.length % 2 === 1;
          return (
            <li
              key={a.href}
              className={`min-w-0 ${primary ? 'col-span-full md:col-span-1' : ''} ${oddLast ? 'xl:col-span-2' : ''}`}
            >
              <Link
                href={a.href}
                className={`group flex h-full items-center gap-2 rounded-md px-3 py-2 font-semibold transition-[filter,transform] duration-150 hover:brightness-[0.97] active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas motion-reduce:transition-none dark:hover:brightness-125 md:min-h-[3rem] md:text-[0.8125rem] ${tileClasses(a.tone)} ${
                  primary
                    ? 'max-md:min-h-[3rem] max-md:justify-center max-md:bg-action-primary max-md:text-ui max-md:text-action-primary-foreground max-md:shadow-sm'
                    : 'max-md:min-h-[3.5rem] max-md:flex-col max-md:justify-center max-md:gap-1 max-md:px-1.5 max-md:text-center max-md:text-micro max-md:leading-tight'
                }`}
              >
                <a.icon className="h-4 w-4 shrink-0" aria-hidden />
                <span
                  className={`min-w-0 md:flex-1 md:truncate ${primary ? 'max-md:text-action-primary-foreground' : ''} text-text-primary`}
                >
                  {a.label}
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
}: {
  title: string;
  groups: NotificationFeedGroup[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  empty: string;
  showAll?: boolean;
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
              <li key={g.key} className="relative flex gap-3 pb-4 last:pb-0">
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
                  {g.summary && g.summary !== g.title ? (
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
