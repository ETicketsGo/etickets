'use client';

import { useState } from 'react';
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
  Badge,
  Button,
  ButtonLink,
  Card,
  Skeleton,
  ErrorState,
  EmptyState,
  PageHeader,
  dateTime,
  zoneAbbrev,
  useToast,
  errorMessage,
  type NotificationFeed,
  type NotificationFeedGroup,
  type NotificationFeedSeverity,
} from '@eticketsgo/web-kit';
import {
  affectedLabel,
  relativeTime,
  severityView,
  splitByAttention,
} from '@/lib/notification-feed-view';

/**
 * The organizer's notification centre.
 *
 * ── WHY IT IS GROUPED ──────────────────────────────────────────────────────────────
 * This page used to print one row per stored notification. One seating fault on a film was
 * reported once per showtime, so the page showed the same full sentence dozens of times, and
 * the organizer had to read them all to learn that they were one problem with one fix.
 *
 * The server now folds notifications by root cause - same kind, same event, same fault - and
 * says whether the fault is still there. This page lays the result out: what needs action
 * first, then everything else by subject, one card per cause, with the affected showtimes and
 * the technical detail one click away. Nothing stored is changed by any of it.
 */

const SEVERITY_ICON: Record<NotificationFeedSeverity, LucideIcon> = {
  CRITICAL: OctagonAlert,
  WARNING: AlertTriangle,
  SUCCESS: CheckCircle2,
  INFO: Info,
};

const FEED_KEY = ['notifications', 'feed', 'organizer'] as const;

export default function NotificationsPage() {
  const qc = useQueryClient();
  const toast = useToast();

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
    One card can fold many stored notifications, so marking it read marks all of its unread
    ones. A card of one uses the single endpoint the bell already uses.
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
    <div className="space-y-6">
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
        <div className="space-y-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : data.sections.length === 0 ? (
        <Card>
          <EmptyState
            icon={Bell}
            title="No notifications yet"
            hint="Problems that stop ticket sales, event approvals and payouts will show up here."
          />
        </Card>
      ) : (
        <Feed
          feed={data}
          busyKey={markGroup.isPending ? markGroup.variables?.key : undefined}
          onMarkRead={(g) => markGroup.mutate(g)}
        />
      )}
    </div>
  );
}

function Feed({
  feed,
  busyKey,
  onMarkRead,
}: {
  feed: NotificationFeed;
  busyKey: string | undefined;
  onMarkRead: (g: NotificationFeedGroup) => void;
}) {
  return (
    /*
      On a wide screen the section list sits beside the cards, so an organizer with a long
      feed can see at a glance how much is in each and jump to it. On a phone it would only
      push the first card off the screen, so it is not shown there.
    */
    <div className="lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-8">
      <nav aria-label="Notification sections" className="hidden lg:block">
        <ul className="sticky top-6 space-y-1">
          {feed.sections.map((s) => {
            const open = splitByAttention(s.groups).shown.length;
            return (
              <li key={s.category}>
                <a
                  href={`#section-${s.category}`}
                  className="flex items-center justify-between rounded-md px-3 py-2 text-sm text-text-secondary hover:bg-background-subtle hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <span>{s.label}</span>
                  {open > 0 && (
                    <span
                      className={`rounded-full px-2 py-0.5 text-caption font-medium ${
                        s.category === 'ACTION_REQUIRED'
                          ? 'bg-tint-error text-status-error'
                          : 'bg-background-subtle text-text-secondary'
                      }`}
                    >
                      {open}
                    </span>
                  )}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="min-w-0 space-y-8">
        {feed.sections.map((s) => (
          <Section
            key={s.category}
            id={`section-${s.category}`}
            label={s.label}
            groups={s.groups}
            busyKey={busyKey}
            onMarkRead={onMarkRead}
          />
        ))}
        {feed.truncated && (
          <p className="text-caption text-text-muted">
            Showing your most recent {feed.scanned} notifications.
          </p>
        )}
      </div>
    </div>
  );
}

function Section({
  id,
  label,
  groups,
  busyKey,
  onMarkRead,
}: {
  id: string;
  label: string;
  groups: NotificationFeedGroup[];
  busyKey: string | undefined;
  onMarkRead: (g: NotificationFeedGroup) => void;
}) {
  const [showEarlier, setShowEarlier] = useState(false);
  const { shown, earlier } = splitByAttention(groups);
  const visible = showEarlier ? [...shown, ...earlier] : shown;

  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-6 space-y-3">
      <h2 id={`${id}-title`} className="text-title font-semibold text-text-primary">
        {label}
      </h2>
      {visible.length === 0 && <p className="text-sm text-text-secondary">Nothing new here.</p>}
      <ul className="space-y-3">
        {visible.map((g) => (
          <li key={g.key}>
            <GroupCard group={g} busy={busyKey === g.key} onMarkRead={() => onMarkRead(g)} />
          </li>
        ))}
      </ul>
      {earlier.length > 0 && (
        <button
          type="button"
          onClick={() => setShowEarlier((v) => !v)}
          aria-expanded={showEarlier}
          className="rounded text-sm font-medium text-action-primary underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {showEarlier ? 'Hide earlier' : `Show earlier (${earlier.length})`}
        </button>
      )}
    </section>
  );
}

function GroupCard({
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
  const detailId = `detail-${g.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const repeats = g.notificationIds.length;

  return (
    <article
      className={`rounded-lg border border-l-4 border-border bg-background-surface p-4 shadow-sm sm:p-5 ${severity.accent} ${
        g.read ? '' : 'ring-1 ring-action-primary/20'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={severity.tone}>
          <Icon className="h-3.5 w-3.5" aria-hidden />
          {severity.label}
        </Badge>
        {!g.read && (
          <span className="inline-flex items-center gap-1.5 text-caption font-medium text-action-primary">
            <span aria-hidden className="h-2 w-2 rounded-full bg-action-primary" />
            New
          </span>
        )}
        <time
          dateTime={g.lastAt}
          title={dateTime(g.lastAt)}
          className="ml-auto text-caption text-text-muted"
        >
          {relativeTime(g.lastAt)}
        </time>
      </div>

      <h3 className="mt-2 font-semibold text-text-primary">{g.title}</h3>
      <p className="mt-1 break-words text-[0.9375rem] text-text-secondary">{g.summary}</p>
      {g.ownerNote && <p className="mt-2 text-sm text-text-secondary">{g.ownerNote}</p>}
      {repeats > 1 && g.sessions.length === 0 && (
        <p className="mt-1 text-caption text-text-muted">
          We sent this {repeats} times. It is shown once.
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {g.action && (
          <ButtonLink href={g.action.href} size="sm">
            {g.action.label}
          </ButtonLink>
        )}
        {hasMore && (
          <Button
            variant="outline"
            size="sm"
            aria-expanded={open}
            aria-controls={detailId}
            onClick={() => setOpen((v) => !v)}
          >
            <ChevronDown
              className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`}
              aria-hidden
            />
            {open ? 'Hide details' : affected ? `Show ${affected}` : 'Show details'}
          </Button>
        )}
        {!g.read && (
          <Button variant="ghost" size="sm" loading={busy} onClick={onMarkRead}>
            {g.dismissible ? 'Dismiss' : 'Mark read'}
          </Button>
        )}
      </div>

      {open && hasMore && (
        <div id={detailId} className="mt-4 space-y-4 border-t border-border pt-4">
          {g.sessions.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-text-primary">Affected showtimes</h4>
              <ul className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-sm text-text-secondary sm:grid-cols-2 xl:grid-cols-3">
                {g.sessions.map((s) => {
                  const zone = s.timeZone ? zoneAbbrev(s.startsAt, s.timeZone) : '';
                  return (
                    <li key={s.id}>
                      <time dateTime={s.startsAt}>
                        {dateTime(s.startsAt, undefined, s.timeZone ?? undefined)}
                        {zone ? ` ${zone}` : ''}
                      </time>
                    </li>
                  );
                })}
              </ul>
              {g.affectedSessions > g.sessions.length && (
                <p className="mt-2 text-caption text-text-muted">
                  And {g.affectedSessions - g.sessions.length} more.
                </p>
              )}
            </div>
          )}
          {g.detail && (
            <div>
              <h4 className="text-sm font-medium text-text-primary">Technical detail</h4>
              <p className="mt-1 break-words text-sm text-text-secondary">{g.detail}</p>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
