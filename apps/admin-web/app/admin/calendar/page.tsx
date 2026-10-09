'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, ExternalLink, TriangleAlert } from 'lucide-react';
import {
  api,
  Badge,
  Button,
  ButtonLink,
  Card,
  Drawer,
  EmptyState,
  ErrorState,
  PageHeader,
  Select,
  Skeleton,
  StatusBadge,
  enumLabel,
  useAuthUser,
  type AdminCalendarSession,
} from '@eticketsgo/web-kit';
import { CountryFilter } from '@/components/country-filter';
import { OrganizerPicker, useUrlFilters } from '@/components/list-filters';
import {
  CALENDAR_VIEWS,
  WEEKDAY_HEADINGS,
  cityOptions,
  dayLabel,
  fetchWindow,
  inCity,
  localDay,
  localTime,
  parseDay,
  parseView,
  placeSessions,
  rangeLabel,
  shiftAnchor,
  todayIn,
  viewDays,
  zoneNote,
  zoneUnknown,
  type CalendarView,
} from '@/lib/calendar';

/**
 * Every show on the platform, across organizers, on a calendar.
 *
 * ── WHAT IT IS FOR ─────────────────────────────────────────────────────────────────
 * The moderation queue answers "what is waiting for a decision"; it cannot answer "what is on
 * this weekend in Hyderabad", "is this organizer's run actually scheduled", or "what is about to
 * start that is still a draft". Those are questions about dates, and a list sorted by the last
 * edit cannot answer them.
 *
 * ── TIMES ARE THE VENUE'S ──────────────────────────────────────────────────────────
 * Each session is placed on the day, and shown at the time, on the clock at its own venue, with
 * the zone named beside it - see `lib/calendar.ts`. The grid is not in the admin's zone, because
 * an admin answering an organizer's question about "the Saturday show" needs Saturday to mean
 * what it means to them.
 *
 * ── WHAT IT READS ──────────────────────────────────────────────────────────────────
 * `GET /admin/events/calendar`, a read-only projection under the same EVENT_REVIEW duty as the
 * moderation queue, carrying no buyer and no money. The filters live in the URL so a view can be
 * sent to a colleague; the city is chosen from the cities in the window, because a free-text city
 * box that matched nothing would read as "no shows".
 */

const KEYS = ['view', 'date', 'country', 'organizationId', 'status', 'city'] as const;

const EVENT_STATUSES = [
  'DRAFT',
  'UNDER_REVIEW',
  'PUBLISHED',
  'PAUSED',
  'SOLD_OUT',
  'CANCELLED',
  'COMPLETED',
  'ARCHIVED',
];

const VIEW_LABELS: Record<CalendarView, string> = {
  month: 'Month',
  week: 'Week',
  agenda: 'Agenda',
};

/** A non-published event is named as such on the chip, in words, not only by colour. */
function statusSuffix(status: string): string {
  return status === 'PUBLISHED' ? '' : ` - ${enumLabel(status)}`;
}

function SessionChip({
  s,
  onOpen,
  compact = false,
}: {
  s: AdminCalendarSession;
  onOpen: (s: AdminCalendarSession) => void;
  compact?: boolean;
}) {
  const published = s.event.status === 'PUBLISHED';
  return (
    <button
      type="button"
      onClick={() => onOpen(s)}
      data-session={s.id}
      className={`block w-full min-w-0 rounded-md border-l-2 px-2 py-1 text-left text-caption transition-colors hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
        published
          ? 'border-action-primary bg-tint-primary'
          : 'border-status-warning bg-background-subtle'
      }`}
    >
      {/*
        The status sits on the time line, not after the title: a long title is clamped, and a
        "(Draft)" clamped off the end is a status nobody can read.
      */}
      <span className="block truncate">
        <span className="font-semibold tabular-nums text-text-primary">
          {localTime(s.startsAt, s.timezone)}
        </span>
        {!published && (
          <span className="font-medium text-text-secondary">{statusSuffix(s.event.status)}</span>
        )}
      </span>
      <span
        className={`block text-text-primary ${compact ? 'line-clamp-1' : 'line-clamp-2'} break-words`}
      >
        {s.event.title}
      </span>
      {!compact && (
        <span className="block truncate text-text-secondary">
          {s.organization.name} - {s.venue.city}
        </span>
      )}
    </button>
  );
}

/** A day as a list: the agenda, and every view on a narrow screen. */
function DayList({
  day,
  sessions,
  today,
  onOpen,
  showEmpty,
}: {
  day: string;
  sessions: AdminCalendarSession[];
  today: string;
  onOpen: (s: AdminCalendarSession) => void;
  showEmpty: boolean;
}) {
  if (!showEmpty && sessions.length === 0) return null;
  return (
    <li className="border-b border-border py-3 last:border-b-0">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-text-primary">
        {dayLabel(day)}
        {day === today && <Badge tone="info">Today</Badge>}
      </h3>
      {sessions.length === 0 ? (
        <p className="text-caption text-text-muted">No shows</p>
      ) : (
        <ul className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
          {sessions.map((s) => (
            <li key={s.id}>
              <SessionChip s={s} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

const MONTH_CELL_LIMIT = 3;

function MonthGrid({
  days,
  byDay,
  month,
  today,
  onOpen,
  onShowDay,
}: {
  days: string[];
  byDay: Record<string, AdminCalendarSession[]>;
  month: string;
  today: string;
  onOpen: (s: AdminCalendarSession) => void;
  onShowDay: (day: string) => void;
}) {
  return (
    <div
      role="table"
      aria-label="Month"
      className="overflow-hidden rounded-md border border-border"
    >
      <div role="row" className="grid grid-cols-7 border-b border-border bg-background-subtle">
        {WEEKDAY_HEADINGS.map((w) => (
          <div
            key={w}
            role="columnheader"
            className="px-2 py-1.5 text-caption font-semibold uppercase tracking-wide text-text-muted"
          >
            {w}
          </div>
        ))}
      </div>
      {Array.from({ length: days.length / 7 }, (_, row) => (
        <div role="row" key={row} className="grid grid-cols-7">
          {days.slice(row * 7, row * 7 + 7).map((day) => {
            const list = byDay[day] ?? [];
            const inMonth = day.slice(0, 7) === month;
            const extra = list.length - MONTH_CELL_LIMIT;
            return (
              <div
                key={day}
                role="cell"
                aria-label={`${dayLabel(day)}, ${list.length} ${list.length === 1 ? 'show' : 'shows'}`}
                className={`min-h-[7.5rem] min-w-0 space-y-1 border-b border-r border-border p-1.5 [&:nth-child(7n)]:border-r-0 ${
                  inMonth ? 'bg-background-surface' : 'bg-background-canvas'
                }`}
              >
                <p
                  className={`text-caption font-semibold ${
                    day === today
                      ? 'inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded-full bg-action-primary px-1.5 text-action-primary-foreground'
                      : inMonth
                        ? 'text-text-primary'
                        : 'text-text-muted'
                  }`}
                >
                  {Number(day.slice(8, 10))}
                  {day === today && <span className="sr-only"> (today)</span>}
                </p>
                {list.slice(0, MONTH_CELL_LIMIT).map((s) => (
                  <SessionChip key={s.id} s={s} onOpen={onOpen} compact />
                ))}
                {extra > 0 && (
                  <button
                    type="button"
                    onClick={() => onShowDay(day)}
                    aria-label={`Show all ${list.length} shows on ${dayLabel(day)}`}
                    className="w-full rounded px-1 text-left text-caption font-medium text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    +{extra} more
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function WeekColumns({
  days,
  byDay,
  today,
  onOpen,
}: {
  days: string[];
  byDay: Record<string, AdminCalendarSession[]>;
  today: string;
  onOpen: (s: AdminCalendarSession) => void;
}) {
  return (
    <div className="grid grid-cols-7 gap-2">
      {days.map((day) => {
        const list = byDay[day] ?? [];
        return (
          <section key={day} aria-label={dayLabel(day)} className="min-w-0">
            <h3
              className={`mb-2 rounded-md px-2 py-1 text-caption font-semibold ${
                day === today ? 'bg-tint-primary text-action-primary' : 'text-text-secondary'
              }`}
            >
              {dayLabel(day)}
              {day === today && <span className="sr-only"> (today)</span>}
            </h3>
            {list.length === 0 ? (
              <p className="px-2 text-caption text-text-muted">No shows</p>
            ) : (
              <ul className="space-y-1.5">
                {list.map((s) => (
                  <li key={s.id}>
                    <SessionChip s={s} onOpen={onOpen} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function Preview({ s }: { s: AdminCalendarSession }) {
  const openRef = useRef<HTMLDivElement>(null);
  // The drawer does not move focus itself; land on the first action so a keyboard user is in it.
  useEffect(() => {
    const t = setTimeout(() => openRef.current?.querySelector<HTMLElement>('a')?.focus(), 50);
    return () => clearTimeout(t);
  }, [s.id]);
  const unknown = zoneUnknown(s.timezone);
  return (
    <div className="space-y-5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={s.event.status} />
        {s.status !== 'SCHEDULED' && (
          <Badge tone={s.status === 'CANCELLED' ? 'error' : 'neutral'}>
            Show {enumLabel(s.status).toLowerCase()}
          </Badge>
        )}
      </div>
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2">
        <dt className="text-text-muted">When</dt>
        <dd className="text-text-primary">
          {/* The venue's day, not the reader's. */}
          {dayLabel(localDay(s.startsAt, s.timezone) ?? s.startsAt.slice(0, 10))},{' '}
          {localTime(s.startsAt, s.timezone)} to {localTime(s.endsAt, s.timezone)}{' '}
          <span className="text-text-muted">({zoneNote(s.startsAt, s.timezone)})</span>
          {unknown && (
            <span className="mt-1 block text-caption text-status-warning">
              This venue has no time zone recorded, so the time is shown in UTC.
            </span>
          )}
        </dd>
        <dt className="text-text-muted">Venue</dt>
        <dd className="text-text-primary">
          {s.venue.name}, {s.venue.city}
          {s.venue.country ? `, ${s.venue.country}` : ''}
        </dd>
        {s.room && (
          <>
            <dt className="text-text-muted">Room</dt>
            <dd className="text-text-primary">{s.room}</dd>
          </>
        )}
        <dt className="text-text-muted">Organizer</dt>
        <dd className="text-text-primary">{s.organization.name}</dd>
        <dt className="text-text-muted">Category</dt>
        <dd className="text-text-primary">{s.event.category}</dd>
      </dl>
      <div ref={openRef} className="flex flex-wrap gap-2">
        <ButtonLink href={`/admin/events/${s.event.id}`} size="sm">
          Open event <ExternalLink className="h-3.5 w-3.5" aria-hidden />
        </ButtonLink>
        <ButtonLink href={`/admin/organizers/${s.organization.id}`} size="sm" variant="outline">
          Open organizer
        </ButtonLink>
      </div>
    </div>
  );
}

export default function AdminCalendarPage() {
  const { user, isLoading: userLoading } = useAuthUser();
  const mayRead = (user?.adminPermissions ?? []).includes('EVENT_REVIEW');

  const filters = useUrlFilters(KEYS);
  const v = filters.values;
  const view = parseView(v.view);
  // Opens on today in the reader's own zone. Fixed for the life of the page.
  const [today] = useState(() => todayIn(new Date()));
  const anchor = parseDay(v.date) ?? today;
  const days = useMemo(() => viewDays(view, anchor), [view, anchor]);
  const range = fetchWindow(days);

  const query = useQuery({
    queryKey: ['admin', 'calendar', range.from, range.to, v.country, v.organizationId, v.status],
    enabled: mayRead,
    queryFn: () =>
      api.admin.eventCalendar({
        ...range,
        country: v.country || undefined,
        organizationId: v.organizationId || undefined,
        status: v.status || undefined,
      }),
    placeholderData: (prev) => prev,
  });

  const all = useMemo(() => query.data?.data ?? [], [query.data]);
  const cities = useMemo(() => cityOptions(all), [all]);
  const shown = useMemo(() => inCity(all, v.city), [all, v.city]);
  const { byDay } = useMemo(() => placeSessions(shown, days), [shown, days]);
  const visibleCount = days.reduce((n, d) => n + (byDay[d]?.length ?? 0), 0);
  const anyUnknownZone = shown.some((s) => zoneUnknown(s.timezone));

  const [selected, setSelected] = useState<AdminCalendarSession | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const open = (s: AdminCalendarSession) => {
    trigger.current = document.activeElement as HTMLElement | null;
    setSelected(s);
  };
  const close = () => {
    setSelected(null);
    // Back to the chip that opened it.
    setTimeout(() => trigger.current?.focus(), 0);
  };

  const go = (patch: { view?: CalendarView; date?: string }) =>
    filters.set({
      view: patch.view ?? v.view,
      date: patch.date ?? v.date,
    });

  if (!userLoading && !mayRead) {
    return (
      <div className="space-y-6">
        <PageHeader title="Calendar" />
        <Card>
          <p className="text-sm text-text-secondary">
            The calendar shows every event on the platform, which is part of the event review duty.
            Your account does not have that duty. Ask a super admin if your job needs it.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Calendar"
        description="Every show across organizers, on the clock at its own venue."
        action={
          <ButtonLink href="/admin/events" variant="outline" size="sm">
            Approval queue
          </ButtonLink>
        }
      />

      <Card>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <OrganizerPicker
            value={v.organizationId || undefined}
            onChange={(id) => filters.set({ organizationId: id })}
          />
          <Select
            label="Event status"
            value={v.status}
            onChange={(e) => filters.set({ status: e.target.value || undefined })}
          >
            <option value="">Every status</option>
            {EVENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {enumLabel(s)}
              </option>
            ))}
          </Select>
          <div>
            <CountryFilter
              label="Market"
              value={v.country || undefined}
              onChange={(code) => filters.set({ country: code, city: undefined })}
            />
            <p className="mt-1.5 text-caption text-text-muted">The country the venue is in.</p>
          </div>
          <div>
            <Select
              label="City"
              value={v.city}
              onChange={(e) => filters.set({ city: e.target.value || undefined })}
              disabled={cities.length === 0 && !v.city}
            >
              <option value="">Every city</option>
              {v.city && !cities.some((c) => c.value === v.city) && (
                <option value={v.city}>{v.city}</option>
              )}
              {cities.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
            <p className="mt-1.5 text-caption text-text-muted">Cities with shows in this period.</p>
          </div>
        </div>
        {(v.country || v.organizationId || v.status || v.city) && (
          <div className="mt-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                filters.set({
                  country: undefined,
                  organizationId: undefined,
                  status: undefined,
                  city: undefined,
                })
              }
            >
              Clear filters
            </Button>
          </div>
        )}
      </Card>

      <Card>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              aria-label="Previous"
              onClick={() => go({ date: shiftAnchor(view, anchor, -1) })}
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </Button>
            <Button variant="outline" size="sm" onClick={() => go({ date: today })}>
              Today
            </Button>
            <Button
              variant="outline"
              size="sm"
              aria-label="Next"
              onClick={() => go({ date: shiftAnchor(view, anchor, 1) })}
            >
              <ChevronRight className="h-4 w-4" aria-hidden />
            </Button>
            <h2 className="ml-1 text-title font-semibold text-text-primary" aria-live="polite">
              {rangeLabel(view, anchor, days)}
            </h2>
          </div>
          <div
            role="group"
            aria-label="View"
            className="flex items-center gap-0.5 rounded-md border border-border p-0.5"
          >
            {CALENDAR_VIEWS.map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={view === key}
                onClick={() => go({ view: key })}
                className={`rounded px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                  view === key
                    ? 'bg-tint-primary text-action-primary'
                    : 'text-text-secondary hover:bg-background-subtle hover:text-text-primary'
                }`}
              >
                {VIEW_LABELS[key]}
              </button>
            ))}
          </div>
        </div>

        <div
          className="mb-3 flex flex-wrap items-center gap-2 text-caption text-text-muted"
          role="status"
        >
          {query.data && (
            <span>
              {visibleCount} {visibleCount === 1 ? 'show' : 'shows'} in this period
              {query.isFetching ? ', updating' : ''}.
            </span>
          )}
          <span>Times are local to each venue.</span>
        </div>

        {query.data?.meta.truncated && (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-status-warning bg-tint-warning px-3 py-2 text-sm text-text-primary">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-status-warning" aria-hidden />
            <p>
              There are more than {query.data.meta.limit} shows in this period, so the latest ones
              are not shown. Choose an organizer, market or status to narrow it.
            </p>
          </div>
        )}
        {anyUnknownZone && (
          <p className="mb-3 text-caption text-status-warning">
            Some venues have no time zone recorded. Their shows are placed and timed in UTC, and say
            so when opened.
          </p>
        )}

        {query.isError ? (
          <ErrorState
            message="We could not load the calendar. Please try again."
            onRetry={() => query.refetch()}
          />
        ) : !query.data ? (
          <Skeleton className="h-96 w-full" />
        ) : view === 'agenda' ? (
          visibleCount === 0 ? (
            <EmptyState
              title="No shows in these two weeks"
              hint="Move to another period, or clear the filters."
            />
          ) : (
            <ul>
              {days.map((d) => (
                <DayList
                  key={d}
                  day={d}
                  sessions={byDay[d]}
                  today={today}
                  onOpen={open}
                  showEmpty={false}
                />
              ))}
            </ul>
          )
        ) : (
          <>
            {/*
              A seven-column grid needs room. Below `lg` (month) or `xl` (week) each column would
              be narrower than a show's title, so the same days are listed instead - same data,
              same order, nothing hidden.
            */}
            <div className={view === 'month' ? 'hidden lg:block' : 'hidden xl:block'}>
              {view === 'month' ? (
                <MonthGrid
                  days={days}
                  byDay={byDay}
                  month={anchor.slice(0, 7)}
                  today={today}
                  onOpen={open}
                  onShowDay={(day) => go({ view: 'agenda', date: day })}
                />
              ) : (
                <WeekColumns days={days} byDay={byDay} today={today} onOpen={open} />
              )}
            </div>
            <div className={view === 'month' ? 'lg:hidden' : 'xl:hidden'}>
              {visibleCount === 0 ? (
                <EmptyState
                  title={view === 'month' ? 'No shows this month' : 'No shows this week'}
                  hint="Move to another period, or clear the filters."
                />
              ) : (
                <ul>
                  {days.map((d) => (
                    <DayList
                      key={d}
                      day={d}
                      sessions={byDay[d]}
                      today={today}
                      onOpen={open}
                      showEmpty={view === 'week'}
                    />
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </Card>

      <Drawer open={selected !== null} onClose={close} title={selected?.event.title ?? 'Show'}>
        {selected && <Preview s={selected} />}
      </Drawer>
    </div>
  );
}
