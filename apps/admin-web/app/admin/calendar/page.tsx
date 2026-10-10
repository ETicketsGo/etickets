'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Building2,
  CalendarClock,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  MapPin,
  SlidersHorizontal,
  Tag,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import {
  api,
  Button,
  ButtonLink,
  Card,
  Drawer,
  EmptyState,
  ErrorState,
  IconButton,
  IconTile,
  PageHeader,
  Select,
  Skeleton,
  StatusPill,
  useAuthUser,
  type AdminCalendarSession,
} from '@eticketsgo/web-kit';
import { viewerToday, viewerZoneLabel } from '@eticketsgo/shared-types';
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
  showStatus,
  statusText,
  statusTone,
  viewDays,
  zoneNote,
  zoneUnknown,
  type CalendarView,
  type StatusTone,
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
 *
 * ── HOW IT LOOKS ───────────────────────────────────────────────────────────────────
 * The same presentation as the organizer calendar: a controls card, a month grid with today
 * ringed and a dot per show in its status colour, the chosen day listed beside it with status
 * pills, and a quick look in a side drawer. Status words come from the same table in both
 * consoles (`statusText`), so "In review" reads the same to an organizer and to the admin who
 * reviews them.
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

const STEP_NAMES: Record<CalendarView, string> = {
  month: 'month',
  week: 'week',
  agenda: 'two weeks',
};

/** The dot beside a show, in its status colour. Never the only carrier: words are beside it. */
const DOT: Record<StatusTone, string> = {
  success: 'bg-status-success',
  warning: 'bg-status-warning',
  error: 'bg-status-error',
  info: 'bg-status-info',
  neutral: 'bg-text-muted',
};

function dotFor(s: AdminCalendarSession): string {
  return DOT[statusTone(showStatus(s).status)];
}

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** "7:30 PM - 10:30 PM IST", at the venue. */
function timeRange(s: AdminCalendarSession): string {
  const start = localTime(s.startsAt, s.timezone);
  const zone = zoneNote(s.startsAt, s.timezone);
  if (new Date(s.endsAt).getTime() <= new Date(s.startsAt).getTime()) return `${start} ${zone}`;
  return `${start} - ${localTime(s.endsAt, s.timezone)} ${zone}`;
}

/**
 * A show in a month cell or a week column: dot and time, the title under them. The status is
 * in words for a screen reader (and in the hover title); the day panel prints it as a pill.
 */
function MonthChip({
  s,
  onOpen,
}: {
  s: AdminCalendarSession;
  onOpen: (s: AdminCalendarSession) => void;
}) {
  const shown = showStatus(s);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(s);
      }}
      data-session={s.id}
      title={`${localTime(s.startsAt, s.timezone)} ${s.event.title}. ${shown.label}`}
      className={`block w-full min-w-0 rounded-md px-1.5 py-0.5 text-left text-micro leading-[1.125rem] text-text-primary transition-colors duration-150 hover:bg-background-subtle ${FOCUS}`}
    >
      <span className="flex items-center gap-1.5">
        <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${dotFor(s)}`} />
        <span className="truncate font-semibold tabular-nums">
          {localTime(s.startsAt, s.timezone)}
        </span>
      </span>
      <span
        className={`block truncate pl-3.5 text-text-secondary ${shown.status === 'CANCELLED' ? 'line-through' : ''}`}
      >
        {s.event.title}
      </span>
      <span className="sr-only">. {shown.label}</span>
    </button>
  );
}

/**
 * A show as a row: the day panel, the agenda, and the week on a narrow screen. The same row as
 * the organizer calendar's - dot, time, title, place, and the status in words.
 */
function SessionRow({
  s,
  onOpen,
  inset = false,
}: {
  s: AdminCalendarSession;
  onOpen: (s: AdminCalendarSession) => void;
  /** Drawn inside a padded panel rather than edge to edge in a card. */
  inset?: boolean;
}) {
  const shown = showStatus(s);
  return (
    <button
      type="button"
      onClick={() => onOpen(s)}
      // The panel repeats a show the grid already carries; only one of the two is "the" chip.
      data-session={inset ? undefined : s.id}
      className={`flex w-full flex-wrap items-start gap-x-3 gap-y-1.5 text-left transition-colors duration-150 hover:bg-background-subtle ${FOCUS} ${
        inset ? 'rounded-md px-3 py-2.5' : 'px-4 py-3 focus-visible:ring-inset'
      }`}
    >
      <span aria-hidden className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${dotFor(s)}`} />
      <span className="min-w-0 flex-1 basis-40">
        <span className="block truncate text-sm font-semibold text-text-primary">
          {s.event.title}
        </span>
        <span className="block text-caption tabular-nums text-text-secondary">{timeRange(s)}</span>
        <span className="block truncate text-caption text-text-muted">
          {s.organization.name} - {s.venue.city}
        </span>
      </span>
      <StatusPill tone={statusTone(shown.status)} size="sm" dot={false}>
        {shown.label}
      </StatusPill>
    </button>
  );
}

/** A day as a card of rows: the agenda, and the week on a narrow screen. */
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
    <li className="overflow-hidden rounded-lg border border-border bg-background-surface shadow-xs">
      <h3 className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 font-display text-ui font-bold text-text-primary">
        {dayLabel(day)}
        {day === today && (
          <StatusPill tone="primary" size="sm">
            Today
          </StatusPill>
        )}
        <span className="ml-auto text-caption font-medium text-text-muted">
          {sessions.length} {sessions.length === 1 ? 'show' : 'shows'}
        </span>
      </h3>
      {sessions.length === 0 ? (
        <p className="px-4 py-3 text-caption text-text-muted">No shows</p>
      ) : (
        <ul className="divide-y divide-border">
          {sessions.map((s) => (
            <li key={s.id}>
              <SessionRow s={s} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

const MONTH_CELL_LIMIT = 3;
/** Dots under a day on a phone, where a cell is too narrow for a title. */
const DOT_LIMIT = 4;

/**
 * The month, ONE grid at every width: a phone shows each day's date and a dot per show, wider
 * screens the same cells with chips. Two grids swapped by breakpoint would put today's
 * `aria-current="date"` in the page twice, and exactly one cell may claim it.
 */
function MonthGrid({
  days,
  byDay,
  month,
  today,
  selected,
  onSelect,
  onOpen,
  onShowDay,
}: {
  days: string[];
  byDay: Record<string, AdminCalendarSession[]>;
  month: string;
  today: string;
  selected: string;
  onSelect: (day: string) => void;
  onOpen: (s: AdminCalendarSession) => void;
  onShowDay: (day: string) => void;
}) {
  return (
    <div role="table" aria-label="Month" className="min-w-0">
      <div role="row" className="grid grid-cols-7 border-b border-border">
        {WEEKDAY_HEADINGS.map((w) => (
          <div
            key={w}
            role="columnheader"
            className="px-1 pb-2 text-center text-micro font-semibold uppercase tracking-wide text-text-muted sm:px-2 sm:text-left"
          >
            {w}
          </div>
        ))}
      </div>
      {Array.from({ length: days.length / 7 }, (_, row) => (
        <div
          role="row"
          key={row}
          className="grid grid-cols-7 border-b border-border last:border-b-0"
        >
          {days.slice(row * 7, row * 7 + 7).map((day) => {
            const list = byDay[day] ?? [];
            const inMonth = day.slice(0, 7) === month;
            const extra = list.length - MONTH_CELL_LIMIT;
            const isToday = day === today;
            const isSelected = day === selected;
            return (
              <div
                key={day}
                role="cell"
                data-day={day}
                aria-current={isToday ? 'date' : undefined}
                // A convenience for the pointer; the date button is the keyboard's way in.
                onClick={() => onSelect(day)}
                className={`min-h-[3.5rem] min-w-0 cursor-pointer border-r border-border p-1 transition-colors duration-150 last:border-r-0 sm:min-h-[7.25rem] sm:p-1.5 ${
                  isSelected ? 'bg-background-subtle' : inMonth ? '' : 'bg-background-canvas/60'
                }`}
              >
                <div className="mb-1 flex justify-center sm:justify-start">
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    aria-label={`${dayLabel(day)}${isToday ? ', today' : ''}, ${list.length} ${
                      list.length === 1 ? 'show' : 'shows'
                    }. List the day`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(day);
                    }}
                    className={`inline-flex h-7 min-w-7 items-center justify-center rounded-full px-1 text-caption tabular-nums ${FOCUS} ${
                      isToday
                        ? 'bg-tint-primary font-bold text-action-primary ring-2 ring-action-primary'
                        : inMonth
                          ? 'font-medium text-text-primary hover:bg-background-subtle'
                          : 'text-text-muted hover:bg-background-subtle'
                    }`}
                  >
                    {Number(day.slice(8, 10))}
                  </button>
                </div>
                {list.length > 0 && (
                  <div aria-hidden className="flex items-center justify-center gap-0.5 sm:hidden">
                    {list.slice(0, DOT_LIMIT).map((s) => (
                      <span key={s.id} className={`h-1.5 w-1.5 rounded-full ${dotFor(s)}`} />
                    ))}
                    {list.length > DOT_LIMIT && (
                      <span className="text-[0.625rem] font-semibold leading-none text-text-muted">
                        +
                      </span>
                    )}
                  </div>
                )}
                <div className="hidden space-y-0.5 sm:block">
                  {list.slice(0, MONTH_CELL_LIMIT).map((s) => (
                    <MonthChip key={s.id} s={s} onOpen={onOpen} />
                  ))}
                  {extra > 0 && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onShowDay(day);
                      }}
                      aria-label={`Show all ${list.length} shows on ${dayLabel(day)}`}
                      className={`w-full rounded-md px-1.5 text-left text-micro font-semibold text-action-primary hover:underline ${FOCUS}`}
                    >
                      +{extra} more
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Rows listed in the day panel before "N more"; the agenda lists every one. */
const PANEL_LIMIT = 8;

/**
 * The chosen day beside the month, as the organizer calendar draws it: the month says where it
 * is busy, this says what is on, without opening anything. On a phone, where a cell shows only
 * dots, it is how a day is read at all.
 */
function DayPanel({
  day,
  sessions,
  today,
  onOpen,
  onShowDay,
}: {
  day: string;
  sessions: AdminCalendarSession[];
  today: string;
  onOpen: (s: AdminCalendarSession) => void;
  onShowDay: (day: string) => void;
}) {
  const shown = sessions.slice(0, PANEL_LIMIT);
  const hidden = sessions.length - shown.length;
  return (
    <section
      aria-labelledby="calendar-day-panel"
      data-testid="calendar-day-panel"
      className="min-w-0 rounded-lg border border-border bg-background-surface shadow-xs xl:sticky xl:top-20"
    >
      <div className="flex items-start justify-between gap-3 px-5 pb-3 pt-5">
        <div className="min-w-0">
          <h2
            id="calendar-day-panel"
            aria-live="polite"
            className="font-display text-[1.0625rem] font-bold text-text-primary"
          >
            {dayLabel(day)}
          </h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-caption text-text-muted">
            {day === today && (
              <StatusPill tone="primary" size="sm">
                Today
              </StatusPill>
            )}
            {sessions.length === 0
              ? 'Nothing scheduled'
              : `${sessions.length} ${sessions.length === 1 ? 'show' : 'shows'}, at venue time`}
          </p>
        </div>
        {sessions.length > 0 && (
          <button
            type="button"
            onClick={() => onShowDay(day)}
            className={`shrink-0 rounded-sm text-caption font-semibold text-action-primary hover:underline ${FOCUS}`}
          >
            Open in agenda
          </button>
        )}
      </div>
      {sessions.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-text-secondary">
          No shows on this day. Pick another day in the month.
        </p>
      ) : (
        <ul className="px-2 pb-3 md:grid md:grid-cols-2 md:gap-x-2 xl:block">
          {shown.map((s) => (
            <li key={s.id}>
              <SessionRow s={s} onOpen={onOpen} inset />
            </li>
          ))}
          {hidden > 0 && (
            <li className="px-3 pt-1 md:col-span-2">
              <button
                type="button"
                onClick={() => onShowDay(day)}
                className={`rounded-sm text-caption font-semibold text-action-primary hover:underline ${FOCUS}`}
              >
                {hidden} more on this day
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

/**
 * Shows per week column before "+N more", which opens that day in the agenda. A cinema's
 * Saturday can hold thirty shows; a column of thirty chips is a page-long scroll that hides
 * the rest of the week below the fold.
 */
const WEEK_LIMIT = 8;

function WeekColumns({
  days,
  byDay,
  today,
  onOpen,
  onShowDay,
}: {
  days: string[];
  byDay: Record<string, AdminCalendarSession[]>;
  today: string;
  onOpen: (s: AdminCalendarSession) => void;
  onShowDay: (day: string) => void;
}) {
  return (
    <div className="grid grid-cols-7 divide-x divide-border overflow-hidden rounded-lg border border-border bg-background-surface shadow-xs">
      {days.map((day) => {
        const list = byDay[day] ?? [];
        return (
          <section key={day} aria-label={dayLabel(day)} className="min-w-0">
            <h3
              className={`flex flex-wrap items-center gap-1.5 border-b border-border px-2 py-2.5 text-caption font-semibold ${
                day === today ? 'text-action-primary' : 'text-text-primary'
              }`}
            >
              {dayLabel(day)}
              {day === today && (
                <span className="rounded-full bg-tint-primary px-2 py-0.5 text-[0.6875rem] font-semibold text-action-primary ring-1 ring-action-primary">
                  Today
                </span>
              )}
            </h3>
            {list.length === 0 ? (
              <p className="px-2 py-2 text-caption text-text-muted">No shows</p>
            ) : (
              <ul className="space-y-1 p-1">
                {list.slice(0, WEEK_LIMIT).map((s) => (
                  <li key={s.id}>
                    <MonthChip s={s} onOpen={onOpen} />
                  </li>
                ))}
                {list.length > WEEK_LIMIT && (
                  <li>
                    <button
                      type="button"
                      onClick={() => onShowDay(day)}
                      aria-label={`Show all ${list.length} shows on ${dayLabel(day)}`}
                      className={`w-full rounded-md px-1.5 py-0.5 text-left text-micro font-semibold text-action-primary hover:underline ${FOCUS}`}
                    >
                      +{list.length - WEEK_LIMIT} more
                    </button>
                  </li>
                )}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** One fact with its icon tile, as the reference's event card lays out date and venue. */
function Fact({ icon, label, children }: { icon: LucideIcon; label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <IconTile icon={icon} tone="neutral" size="sm" />
      <div className="min-w-0 flex-1">
        <p className="text-caption font-medium text-text-secondary">{label}</p>
        {children}
      </div>
    </div>
  );
}

function Preview({ s }: { s: AdminCalendarSession }) {
  const unknown = zoneUnknown(s.timezone);
  const shown = showStatus(s);
  return (
    <div className="space-y-5 text-ui">
      <div className="space-y-3">
        <p className="text-micro font-semibold uppercase tracking-wide text-text-muted">
          {s.event.category}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone={statusTone(s.event.status)}>
            Event: {statusText(s.event.status)}
          </StatusPill>
          {shown.status !== s.event.status && (
            <StatusPill tone={statusTone(shown.status)}>{shown.label}</StatusPill>
          )}
        </div>
      </div>
      <div className="space-y-4 rounded-lg border border-border bg-background-canvas p-4">
        <Fact icon={CalendarClock} label="When (venue time)">
          <p className="font-medium text-text-primary">
            {/* The venue's day, not the reader's. */}
            {dayLabel(localDay(s.startsAt, s.timezone) ?? s.startsAt.slice(0, 10))},{' '}
            {localTime(s.startsAt, s.timezone)} to {localTime(s.endsAt, s.timezone)}{' '}
            <span className="text-text-muted">({zoneNote(s.startsAt, s.timezone)})</span>
          </p>
          {unknown && (
            <p className="mt-1 text-caption text-status-warning">
              This venue has no time zone recorded, so the time is shown in UTC.
            </p>
          )}
        </Fact>
        <Fact icon={MapPin} label="Venue">
          <p className="font-medium text-text-primary">
            {s.venue.name}, {s.venue.city}
            {s.venue.country ? `, ${s.venue.country}` : ''}
          </p>
          {s.room && <p className="text-caption text-text-muted">Room: {s.room}</p>}
        </Fact>
        <Fact icon={Building2} label="Organizer">
          <p className="font-medium text-text-primary">{s.organization.name}</p>
        </Fact>
        <Fact icon={Tag} label="Category">
          <p className="font-medium text-text-primary">{s.event.category}</p>
        </Fact>
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
  /*
    Today is the reader's own date, in the zone their browser reports - the policy in
    shared-types' `viewer-today.ts`, which the organizer calendar follows too. Taken when the page
    opens and fixed for its life, then taken again once mounted: a server render would otherwise
    hand over the server's date, and the server runs in UTC.
  */
  const [viewer, setViewer] = useState(() => viewerToday(new Date()));
  useEffect(() => setViewer(viewerToday(new Date())), []);
  const today = viewer.day;
  const anchor = parseDay(v.date) ?? today;
  const days = useMemo(() => viewDays(view, anchor), [view, anchor]);
  const range = fetchWindow(days);

  /*
    The day listed beside the month. It follows the anchor (Today, Previous, Next, a date in the
    URL) and then a click on a day; it is not in the URL, because choosing a day to read is not
    a different view of the calendar.
  */
  const [picked, setPicked] = useState(anchor);
  useEffect(() => setPicked(anchor), [anchor]);
  const [filtersOpen, setFiltersOpen] = useState(false);

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
  const activeFilters = [v.country, v.organizationId, v.status, v.city].filter(Boolean).length;

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

  const emptyHint = 'Move to another period, or clear the filters.';

  return (
    <div className="space-y-5">
      <PageHeader
        title="Calendar"
        description="Every show across organizers, on the clock at its own venue."
        action={
          <ButtonLink href="/admin/events?status=UNDER_REVIEW" variant="outline" size="sm">
            Approval queue
          </ButtonLink>
        }
      />

      {/* ── Controls: where you are, how you look at it, and what is shown ── */}
      <section
        aria-label="Calendar controls"
        className="rounded-lg border border-border bg-background-surface p-4 shadow-xs sm:p-5"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
          <div className="flex items-center gap-1">
            <IconButton
              variant="outline"
              size="sm"
              icon={ChevronLeft}
              label={`Previous ${STEP_NAMES[view]}`}
              onClick={() => go({ date: shiftAnchor(view, anchor, -1) })}
            />
            <IconButton
              variant="outline"
              size="sm"
              icon={ChevronRight}
              label={`Next ${STEP_NAMES[view]}`}
              onClick={() => go({ date: shiftAnchor(view, anchor, 1) })}
            />
          </div>
          <h2
            className="min-w-0 flex-1 font-display text-title font-bold text-text-primary"
            aria-live="polite"
          >
            {rangeLabel(view, anchor, days)}
          </h2>
          <Button variant="outline" size="sm" onClick={() => go({ date: today })}>
            Today
          </Button>
          <div
            role="group"
            aria-label="View"
            className="inline-flex max-w-full rounded-md border border-border bg-background-subtle p-1"
          >
            {CALENDAR_VIEWS.map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={view === key}
                onClick={() => go({ view: key })}
                className={`rounded-sm px-3 py-1.5 text-caption font-semibold transition-colors duration-150 ${FOCUS} ${
                  view === key
                    ? 'bg-background-surface text-action-primary shadow-xs'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {VIEW_LABELS[key]}
              </button>
            ))}
          </div>
        </div>

        {/*
          On a phone the four filters were a screen of form before the first date; they fold
          behind one button there, which says how many are on. The URL holds them either way.
        */}
        <button
          type="button"
          aria-expanded={filtersOpen}
          aria-controls="calendar-filters"
          onClick={() => setFiltersOpen((o) => !o)}
          className={`mt-4 inline-flex w-full items-center justify-between rounded-md border border-border px-3 py-2 text-caption font-semibold text-text-primary sm:hidden ${FOCUS}`}
        >
          <span className="inline-flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 text-text-secondary" aria-hidden />
            {activeFilters > 0 ? `Filters, ${activeFilters} on` : 'Filters'}
          </span>
          <ChevronDown
            className={`h-4 w-4 text-text-secondary transition-transform ${filtersOpen ? 'rotate-180' : ''}`}
            aria-hidden
          />
        </button>
        <div
          id="calendar-filters"
          className={`mt-4 border-border sm:block sm:border-t sm:pt-4 ${filtersOpen ? 'block' : 'hidden'}`}
        >
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
                  {statusText(s)}
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
              <p className="mt-1.5 text-caption text-text-muted">
                Cities with shows in this period.
              </p>
            </div>
          </div>
          {activeFilters > 0 && (
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
        </div>

        <div
          className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-text-muted"
          role="status"
        >
          {query.data && (
            <span>
              {visibleCount} {visibleCount === 1 ? 'show' : 'shows'} in this period
              {query.isFetching ? ', updating' : ''}.
            </span>
          )}
          <span>Times are local to each venue.</span>
          <span data-testid="calendar-today-zone">
            Today is marked in your time zone, {viewerZoneLabel(viewer)}.
          </span>
        </div>

        {query.data?.meta.truncated && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-status-warning bg-tint-warning px-3 py-2 text-sm text-text-primary">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-status-warning" aria-hidden />
            <p>
              There are more than {query.data.meta.limit} shows in this period, so the latest ones
              are not shown. Choose an organizer, market or status to narrow it.
            </p>
          </div>
        )}
        {anyUnknownZone && (
          <p className="mt-3 text-caption text-status-warning">
            Some venues have no time zone recorded. Their shows are placed and timed in UTC, and say
            so when opened.
          </p>
        )}
      </section>

      {query.isError ? (
        <ErrorState
          message="We could not load the calendar. Please try again."
          onRetry={() => query.refetch()}
        />
      ) : !query.data ? (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <Skeleton className="h-[32rem] w-full rounded-lg" />
          {view === 'month' && <Skeleton className="hidden h-72 w-full rounded-lg xl:block" />}
        </div>
      ) : view === 'month' ? (
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0 rounded-lg border border-border bg-background-surface p-2 shadow-xs sm:p-3">
            <MonthGrid
              days={days}
              byDay={byDay}
              month={anchor.slice(0, 7)}
              today={today}
              selected={picked}
              onSelect={setPicked}
              onOpen={open}
              onShowDay={(day) => go({ view: 'agenda', date: day })}
            />
          </div>
          <DayPanel
            day={picked}
            sessions={byDay[picked] ?? []}
            today={today}
            onOpen={open}
            onShowDay={(day) => go({ view: 'agenda', date: day })}
          />
        </div>
      ) : view === 'agenda' ? (
        visibleCount === 0 ? (
          <EmptyState compact title="No shows in these two weeks" hint={emptyHint} />
        ) : (
          <ul className="space-y-4">
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
            Seven columns need room. Below `xl` each column would be narrower than a show's
            title, so the same days are listed instead - same data, same order, nothing hidden.
          */}
          <div className="hidden xl:block">
            <WeekColumns
              days={days}
              byDay={byDay}
              today={today}
              onOpen={open}
              onShowDay={(day) => go({ view: 'agenda', date: day })}
            />
          </div>
          <div className="xl:hidden">
            {visibleCount === 0 ? (
              <EmptyState compact title="No shows this week" hint={emptyHint} />
            ) : (
              <ul className="space-y-4">
                {days.map((d) => (
                  <DayList
                    key={d}
                    day={d}
                    sessions={byDay[d]}
                    today={today}
                    onOpen={open}
                    showEmpty
                  />
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      <Drawer
        open={selected !== null}
        onClose={close}
        title={selected?.event.title ?? 'Show'}
        footer={
          selected ? (
            <div className="flex flex-wrap gap-2">
              <ButtonLink href={`/admin/events/${selected.event.id}`} size="sm">
                Open event <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </ButtonLink>
              <ButtonLink
                href={`/admin/organizers/${selected.organization.id}`}
                size="sm"
                variant="outline"
              >
                Open organizer
              </ButtonLink>
            </div>
          ) : undefined
        }
      >
        {selected && <Preview s={selected} />}
      </Drawer>
    </div>
  );
}
