'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  api,
  Button,
  ButtonLink,
  EmptyState,
  ErrorState,
  Input,
  PageHeader,
  Select,
  Skeleton,
  errorMessage,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import {
  CALENDAR_STATUSES,
  canCreateEvents,
  defaultViewFor,
  fetchWindow,
  filterOptions,
  filterSessions,
  isDayKey,
  monthGrid,
  rangeTitle,
  segmentsByDay,
  statusText,
  stepAnchor,
  toCalendarSessions,
  todayKey,
  visibleRange,
  weekDays,
  weekStartFor,
  type CalendarSession,
  type CalendarView,
  type DayKey,
} from '@/lib/calendar';
import { AgendaView } from './agenda-view';
import { MonthView } from './month-view';
import { PreviewDrawer } from './preview-drawer';
import { TimeGrid } from './time-grid';

/** Sessions drawn per day column before "+N more": in a week, and in a single day. */
const WEEK_DAY_CAP = 6;
const DAY_CAP = 40;

const VIEWS: { id: CalendarView; label: string }[] = [
  { id: 'month', label: 'Month' },
  { id: 'week', label: 'Week' },
  { id: 'day', label: 'Day' },
  { id: 'agenda', label: 'List' },
];

const STEP_NAMES: Record<CalendarView, string> = {
  month: 'month',
  week: 'week',
  day: 'day',
  agenda: 'month',
};

/**
 * The organizer calendar: every session of every event, at its venue's local time.
 *
 * The view, the date and the filters live in the URL, so Back works, a view can be shared with
 * a colleague, and a reload lands where the organizer was.
 */
export function OrganizerCalendar() {
  const { activeOrg } = useOrg();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const today = todayKey();
  const weekStart = weekStartFor(activeOrg.registeredCountry);
  const anchor: DayKey = isDayKey(params.get('date')) ? params.get('date')! : today;
  const status = params.get('status') ?? '';
  const venueId = params.get('venue') ?? '';
  const category = params.get('category') ?? '';

  /*
    With no view in the URL, phones get the agenda and wider screens the month. That needs the
    window, which the server does not have, so the choice is made once on mount; until then a
    skeleton holds the place rather than a month grid that would flash and then vanish.
  */
  const [fallbackView, setFallbackView] = useState<CalendarView | null>(null);
  useEffect(() => setFallbackView(defaultViewFor(window.innerWidth)), []);
  const urlView = params.get('view') as CalendarView | null;
  const view: CalendarView | null = VIEWS.some((v) => v.id === urlView) ? urlView : fallbackView;

  const setParams = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [params, pathname, router],
  );

  const [focusedDay, setFocusedDay] = useState<DayKey>(anchor);
  const [agendaFocus, setAgendaFocus] = useState<DayKey | null>(null);
  useEffect(() => setFocusedDay(anchor), [anchor]);

  // ─── Data ───
  const range = view ? visibleRange(view, anchor, weekStart) : { from: anchor, to: anchor };
  const fetchRange = fetchWindow(range);
  /*
    One request for the visible range. Keyed on the window, so paging back to a month already
    seen is instant, and the previous range stays on screen while the next one loads rather than
    the grid blanking on every click of Next.
  */
  const sessionsQ = useQuery({
    queryKey: ['organizer-calendar', activeOrg.id, fetchRange.from, fetchRange.to],
    queryFn: () => api.events.calendar(activeOrg.id, fetchRange.from, fetchRange.to),
    enabled: view !== null,
    placeholderData: keepPreviousData,
  });
  // For the filter menus only: every venue, and the categories of every event.
  const venuesQ = useQuery({
    queryKey: ['venues', activeOrg.id],
    queryFn: () => api.venues.list(activeOrg.id),
  });
  const eventsQ = useQuery({
    queryKey: ['events', activeOrg.id],
    queryFn: () => api.events.list(activeOrg.id),
  });

  const sessions = useMemo(
    () => toCalendarSessions(sessionsQ.data?.sessions ?? []),
    [sessionsQ.data],
  );
  const options = useMemo(
    () => filterOptions(venuesQ.data ?? [], eventsQ.data ?? []),
    [venuesQ.data, eventsQ.data],
  );
  const filtered = useMemo(
    () => filterSessions(sessions, { status, venueId, category }),
    [sessions, status, venueId, category],
  );

  const byDay = useMemo(
    () => segmentsByDay(filtered, range.from, range.to),
    [filtered, range.from, range.to],
  );
  const inRange = useMemo(() => {
    const ids = new Set<string>();
    for (const list of byDay.values()) for (const seg of list) ids.add(seg.session.id);
    return ids.size;
  }, [byDay]);

  // ─── Drawer, and the focus it hands back ───
  const [selected, setSelected] = useState<CalendarSession | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const openSession = useCallback((s: CalendarSession, trigger: HTMLElement) => {
    returnFocus.current = trigger;
    setSelected(s);
  }, []);
  const closeDrawer = useCallback(() => {
    setSelected(null);
    // After the drawer has gone; the trigger may have re-rendered, so find it again by id.
    window.setTimeout(() => {
      const el = returnFocus.current;
      if (el?.isConnected) el.focus();
      else {
        const id = el?.getAttribute('data-session-id');
        document.querySelector<HTMLElement>(`[data-session-id="${id}"]`)?.focus();
      }
    }, 0);
  }, []);

  const mayCreate = canCreateEvents(activeOrg.myRole);
  const createButton = mayCreate ? (
    <ButtonLink href="/organizer/events/new">Create event</ButtonLink>
  ) : undefined;
  const filtersOn = Boolean(status || venueId || category);

  if (!view) return <Skeleton className="h-96 w-full" />;

  const goTo = (day: DayKey, nextView?: CalendarView) =>
    setParams({ date: day === today ? null : day, ...(nextView ? { view: nextView } : {}) });

  const loading = sessionsQ.isPending;
  /*
    "Nothing scheduled yet" only when the organization has no sessions ANYWHERE, read from the
    events list's counts - an empty month is not an empty calendar.
  */
  const nothingAtAll =
    !loading &&
    !sessionsQ.isError &&
    eventsQ.isSuccess &&
    eventsQ.data.every((e) => e._count.sessions === 0);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Calendar"
        description="Every session at the local time of its venue, with the venue's time zone."
        action={createButton}
      />

      {/* ── Toolbar ── */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => goTo(today)}>
            Today
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-label={`Previous ${STEP_NAMES[view]}`}
            onClick={() => goTo(stepAnchor(view, anchor, -1))}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-label={`Next ${STEP_NAMES[view]}`}
            onClick={() => goTo(stepAnchor(view, anchor, 1))}
          >
            <ChevronRight className="h-4 w-4" aria-hidden />
          </Button>
        </div>
        <h2
          className="min-w-0 flex-1 text-title font-semibold text-text-primary"
          aria-live="polite"
          data-testid="calendar-range-title"
        >
          {rangeTitle(view, anchor, weekStart)}
        </h2>
        <div className="w-40">
          <Input
            type="date"
            label="Go to date"
            value={anchor}
            onChange={(e) => {
              if (isDayKey(e.target.value)) goTo(e.target.value);
            }}
          />
        </div>
        <div
          role="group"
          aria-label="Calendar view"
          className="inline-flex rounded-md border border-border-input bg-background-surface p-0.5"
        >
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              aria-pressed={view === v.id}
              onClick={() => setParams({ view: v.id })}
              className={`rounded px-3 py-1.5 text-button font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                view === v.id
                  ? 'bg-action-primary text-action-primary-foreground'
                  : 'text-text-secondary hover:bg-background-subtle hover:text-text-primary'
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Filters ── */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Select
          label="Status"
          value={status}
          onChange={(e) => setParams({ status: e.target.value || null })}
        >
          <option value="">All statuses</option>
          {CALENDAR_STATUSES.map((s) => (
            <option key={s} value={s}>
              {statusText(s)}
            </option>
          ))}
        </Select>
        <Select
          label="Venue"
          value={venueId}
          onChange={(e) => setParams({ venue: e.target.value || null })}
        >
          <option value="">All venues</option>
          {options.venues.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
        </Select>
        <Select
          label="Category"
          value={category}
          onChange={(e) => setParams({ category: e.target.value || null })}
        >
          <option value="">All categories</option>
          {options.categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </div>

      {sessionsQ.data?.truncated && (
        <p className="text-caption text-status-warning" data-testid="calendar-cap-note">
          This range has more than {sessionsQ.data.limit} sessions, so the latest ones are not
          shown. Pick a shorter view or a venue to see them all.
        </p>
      )}

      {/* ── Body ── */}
      {sessionsQ.isError ? (
        <ErrorState
          message={errorMessage(sessionsQ.error)}
          onRetry={() => void sessionsQ.refetch()}
        />
      ) : loading ? (
        <Skeleton className="h-96 w-full" />
      ) : nothingAtAll ? (
        <EmptyState
          icon={CalendarDays}
          title="Nothing scheduled yet"
          hint={
            mayCreate
              ? 'Create an event and add its sessions. They will appear here at their venue time.'
              : 'Sessions appear here once an owner or manager schedules them.'
          }
          action={createButton}
        />
      ) : (
        <>
          <p className="text-caption text-text-muted" aria-live="polite">
            {inRange === 0
              ? `No sessions in this view${filtersOn ? ' match the filters' : ''}.`
              : `${inRange} ${inRange === 1 ? 'session' : 'sessions'} in this view.`}{' '}
            {sessionsQ.isPlaceholderData ? 'Loading...' : ''}
            {inRange === 0 && filtersOn && (
              <button
                type="button"
                className="ml-1 font-medium text-action-primary underline"
                onClick={() => setParams({ status: null, venue: null, category: null })}
              >
                Clear filters
              </button>
            )}
          </p>

          {view === 'month' && (
            <MonthView
              weeks={monthGrid(anchor, weekStart)}
              month={anchor.slice(0, 7)}
              byDay={byDay}
              today={today}
              focusedDay={focusedDay}
              weekStart={weekStart}
              onFocusDay={(day, viaKeyboard) => {
                setFocusedDay(day);
                if (viaKeyboard && day.slice(0, 7) !== anchor.slice(0, 7)) goTo(day);
              }}
              onOpen={openSession}
              onShowDay={(day) => goTo(day, 'day')}
            />
          )}
          {(view === 'week' || view === 'day') && (
            <TimeGrid
              days={view === 'week' ? weekDays(anchor, weekStart) : [anchor]}
              byDay={byDay}
              today={today}
              cap={view === 'week' ? WEEK_DAY_CAP : DAY_CAP}
              onOpen={openSession}
              onShowMore={(day) => {
                setAgendaFocus(day);
                goTo(day, 'agenda');
              }}
            />
          )}
          {view === 'agenda' && (
            <>
              <AgendaView
                days={Array.from(byDay.keys())}
                byDay={byDay}
                today={today}
                focusDay={agendaFocus}
                onOpen={openSession}
              />
              {inRange === 0 && !filtersOn && createButton && (
                <div className="flex justify-center py-6">{createButton}</div>
              )}
            </>
          )}
        </>
      )}

      <PreviewDrawer session={selected} onClose={closeDrawer} />
    </div>
  );
}
