'use client';

import Link from 'next/link';
import { useId, useState, type ReactNode } from 'react';
import {
  ArrowRight,
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
  ButtonLink,
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

/** The pastel action tiles, as the reference stacks them beside the welcome. */
export function QuickActions({ actions }: { actions: QuickAction[] }) {
  if (actions.length === 0) return null;
  return (
    <SectionCard title="Quick actions">
      {/* One row of four on a laptop, where the card spans the page; two by two beside the welcome. */}
      <ul className="grid grid-cols-1 gap-2.5 min-[360px]:grid-cols-2 lg:grid-cols-4 xl:grid-cols-2">
        {actions.map((a, i) => (
          // An odd last tile takes the whole row rather than leaving a hole beside it.
          <li
            key={a.href}
            className={
              i === actions.length - 1 && actions.length % 2 === 1 ? 'min-[360px]:col-span-2' : ''
            }
          >
            <Link
              href={a.href}
              className={`group flex min-h-[2.75rem] items-center sm:min-h-[3rem] gap-2 rounded-md px-2.5 py-2 text-[0.8125rem] font-semibold sm:px-3 transition-[filter,transform] duration-150 hover:brightness-[0.97] active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background-surface motion-reduce:transition-none dark:hover:brightness-125 ${tileClasses(a.tone)}`}
            >
              <a.icon className="h-4 w-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-text-primary">{a.label}</span>
              <ArrowRight
                className="ml-auto hidden h-4 w-4 shrink-0 transition-transform min-[480px]:block lg:hidden duration-150 group-hover:translate-x-0.5 motion-reduce:transition-none"
                aria-hidden
              />
            </Link>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

/**
 * The quick actions on a phone: "Create event" as the one primary button, the rest as a row of
 * small tiles under it. The desktop's 2x2 card of equal tiles took ~200px of a phone and made
 * the page's one main action look like any other.
 */
export function PhoneActions({ actions }: { actions: QuickAction[] }) {
  if (actions.length === 0) return null;
  const [first, ...rest] = actions;
  const primary = first.href === '/organizer/events/new' ? first : null;
  const others = primary ? rest : actions;
  return (
    <section aria-labelledby="phone-actions-heading" className="space-y-2.5">
      <h2 id="phone-actions-heading" className="sr-only">
        Quick actions
      </h2>
      {primary && (
        <ButtonLink href={primary.href} icon={primary.icon} size="lg" className="w-full">
          {primary.label}
        </ButtonLink>
      )}
      {others.length > 0 && (
        <ul
          className="grid gap-2"
          style={{ gridTemplateColumns: `repeat(${others.length}, minmax(0, 1fr))` }}
        >
          {others.map((a) => (
            <li key={a.href} className="min-w-0">
              <Link
                href={a.href}
                className={`flex h-full min-h-[3.5rem] flex-col items-center justify-center gap-1 rounded-md px-1.5 py-2 text-center text-micro font-semibold leading-tight transition-[filter] duration-150 active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas motion-reduce:transition-none ${tileClasses(a.tone)}`}
              >
                <a.icon className="h-4 w-4 shrink-0" aria-hidden />
                <span className="text-text-primary">{a.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The phone's fold: the Overview's detailed sections behind one real disclosure button.
 *
 * Collapsed by default, because a phone opens this page to see how today is going, not to read
 * the gross-to-net working; the button says exactly what is behind it, so nothing is hidden
 * that the organizer cannot see is there. The button stays above the sections it opens, so it
 * does not move from under the thumb that pressed it.
 */
export function MoreOnOverview({
  parts,
  children,
}: {
  /** What is folded, in lower case, in the order it appears. */
  parts: string[];
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="space-y-4">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-[3.25rem] w-full items-center gap-3 rounded-lg border border-border bg-background-surface px-4 py-2.5 text-left shadow-xs transition-colors duration-150 hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas motion-reduce:transition-none"
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
      <div id={id} hidden={!open} className="space-y-4">
        {children}
      </div>
    </div>
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
