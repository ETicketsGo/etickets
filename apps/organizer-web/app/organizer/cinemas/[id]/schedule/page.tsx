'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Clock, Copy, MonitorPlay, Plus } from 'lucide-react';
import {
  api,
  Button,
  ButtonLink,
  Card,
  Dialog,
  EmptyState,
  ErrorState,
  IconButton,
  IconTile,
  Input,
  ProgressMeter,
  Select,
  Skeleton,
  Textarea,
  PageHeader,
  useToast,
  errorMessage,
  type ShowRow,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import { SalePill } from '@/components/cinema/sale-pill';
import { useShowVerdicts } from '@/components/cinema/use-cinema-data';
import type { SaleVerdict } from '@/components/cinema/cinema-model';
import {
  availableActions,
  formatDayHeading,
  formatLocalTime,
  groupByScreen,
  shiftDate,
  todayLabel,
} from './show-status';
import { BulkScheduler } from './bulk-scheduler';
import { CopyScheduleDialog } from './copy-schedule';
import { EditShowDialog } from './edit-show';
import { ShowPricingDialog } from './show-pricing';
import { WeekView } from './week-view';

/**
 * The cinema scheduling workspace — a theater's daily operating screen.
 *
 * The mental model is Date → Screen → Timeline, because that is how a duty manager thinks:
 * "what is on Screen 2 today". A generic event-card grid would technically show the same
 * rows and would be useless for the job, which is spotting a gap or a clash at a glance.
 *
 * Everything here is a VIEW over server decisions. The frontend never computes overlap,
 * bookability or turnaround; it renders what the API said and translates rejection codes
 * into sentences. A stale page cannot perform an action the server would refuse, because
 * the server refuses it.
 */
export default function CinemaSchedulePage() {
  const { id: cinemaId } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();

  /*
    Empty until the cinema's zone is known.

    Seeding this with the BROWSER's today is the defect in miniature: an operator in London
    opening a Hyderabad cinema after 18:30 GMT would land on yesterday's schedule and see an
    empty day. It is set once, below, from the venue's own clock.
  */
  const [date, setDate] = useState('');
  const [screenFilter, setScreenFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  // Day is the default: it is where an operator works. Week is for planning.
  const [mode, setMode] = useState<'day' | 'week'>('day');
  const [bulkOpen, setBulkOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);

  const cinemaQ = useQuery({
    queryKey: ['cinema', cinemaId],
    queryFn: () => api.cinemas.get(cinemaId),
  });
  /*
    The cinema's own zone, read from the cinema record.

    NOT a constant, not the browser's, not a launch-market default. A hardcoded zone has
    already produced two real defects on this page, and it stops being merely wrong the
    moment a second city is onboarded.

    There is no authoritative local date until the cinema has loaded, so the page holds its
    loading state rather than guessing one. Guessing is exactly what produced the earlier
    defects: a plausible-but-wrong day looks like data, whereas a skeleton looks like waiting.
  */
  const timezone = cinemaQ.data?.timezone ?? null;

  const screensQ = useQuery({
    queryKey: ['cinema', cinemaId, 'screens'],
    queryFn: () => api.cinemas.screens(cinemaId),
  });
  const scheduleQ = useQuery({
    queryKey: ['cinema', cinemaId, 'schedule', date, timezone],
    queryFn: () => api.shows.cinemaSchedule(cinemaId, date, timezone as string),
    // No point fetching a day nobody is looking at — and never before the cinema's zone is
    // known, or the first request asks for the wrong day.
    enabled: mode === 'day' && !!timezone && !!date,
  });

  // Land on today AT THE CINEMA the moment its zone is known, and never re-steer the
  // operator afterwards — they may have navigated deliberately.
  useEffect(() => {
    if (timezone && !date) setDate(todayLabel(timezone));
  }, [timezone, date]);

  /** Re-read the authoritative day after any mutation. Never patch local state. */
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['cinema', cinemaId, 'schedule'] }),
      // A repriced show keeps its status, so its sale state is asked again explicitly.
      qc.invalidateQueries({ queryKey: ['organizer-sale-eligibility'] }),
    ]);

  const rows = scheduleQ.data ?? [];
  const filtered = rows.filter(
    (r) =>
      (!screenFilter || r.screenId === screenFilter) &&
      (!statusFilter || r.status.toUpperCase() === statusFilter),
  );
  const screens = groupByScreen(filtered);

  /*
    The server's unified sale state for every show on the day - what checkout acts on - so a
    row here cannot say "Selling" while the Overview, the film page or checkout says otherwise.
  */
  const { activeOrg } = useOrg();
  const zoneOfShow = useCallback(() => timezone ?? undefined, [timezone]);
  const verdictOf = useShowVerdicts(activeOrg.id, rows, zoneOfShow);

  // Screens with nothing on them still get a row: an empty screen is the single most
  // actionable thing on this page, and hiding it hides the gap.
  const allScreens = screensQ.data ?? [];
  const emptyScreens = allScreens.filter(
    (s) => !screens.some((g) => g.screenId === s.id) && (!screenFilter || s.id === screenFilter),
  );

  /*
    Hold until the venue's zone is known.

    Every date on this page is a LOCAL date at the cinema, so rendering before the zone has
    loaded means rendering a guess. A skeleton reads as "waiting"; a plausible-but-wrong day
    reads as data, and that is precisely how the earlier timezone defects went unnoticed.
  */
  if (!timezone || !date) {
    return (
      <div className="space-y-6" aria-busy="true">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  const cinema = cinemaQ.data;
  const dayShows = filtered.length;
  const daySold = filtered.reduce((n, r) => n + r.seatsSold, 0);
  const daySeats = filtered.reduce((n, r) => n + r.seatsTotal, 0);
  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Venues & seating', href: '/organizer/venues' },
          ...(cinema ? [{ label: cinema.name, href: `/organizer/cinemas/${cinemaId}` }] : []),
          { label: 'Schedule' },
        ]}
        eyebrow="Cinema schedule"
        title={cinema ? cinema.name : 'Schedule'}
        description="Plan and operate this cinema's screens, day by day."
        action={
          <>
            <Button variant="outline" icon={Copy} onClick={() => setCopyOpen(true)}>
              Copy schedule
            </Button>
            <Button icon={Plus} onClick={() => setBulkOpen(true)}>
              Create shows
            </Button>
          </>
        }
      />

      <Card padding="md">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <div className="w-full min-[420px]:w-auto">
            <label
              htmlFor="schedule-date"
              className="mb-1.5 block text-[0.8125rem] font-medium text-text-secondary"
            >
              Date
            </label>
            <Input
              id="schedule-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-1.5" role="group" aria-label="Change date">
            <IconButton
              variant="outline"
              size="lg"
              icon={ChevronLeft}
              label={mode === 'week' ? 'Previous week' : 'Previous day'}
              onClick={() => setDate(shiftDate(date, mode === 'week' ? -7 : -1))}
            />
            <Button variant="outline" onClick={() => setDate(todayLabel(timezone))}>
              Today
            </Button>
            <IconButton
              variant="outline"
              size="lg"
              icon={ChevronRight}
              label={mode === 'week' ? 'Next week' : 'Next day'}
              onClick={() => setDate(shiftDate(date, mode === 'week' ? 7 : 1))}
            />
          </div>
          {/*
            Day / Week as one segmented control. Each half is a real toggle button with
            `aria-pressed`, so which view is showing is said in words, not only in colour.
          */}
          <div
            className="inline-flex rounded-md border border-border-input bg-background-subtle p-0.5"
            role="group"
            aria-label="Schedule view"
          >
            {(['day', 'week'] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                className={`h-10 rounded-[calc(var(--radius-md)-2px)] px-4 text-ui font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  mode === m
                    ? 'bg-background-surface text-text-primary shadow-xs'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {m === 'day' ? 'Day' : 'Week'}
              </button>
            ))}
          </div>
          <div className="w-full min-[420px]:w-auto">
            <label
              htmlFor="screen-filter"
              className="mb-1.5 block text-[0.8125rem] font-medium text-text-secondary"
            >
              Screen
            </label>
            <Select
              id="screen-filter"
              value={screenFilter}
              onChange={(e) => setScreenFilter(e.target.value)}
            >
              <option value="">All screens</option>
              {allScreens.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-full min-[420px]:w-auto">
            <label
              htmlFor="status-filter"
              className="mb-1.5 block text-[0.8125rem] font-medium text-text-secondary"
            >
              Status
            </label>
            {/*
              Filters on the SHOW's own status, so the words are the show's ("Scheduled",
              "Paused"), not a sale state: whether a scheduled show can actually be bought is
              the pill on its row, from the server.
            */}
            <Select
              id="status-filter"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">All statuses</option>
              <option value="SCHEDULED">Scheduled</option>
              <option value="PAUSED">Paused</option>
              <option value="CANCELLED">Cancelled</option>
            </Select>
          </div>
        </div>

        {/*
          State the clock being used. Every date and time on this page is local to the venue,
          and an operator working across cinemas has no other way to tell which one they are
          reading - the difference between a Hyderabad and a Sydney day is not visible from
          the numbers alone.
        */}
        <p className="mt-3 flex items-center gap-1.5 text-caption text-text-muted">
          <Clock className="h-3.5 w-3.5" aria-hidden />
          Times are local to the cinema ({timezone}).
        </p>
      </Card>

      {mode === 'week' ? (
        <WeekView
          cinemaId={cinemaId}
          anchorDate={date}
          timezone={timezone}
          screenFilter={screenFilter}
          onSelectDay={(d) => {
            // Selecting a show or a day hands over to the day view, which is where the
            // pause/move/cancel controls live. Duplicating them here would mean two
            // implementations of every destructive action.
            setDate(d);
            setMode('day');
          }}
        />
      ) : scheduleQ.isPending ? (
        <div className="space-y-3" role="status" aria-busy="true" aria-label="Loading schedule">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28 w-full rounded-lg" />
          ))}
        </div>
      ) : scheduleQ.isError ? (
        <ErrorState
          message={errorMessage(scheduleQ.error)}
          onRetry={() => void scheduleQ.refetch()}
        />
      ) : screens.length === 0 && emptyScreens.length === 0 ? (
        <EmptyState
          title="No screens yet"
          hint="A show plays on a screen, so that comes first. Add one and publish its seat layout."
          action={<ButtonLink href={`/organizer/cinemas/${cinemaId}`}>Add a screen</ButtonLink>}
        />
      ) : (
        <div className="space-y-4">
          <p className="text-ui text-text-secondary" aria-live="polite">
            <span className="font-semibold text-text-primary">{formatDayHeading(date)}</span>
            {' - '}
            {dayShows} {dayShows === 1 ? 'show' : 'shows'}
            {daySeats > 0 ? `, ${daySold} of ${daySeats} seats sold` : ''}
          </p>
          {screens.map((group) => (
            <ScreenTimeline
              key={group.screenId}
              screenName={group.screenName}
              shows={group.shows}
              timezone={timezone}
              verdictOf={verdictOf}
              onChanged={refresh}
              toast={toast}
            />
          ))}
          {emptyScreens.map((s) => (
            <section
              key={s.id}
              aria-labelledby={`screen-${s.id}`}
              className="flex items-start gap-3 rounded-lg border border-dashed border-border bg-background-surface p-4 sm:p-5"
            >
              <IconTile icon={MonitorPlay} tone="neutral" size="sm" />
              <div className="min-w-0">
                <h3
                  id={`screen-${s.id}`}
                  className="font-display text-[0.9375rem] font-bold text-text-primary"
                >
                  {s.name}
                </h3>
                <p className="mt-0.5 text-caption text-text-muted">
                  Nothing scheduled on this date.
                  {s.status && s.status !== 'ACTIVE'
                    ? ` This screen is ${s.status.toLowerCase()} and cannot take new shows.`
                    : ''}
                </p>
              </div>
            </section>
          ))}
        </div>
      )}

      {bulkOpen ? (
        <BulkScheduler
          screens={allScreens}
          defaultDate={date}
          timezone={timezone}
          onClose={() => setBulkOpen(false)}
          onPublished={() => {
            setBulkOpen(false);
            void refresh();
          }}
        />
      ) : null}

      {copyOpen ? (
        <CopyScheduleDialog
          screens={allScreens}
          sourceDate={date}
          timezone={timezone}
          onClose={() => setCopyOpen(false)}
          onCopied={() => {
            setCopyOpen(false);
            void refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/** One screen's day, in time order. */
function ScreenTimeline({
  screenName,
  shows,
  timezone,
  verdictOf,
  onChanged,
  toast,
}: {
  screenName: string;
  shows: ShowRow[];
  timezone: string;
  verdictOf: (show: ShowRow) => SaleVerdict;
  onChanged: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-background-surface shadow-xs">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <IconTile icon={MonitorPlay} tone="teal" size="sm" />
          <h3 className="truncate font-display text-[0.9375rem] font-bold text-text-primary">
            {screenName}
          </h3>
        </div>
        <span className="shrink-0 text-caption text-text-muted" data-testid="screen-show-count">
          {shows.length} {shows.length === 1 ? 'show' : 'shows'}
        </span>
      </div>
      <ul className="divide-y divide-border">
        {shows.map((show) => (
          <ShowRowItem
            key={show.sessionId}
            show={show}
            timezone={timezone}
            verdict={verdictOf(show)}
            onChanged={onChanged}
            toast={toast}
          />
        ))}
      </ul>
    </section>
  );
}

function ShowRowItem({
  show,
  timezone,
  verdict,
  onChanged,
  toast,
}: {
  show: ShowRow;
  timezone: string;
  verdict: SaleVerdict;
  onChanged: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const actions = availableActions(show, new Date());
  const [cancelling, setCancelling] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pricing, setPricing] = useState(false);
  const at = formatLocalTime(show.startsAt, timezone);
  const film = show.movieTitle ?? 'show';

  /**
   * Every mutation re-reads the day afterwards rather than patching local state.
   *
   * On failure the day is refreshed too: a timeout does not mean the write did not happen,
   * and offering "retry" against an unknown state is how a show gets cancelled twice or a
   * duplicate gets created.
   */
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => onChanged(),
    onError: (e) => {
      toast.push(errorMessage(e));
      onChanged();
    },
  });

  return (
    <li className="grid grid-cols-[4.75rem_minmax(0,1fr)] items-start gap-x-3 gap-y-3 px-4 py-3.5 transition-colors duration-150 hover:bg-background-subtle/60 sm:px-5 xl:grid-cols-[5.5rem_minmax(0,1fr)_auto] xl:items-center xl:gap-x-4">
      <p className="leading-tight">
        <span className="block font-display text-[1.0625rem] font-bold tabular-nums text-text-primary">
          {at}
        </span>
        <span className="text-micro tabular-nums text-text-muted">
          to {formatLocalTime(show.endsAt, timezone)}
        </span>
      </p>
      <div className="min-w-0 space-y-2">
        <p className="break-words text-ui font-semibold text-text-primary">
          {show.movieTitle ?? 'Untitled'}
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {/*
            ONE pill: the server's unified sale state, the answer checkout acts on. It used to
            be "On sale" from the show's status and booking window alone, which said "On sale"
            over a show checkout refused (a Telangana show, an unmapped seat class). The
            server's longer sentence is the pill's title for a pointer user; the words alone
            are enough to act on.
          */}
          <div className="min-w-0" title={verdict.detail ?? undefined}>
            <SalePill verdict={verdict} size="sm" wrap />
          </div>
          <div className="w-full max-w-[11rem]">
            <ProgressMeter
              value={show.seatsSold}
              max={show.seatsTotal}
              size="sm"
              label={`Seats sold, ${film} at ${at}`}
            />
          </div>
        </div>
      </div>

      <div className="col-start-2 flex flex-wrap gap-1.5 xl:col-start-3 xl:justify-end">
        {actions.pause ? (
          <Button
            variant="outline"
            size="sm"
            disabled={run.isPending}
            onClick={() => setPausing(true)}
            aria-label={`Pause sales for ${film} at ${at}`}
          >
            Pause
          </Button>
        ) : null}
        {actions.reopen ? (
          <Button
            variant="tinted"
            size="sm"
            disabled={run.isPending}
            onClick={() => run.mutate(() => api.shows.reopen(show.sessionId))}
            aria-label={`Reopen sales for ${film}`}
          >
            Reopen
          </Button>
        ) : null}
        {actions.edit ? (
          <Button
            variant="outline"
            size="sm"
            disabled={run.isPending}
            onClick={() => setEditing(true)}
            aria-label={`Move ${film} at ${at}`}
          >
            Move
          </Button>
        ) : null}
        {/*
          Offered on any show that has not started. Unlike Move, a sold show can still be
          repriced in the categories that have NOT sold, so the button stays available and
          the dialog explains per category what is fixed.
        */}
        {actions.edit ? (
          <Button
            variant="outline"
            size="sm"
            disabled={run.isPending}
            onClick={() => setPricing(true)}
            aria-label={`Set prices for ${film} at ${at}`}
          >
            Pricing
          </Button>
        ) : null}
        {actions.cancel ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-status-error hover:text-status-error"
            disabled={run.isPending}
            onClick={() => setCancelling(true)}
            aria-label={`Cancel ${film} at ${at}`}
          >
            Cancel
          </Button>
        ) : null}
      </div>

      {editing ? (
        <EditShowDialog
          show={show}
          timezone={timezone}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      ) : null}

      {pricing ? (
        <ShowPricingDialog
          show={show}
          timezone={timezone}
          onClose={() => setPricing(false)}
          onSaved={() => {
            setPricing(false);
            onChanged();
          }}
        />
      ) : null}

      {pausing ? (
        <PauseDialog
          show={show}
          timezone={timezone}
          busy={run.isPending}
          onClose={() => setPausing(false)}
          onConfirm={(reason) => {
            run.mutate(() => api.shows.pause(show.sessionId, reason));
            setPausing(false);
          }}
        />
      ) : null}

      {cancelling ? (
        <CancelDialog
          show={show}
          timezone={timezone}
          busy={run.isPending}
          onClose={() => setCancelling(false)}
          onConfirm={(reason) => {
            run.mutate(async () => {
              const result = await api.shows.cancel(show.sessionId, reason);
              if (result.bookingsRequiringRefund.length) {
                toast.push(
                  `Cancelled. ${result.bookingsRequiringRefund.length} booking(s) need refunding. They have NOT been refunded yet.`,
                );
              }
              return result;
            });
            setCancelling(false);
          }}
        />
      ) : null}
    </li>
  );
}

function PauseDialog({
  show,
  timezone,
  busy,
  onClose,
  onConfirm,
}: {
  show: ShowRow;
  timezone: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason?: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <Dialog open onClose={onClose} title="Pause new ticket sales for this show?">
      <p className="text-sm">
        {show.movieTitle} at {formatLocalTime(show.startsAt, timezone)}.
      </p>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-text-secondary">
        <li>Tickets already sold stay valid. Nobody loses a seat.</li>
        <li>
          Anyone currently in checkout keeps their hold until it expires, so they can finish paying.
        </li>
        <li>The show stays visible to customers, marked as not on sale.</li>
      </ul>
      <div className="mt-4">
        <label htmlFor="pause-reason" className="mb-1 block text-sm font-medium">
          Reason (optional)
        </label>
        <Input
          id="pause-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. projector fault"
        />
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Keep selling
        </Button>
        <Button onClick={() => onConfirm(reason.trim() || undefined)} disabled={busy}>
          Pause sales
        </Button>
      </div>
    </Dialog>
  );
}

/**
 * Cancellation is deliberately harder than every other action.
 *
 * A reason is mandatory, and the dialog states plainly that no money has moved. Implying
 * customers have been refunded when the refund workflow has not run is the single most
 * damaging thing this screen could say.
 */
function CancelDialog({
  show,
  timezone,
  busy,
  onClose,
  onConfirm,
}: {
  show: ShowRow;
  timezone: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const tooShort = reason.trim().length < 3;
  return (
    <Dialog open onClose={onClose} title="Cancel this show?">
      <p className="text-sm">
        {show.movieTitle} at {formatLocalTime(show.startsAt, timezone)}, {show.screenName}.
      </p>
      {show.seatsSold > 0 ? (
        <p className="mt-3 rounded-md border border-status-warning/30 bg-tint-warning p-3 text-sm text-text-primary">
          <strong>{show.seatsSold} seat(s) are already sold.</strong> Cancelling does not refund
          anyone by itself. The affected bookings are handed to the refund process, which runs
          separately. Do not tell customers they have been refunded yet.
        </p>
      ) : null}
      <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-text-secondary">
        <li>Sales stop immediately and unsold seats are released.</li>
        <li>The show and its booking history are kept, not deleted.</li>
        <li>This cannot be undone. Schedule a new show instead.</li>
      </ul>
      <div className="mt-4">
        <label htmlFor="cancel-reason" className="mb-1 block text-sm font-medium">
          Reason (required)
        </label>
        <Textarea
          id="cancel-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. projector failure, print not delivered"
          aria-describedby="cancel-reason-help"
        />
        <p id="cancel-reason-help" className="mt-1 text-xs text-text-muted">
          Recorded in the audit trail and used when explaining the cancellation.
        </p>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Keep this show
        </Button>
        <Button
          variant="secondary"
          onClick={() => onConfirm(reason.trim())}
          disabled={busy || tooShort}
        >
          Cancel show
        </Button>
      </div>
    </Dialog>
  );
}
