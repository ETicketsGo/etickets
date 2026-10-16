'use client';

import Link from 'next/link';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  ChevronDown,
  Info,
  OctagonAlert,
  type LucideIcon,
} from 'lucide-react';
import {
  api,
  Button,
  ErrorState,
  PageHeader,
  brandButtonClasses,
  timeAtVenue,
  recordedAt,
  zoneAbbrev,
  useToast,
  errorMessage,
  type NotificationFeed,
  type NotificationFeedGroup,
  type NotificationFeedSeverity,
} from '@eticketsgo/web-kit';
import {
  affectedLabel,
  filterFeed,
  isStandingProblem,
  relativeTime,
  severityView,
  splitByAttention,
  type FeedFilter,
} from '@/lib/notification-feed-view';

/**
 * The organizer's notification centre.
 *
 * ── WHY IT IS GROUPED ──────────────────────────────────────────────────────────────
 * This page used to print one row per stored notification. One seating fault on a film was
 * reported once per showtime, so the page showed the same full sentence dozens of times, and
 * the organizer had to read them all to learn that they were one problem with one fix.
 *
 * The server folds notifications by root cause - same kind, same event, same fault - and says
 * whether the fault is still there. This page lays the result out as ONE LIST, the way a mail
 * client does: what needs action first, then everything else by subject, one row per cause,
 * unread rows marked, the action on the row, and the affected showtimes and the technical
 * detail one click away. Filters (All, Unread, and each subject) narrow it.
 *
 * ── WHY IT WAS REBUILT (organizer recovery) ───────────────────────────────────────
 * The card-per-cause layout made one QA organization's page over 9,000px tall: forty approval
 * cards each the size of a blocking problem. A subject with nothing unread said "Nothing new
 * here" and then offered "Show earlier (12)" with no explanation. Now a row is two or three
 * lines, each subject shows its first few rows and says how many more there are, and a
 * subject whose rows are all read says so in words. Nothing stored changes.
 */

const SEVERITY_ICON: Record<NotificationFeedSeverity, LucideIcon> = {
  CRITICAL: OctagonAlert,
  WARNING: AlertTriangle,
  SUCCESS: CheckCircle2,
  INFO: Info,
};

/** Colour repeats the severity WORD beside it; it never carries the meaning alone. */
const SEVERITY_TEXT: Record<NotificationFeedSeverity, string> = {
  CRITICAL: 'text-brand-critical',
  WARNING: 'text-brand-caution',
  SUCCESS: 'text-brand-positive',
  INFO: 'text-brand-info',
};

const FEED_KEY = ['notifications', 'feed', 'organizer'] as const;

/** How many rows a subject shows before "Show N more". Problems that stand are never cut. */
const FIRST_ROWS = 5;

const RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-focus focus-visible:ring-offset-2 focus-visible:ring-offset-brand-surface';

const TEXT_BUTTON = `min-h-6 rounded-sm text-brand-meta font-semibold text-brand-ink underline-offset-4 hover:underline ${RING}`;

export default function NotificationsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [filter, setFilter] = useState<FeedFilter>('all');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: FEED_KEY,
    // ORGANIZER only. Reported from QA: this list showed the operator's own ticket
    // purchases, because the inbox was keyed on user id alone and one person holds both
    // roles. Their bookings belong on the customer site, where they made them.
    queryFn: () => api.notifications.feed('ORGANIZER'),
    /*
      Re-read on return. An organizer who went off to map a seat class comes back here to see
      whether it worked, and a cached "still blocked" would say it did not.
    */
    refetchOnWindowFocus: true,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['notifications'] });

  /*
    One row can fold many stored notifications, so marking it read marks all of its unread
    ones. A row of one uses the single endpoint the bell already uses.
  */
  const markGroup = useMutation({
    mutationFn: async (g: NotificationFeedGroup) => {
      if (g.unreadIds.length === 1) await api.notifications.markRead(g.unreadIds[0]);
      else await api.notifications.markManyRead(g.unreadIds);
    },
    onSuccess: invalidate,
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });
  const markAll = useMutation({
    // The organizer stream only: an owner clearing this must not silence their own ticket
    // confirmations on the customer site.
    mutationFn: () => api.notifications.markAllRead('ORGANIZER'),
    onSuccess: () => {
      toast.push('All caught up.', 'success');
      invalidate();
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const unread = data?.unreadCount ?? 0;

  return (
    <div>
      <PageHeader
        title="Notifications"
        description="What needs your action comes first. Repeated alerts about the same problem are shown once."
        action={
          unread > 0 ? (
            <Button
              variant="outline"
              size="sm"
              loading={markAll.isPending}
              onClick={() => markAll.mutate()}
            >
              Mark all read
            </Button>
          ) : undefined
        }
      />

      {isError ? (
        <ErrorState
          message="We could not load your notifications. Please try again."
          onRetry={() => refetch()}
        />
      ) : isLoading || !data ? (
        <div
          role="status"
          aria-busy="true"
          aria-label="Loading notifications"
          className="overflow-hidden rounded-brand-card border border-brand-line bg-brand-surface"
        >
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex gap-3 border-b border-brand-line p-4 last:border-b-0">
              <div className="h-5 w-5 rounded-full bg-brand-sunken motion-safe:animate-pulse" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-1/3 rounded bg-brand-sunken motion-safe:animate-pulse" />
                <div className="h-3 w-2/3 rounded bg-brand-sunken motion-safe:animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      ) : data.sections.length === 0 ? (
        <EmptyInbox
          title="No notifications yet"
          hint="Problems that stop ticket sales, event approvals and payouts will show up here."
        />
      ) : (
        <Feed
          feed={data}
          filter={filter}
          onFilter={setFilter}
          busyKey={markGroup.isPending ? markGroup.variables?.key : undefined}
          onMarkRead={(g) => markGroup.mutate(g)}
        />
      )}
    </div>
  );
}

function EmptyInbox({ title, hint, action }: { title: string; hint: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-brand-card border border-brand-line bg-brand-surface px-6 py-10 sm:items-center sm:text-center">
      <Bell className="h-6 w-6 text-brand-ink-3" aria-hidden />
      <p className="text-brand-body font-semibold text-brand-ink">{title}</p>
      <p className="max-w-prose text-brand-ui text-brand-ink-2">{hint}</p>
      {action}
    </div>
  );
}

function Feed({
  feed,
  filter,
  onFilter,
  busyKey,
  onMarkRead,
}: {
  feed: NotificationFeed;
  filter: FeedFilter;
  onFilter: (f: FeedFilter) => void;
  busyKey: string | undefined;
  onMarkRead: (g: NotificationFeedGroup) => void;
}) {
  const all = useMemo(() => feed.sections.flatMap((s) => s.groups), [feed]);
  const chips: { key: FeedFilter; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: all.length },
    { key: 'unread', label: 'Unread', count: all.filter((g) => !g.read).length },
    ...feed.sections.map((s) => ({
      key: s.category as FeedFilter,
      label: s.label,
      count: s.groups.length,
    })),
  ];
  const sections = filterFeed(feed.sections, filter);
  const label = chips.find((c) => c.key === filter)?.label ?? 'All';

  return (
    <div className="flex flex-col gap-4">
      {/*
        Filters as toggle buttons (`aria-pressed`), the console's chip pattern. They scroll
        sideways on a phone rather than wrapping into three rows.
      */}
      <div
        role="group"
        aria-label="Show notifications"
        className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] md:mx-0 md:flex-wrap md:px-0"
      >
        {chips.map((c) => {
          const on = c.key === filter;
          return (
            <button
              key={c.key}
              type="button"
              aria-pressed={on}
              onClick={() => onFilter(c.key)}
              className={`inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-3.5 text-brand-ui transition-colors duration-150 ${RING} focus-visible:ring-offset-brand-canvas ${
                on
                  ? 'border-brand-ink bg-brand-ink font-semibold text-brand-canvas'
                  : 'border-brand-line bg-brand-surface text-brand-ink-2 hover:border-brand-line-strong hover:text-brand-ink'
              }`}
            >
              {c.label}
              <span className={`tabular-nums ${on ? 'text-brand-canvas' : 'text-brand-ink-3'}`}>
                {c.count}
              </span>
            </button>
          );
        })}
      </div>

      {sections.length === 0 ? (
        <EmptyInbox
          title={filter === 'unread' ? 'You are up to date' : `Nothing in ${label}`}
          hint={
            filter === 'unread'
              ? 'Every notification has been read. Problems that are still open stay listed under All.'
              : 'Nothing has arrived in this group yet.'
          }
          action={
            <button
              type="button"
              onClick={() => onFilter('all')}
              className={`mt-2 ${brandButtonClasses('secondary', 'sm')}`}
            >
              Show all notifications
            </button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-brand-card border border-brand-line bg-brand-surface">
          {sections.map((s, i) => (
            <Section
              key={s.category}
              id={`section-${s.category}`}
              label={s.label}
              groups={s.groups}
              // "Unread" means unread: there are no read rows waiting behind a button there.
              foldRead={filter !== 'unread'}
              first={i === 0}
              busyKey={busyKey}
              onMarkRead={onMarkRead}
            />
          ))}
        </div>
      )}
      {feed.truncated && (
        <p className="text-brand-meta text-brand-ink-3">
          Showing your most recent {feed.scanned} notifications.
        </p>
      )}
    </div>
  );
}

function Section({
  id,
  label,
  groups,
  foldRead,
  first,
  busyKey,
  onMarkRead,
}: {
  id: string;
  label: string;
  groups: NotificationFeedGroup[];
  foldRead: boolean;
  first: boolean;
  busyKey: string | undefined;
  onMarkRead: (g: NotificationFeedGroup) => void;
}) {
  const [showRead, setShowRead] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const split = splitByAttention(groups);
  const shown = foldRead ? split.shown : groups;
  const earlier = foldRead ? split.earlier : [];
  const open = showRead ? [...shown, ...earlier] : shown;
  // A problem that still stands is never cut by the row limit: the limit applies after them.
  const limit = Math.max(FIRST_ROWS, open.filter(isStandingProblem).length);
  const visible = showAll ? open : open.slice(0, limit);
  const more = open.length - visible.length;
  const unreadHere = groups.filter((g) => !g.read).length;

  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={`scroll-mt-6 ${first ? '' : 'border-t border-brand-line'}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-brand-line bg-brand-sunken px-4 py-2.5 md:px-6">
        <h2 id={`${id}-title`} className="text-brand-eyebrow uppercase text-brand-ink-2">
          {label}
        </h2>
        <p className="text-brand-meta tabular-nums text-brand-ink-2">
          {groups.length} {groups.length === 1 ? 'item' : 'items'}
          {unreadHere > 0 ? `, ${unreadHere} unread` : ', all read'}
        </p>
      </div>
      {visible.length > 0 && (
        <ul>
          {visible.map((g) => (
            <li key={g.key} className="border-t border-brand-line first:border-t-0">
              <Row group={g} busy={busyKey === g.key} onMarkRead={() => onMarkRead(g)} />
            </li>
          ))}
        </ul>
      )}
      {(more > 0 || (earlier.length > 0 && !showRead) || visible.length === 0) && (
        <div
          className={`flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 md:px-6 ${visible.length > 0 ? 'border-t border-brand-line' : ''}`}
        >
          {visible.length === 0 && (
            <p className="text-brand-meta text-brand-ink-2">Everything here has been read.</p>
          )}
          {more > 0 && (
            <button type="button" onClick={() => setShowAll(true)} className={TEXT_BUTTON}>
              Show {more} more
            </button>
          )}
          {earlier.length > 0 && !showRead && (
            <button type="button" onClick={() => setShowRead(true)} className={TEXT_BUTTON}>
              Show {earlier.length} read {earlier.length === 1 ? 'item' : 'items'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function Row({
  group: g,
  busy,
  onMarkRead,
}: {
  group: NotificationFeedGroup;
  busy: boolean;
  onMarkRead: () => void;
}) {
  const [open, setOpen] = useState(false);
  const severity = severityView(g);
  const Icon = SEVERITY_ICON[g.severity];
  const affected = affectedLabel(g.affectedSessions);
  const hasMore = g.sessions.length > 0 || Boolean(g.detail);
  const detailId = useId();
  const repeats = g.notificationIds.length;

  return (
    <article className="flex gap-3 px-4 py-4 md:gap-4 md:px-6">
      <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${SEVERITY_TEXT[g.severity]}`} aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <h3
            className={`min-w-0 break-words text-brand-ui text-brand-ink ${g.read ? 'font-medium' : 'font-semibold'}`}
          >
            {!g.read && (
              // Unread: a dot before the title, a heavier title, and "New" for assistive tech.
              <>
                <span
                  aria-hidden
                  className="mr-2 inline-block h-2 w-2 rounded-full bg-brand-ink align-middle"
                />
                <span className="sr-only">New: </span>
              </>
            )}
            {g.title}
          </h3>
          <time
            dateTime={g.lastAt}
            title={recordedAt(g.lastAt)}
            className="shrink-0 whitespace-nowrap text-brand-meta text-brand-ink-3"
          >
            {relativeTime(g.lastAt)}
          </time>
        </div>
        <p className="max-w-prose break-words text-brand-meta text-brand-ink-2">{g.summary}</p>
        {g.ownerNote && (
          <p className="max-w-prose text-brand-meta text-brand-ink-2">{g.ownerNote}</p>
        )}
        <p className="flex flex-wrap items-center gap-x-2 text-brand-meta text-brand-ink-3">
          <span className={`font-semibold ${SEVERITY_TEXT[g.severity]}`}>{severity.label}</span>
          {affected && (
            <>
              <span aria-hidden>|</span>
              <span>{affected}</span>
            </>
          )}
          {repeats > 1 && g.sessions.length === 0 && (
            <>
              <span aria-hidden>|</span>
              <span>Sent {repeats} times, shown once</span>
            </>
          )}
        </p>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          {g.action && (
            <Link
              href={g.action.href}
              className={brandButtonClasses(isStandingProblem(g) ? 'primary' : 'secondary', 'sm')}
            >
              {g.action.label}
            </Link>
          )}
          {hasMore && (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={detailId}
              onClick={() => setOpen((v) => !v)}
              className={brandButtonClasses('quiet', 'sm')}
            >
              <ChevronDown
                className={`h-4 w-4 transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
                aria-hidden
              />
              {open ? 'Hide details' : affected ? `Show ${affected}` : 'Show details'}
            </button>
          )}
          {!g.read && (
            <button
              type="button"
              disabled={busy}
              onClick={onMarkRead}
              className={`${brandButtonClasses('quiet', 'sm')} disabled:opacity-50`}
            >
              {g.dismissible ? 'Dismiss' : 'Mark read'}
            </button>
          )}
        </div>

        {open && hasMore && (
          <div id={detailId} className="mt-3 space-y-4 border-t border-brand-line pt-3">
            {g.sessions.length > 0 && (
              <div>
                <h4 className="text-brand-meta font-semibold text-brand-ink">Affected showtimes</h4>
                <ul className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-brand-meta tabular-nums text-brand-ink-2 sm:grid-cols-2 xl:grid-cols-3">
                  {g.sessions.map((s) => {
                    const zone = s.timeZone ? zoneAbbrev(s.startsAt, s.timeZone) : '';
                    return (
                      <li key={s.id}>
                        <time dateTime={s.startsAt}>
                          {timeAtVenue(s.startsAt, s.timeZone ?? null)}
                          {zone ? ` ${zone}` : ''}
                        </time>
                      </li>
                    );
                  })}
                </ul>
                {g.affectedSessions > g.sessions.length && (
                  <p className="mt-2 text-brand-meta text-brand-ink-3">
                    And {g.affectedSessions - g.sessions.length} more.
                  </p>
                )}
              </div>
            )}
            {g.detail && (
              <div>
                <h4 className="text-brand-meta font-semibold text-brand-ink">Technical detail</h4>
                <p className="mt-1 break-words text-brand-meta text-brand-ink-2">{g.detail}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
