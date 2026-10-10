'use client';

import Link from 'next/link';
import {
  ArrowRight,
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
      <ul className="grid grid-cols-1 gap-2.5 min-[360px]:grid-cols-2">
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
                className="ml-auto hidden h-4 w-4 shrink-0 transition-transform min-[480px]:block xl:hidden duration-150 group-hover:translate-x-0.5 motion-reduce:transition-none"
                aria-hidden
              />
            </Link>
          </li>
        ))}
      </ul>
    </SectionCard>
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
