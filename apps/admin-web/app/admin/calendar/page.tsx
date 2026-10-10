'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Building2, CalendarClock, ExternalLink, MapPin, Tag, TriangleAlert } from 'lucide-react';
import {
  api,
  Button,
  ButtonLink,
  CalendarChip,
  CalendarDayCard,
  CalendarDayPanel,
  CalendarFact,
  CalendarLoading,
  CalendarMonthGrid,
  CalendarMonthLayout,
  CalendarPreview,
  CalendarTodayBadge,
  CalendarToolbar,
  CalendarZoneNote,
  Card,
  Drawer,
  EmptyState,
  ErrorState,
  PageHeader,
  Select,
  useAuthUser,
  type AdminCalendarSession,
  type CalendarEntry,
  type OpenCalendarEntry,
} from '@eticketsgo/web-kit';
import { viewerToday, viewerZoneLabel } from '@eticketsgo/shared-types';
import { CountryFilter } from '@/components/country-filter';
import { OrganizerPicker, useUrlFilters } from '@/components/list-filters';
import {
  CALENDAR_VIEWS,
  cityOptions,
  dayLabel,
  entriesByDay,
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
  toWeeks,
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
 *
 * ── HOW IT LOOKS ───────────────────────────────────────────────────────────────────
 * Drawn by the SAME components as the organizer calendar (web-kit `calendar-view.tsx`): the
 * controls card, the keyboard month grid with today ringed and a dot per show in its status
 * colour, the chosen day listed beside it with status pills, the agenda's day cards, and the
 * quick-look layout. What stays here is the admin's own: the EVENT_REVIEW gate, the query and
 * its filters, the seven-column week, and the drawer's way on (the event, the organizer).
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

const VIEWS = CALENDAR_VIEWS.map((id) => ({ id, label: VIEW_LABELS[id] }));

const STEP_NAMES: Record<CalendarView, string> = {
  month: 'month',
  week: 'week',
  agenda: 'two weeks',
};

const NOUN = { one: 'show', many: 'shows' };

type Entry = CalendarEntry<AdminCalendarSession>;
type OpenEntry = OpenCalendarEntry<AdminCalendarSession>;

/**
 * Shows per week column before "+N more", which opens that day in the agenda. A cinema's
 * Saturday can hold thirty shows; a column of thirty chips is a page-long scroll that hides
 * the rest of the week below the fold.
 */
const WEEK_LIMIT = 8;

/**
 * The week as seven columns of chips, for a wide screen. The organizer calendar draws an hour
 * grid instead (it schedules; an admin reads), so this stays here, built from the shared chip
 * and today badge.
 */
function WeekColumns({
  days,
  entries,
  today,
  onOpen,
  onShowDay,
}: {
  days: string[];
  entries: Map<string, Entry[]>;
  today: string;
  onOpen: OpenEntry;
  onShowDay: (day: string) => void;
}) {
  return (
    <div className="grid grid-cols-7 divide-x divide-border overflow-hidden rounded-lg border border-border bg-background-surface shadow-xs">
      {days.map((day) => {
        const list = entries.get(day) ?? [];
        return (
          <section key={day} aria-label={dayLabel(day)} className="min-w-0">
            <h3
              className={`flex flex-wrap items-center gap-1.5 border-b border-border px-2 py-2.5 text-caption font-semibold ${
                day === today ? 'text-action-primary' : 'text-text-primary'
              }`}
            >
              {dayLabel(day)}
              {day === today && <CalendarTodayBadge />}
            </h3>
            {list.length === 0 ? (
              <p className="px-2 py-2 text-caption text-text-muted">No shows</p>
            ) : (
              <ul className="space-y-1 p-1">
                {list.slice(0, WEEK_LIMIT).map((e) => (
                  <li key={e.id}>
                    <CalendarChip entry={e} onOpen={onOpen} />
                  </li>
                ))}
                {list.length > WEEK_LIMIT && (
                  <li>
                    <button
                      type="button"
                      onClick={() => onShowDay(day)}
                      aria-label={`Show all ${list.length} shows on ${dayLabel(day)}`}
                      className="w-full rounded-md px-1.5 py-0.5 text-left text-micro font-semibold text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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

/** The days as cards of rows: the agenda, and the week on a narrow screen. */
function DayCards({
  days,
  entries,
  today,
  onOpen,
  showEmpty,
}: {
  days: string[];
  entries: Map<string, Entry[]>;
  today: string;
  onOpen: OpenEntry;
  showEmpty: boolean;
}) {
  return (
    <ul className="space-y-4">
      {days.map((d) => {
        const list = entries.get(d) ?? [];
        if (!showEmpty && list.length === 0) return null;
        return (
          <li key={d}>
            <CalendarDayCard
              day={d}
              heading={dayLabel(d)}
              entries={list}
              today={today}
              noun={NOUN}
              onOpen={onOpen}
            />
          </li>
        );
      })}
    </ul>
  );
}

/** The quick look's facts: the admin reads the organizer and room too. */
function Facts({ s }: { s: AdminCalendarSession }) {
  const unknown = zoneUnknown(s.timezone);
  return (
    <>
      <CalendarFact icon={CalendarClock} label="When (venue time)">
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
      </CalendarFact>
      <CalendarFact icon={MapPin} label="Venue">
        <p className="font-medium text-text-primary">
          {s.venue.name}, {s.venue.city}
          {s.venue.country ? `, ${s.venue.country}` : ''}
        </p>
        {s.room && <p className="text-caption text-text-muted">Room: {s.room}</p>}
      </CalendarFact>
      <CalendarFact icon={Building2} label="Organizer">
        <p className="font-medium text-text-primary">{s.organization.name}</p>
      </CalendarFact>
      <CalendarFact icon={Tag} label="Category">
        <p className="font-medium text-text-primary">{s.event.category}</p>
      </CalendarFact>
    </>
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
    URL) and then a click or an arrow key in the grid; it is not in the URL, because choosing a
    day to read is not a different view of the calendar.
  */
  const [picked, setPicked] = useState(anchor);
  useEffect(() => setPicked(anchor), [anchor]);

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
  const entries = useMemo(() => entriesByDay(byDay), [byDay]);
  const visibleCount = days.reduce((n, d) => n + (byDay[d]?.length ?? 0), 0);
  const anyUnknownZone = shown.some((s) => zoneUnknown(s.timezone));
  const activeFilters = [v.country, v.organizationId, v.status, v.city].filter(Boolean).length;

  const [selected, setSelected] = useState<AdminCalendarSession | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const open: OpenEntry = (e, from) => {
    trigger.current = from;
    setSelected(e.source);
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
      <CalendarToolbar
        views={VIEWS}
        view={view}
        onView={(key) => go({ view: key })}
        stepName={STEP_NAMES[view]}
        onStep={(dir) => go({ date: shiftAnchor(view, anchor, dir) })}
        title={rangeLabel(view, anchor, days)}
        onToday={() => go({ date: today })}
        activeFilters={activeFilters}
        filters={
          <>
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
          </>
        }
      >
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
          <CalendarZoneNote zone={viewerZoneLabel(viewer)} />
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
      </CalendarToolbar>

      {query.isError ? (
        <ErrorState
          message="We could not load the calendar. Please try again."
          onRetry={() => query.refetch()}
        />
      ) : !query.data ? (
        <CalendarLoading withPanel={view === 'month'} />
      ) : view === 'month' ? (
        <CalendarMonthLayout
          grid={
            <CalendarMonthGrid
              weeks={toWeeks(days)}
              month={anchor.slice(0, 7)}
              entries={entries}
              today={today}
              focusedDay={picked}
              // Weeks start on Monday here, as `viewDays` draws them.
              weekStart={1}
              formatDay={dayLabel}
              noun={NOUN}
              showDayLabel="Open in agenda"
              onFocusDay={(day, viaKeyboard) => {
                setPicked(day);
                if (viaKeyboard && day.slice(0, 7) !== anchor.slice(0, 7)) go({ date: day });
              }}
              onOpen={open}
              onShowDay={(day) => go({ view: 'agenda', date: day })}
            />
          }
          panel={
            <CalendarDayPanel
              day={picked}
              heading={dayLabel(picked)}
              entries={entries.get(picked) ?? []}
              today={today}
              noun={NOUN}
              showDayLabel="Open in agenda"
              onOpen={open}
              onShowDay={(day) => go({ view: 'agenda', date: day })}
            />
          }
        />
      ) : view === 'agenda' ? (
        visibleCount === 0 ? (
          <EmptyState compact title="No shows in these two weeks" hint={emptyHint} />
        ) : (
          <DayCards days={days} entries={entries} today={today} onOpen={open} showEmpty={false} />
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
              entries={entries}
              today={today}
              onOpen={open}
              onShowDay={(day) => go({ view: 'agenda', date: day })}
            />
          </div>
          <div className="xl:hidden">
            {visibleCount === 0 ? (
              <EmptyState compact title="No shows this week" hint={emptyHint} />
            ) : (
              <DayCards days={days} entries={entries} today={today} onOpen={open} showEmpty />
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
        {selected && (
          <CalendarPreview
            category={selected.event.category}
            eventStatus={selected.event.status}
            shown={showStatus(selected)}
          >
            <Facts s={selected} />
          </CalendarPreview>
        )}
      </Drawer>
    </div>
  );
}
