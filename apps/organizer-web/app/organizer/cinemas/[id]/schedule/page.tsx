'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  api,
  Badge,
  Button,
  ButtonLink,
  Card,
  Dialog,
  EmptyState,
  ErrorState,
  Input,
  Select,
  Skeleton,
  Textarea,
  PageHeader,
  useToast,
  errorMessage,
  type ShowRow,
} from '@eticketsgo/web-kit';
import {
  availableActions,
  effectiveShowBadge,
  formatLocalTime,
  groupByScreen,
  occupancyPercent,
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
  const refresh = () => qc.invalidateQueries({ queryKey: ['cinema', cinemaId, 'schedule'] });

  const rows = scheduleQ.data ?? [];
  const filtered = rows.filter(
    (r) =>
      (!screenFilter || r.screenId === screenFilter) &&
      (!statusFilter || r.status.toUpperCase() === statusFilter),
  );
  const screens = groupByScreen(filtered);

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
  return (
    <div className="space-y-6">
      <PageHeader
        title={cinemaQ.data ? `${cinemaQ.data.name} — schedule` : 'Schedule'}
        description="Plan and operate this cinema's screens."
        action={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setCopyOpen(true)}>
              Copy schedule
            </Button>
            <Button onClick={() => setBulkOpen(true)}>Create shows</Button>
          </div>
        }
      />

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="schedule-date" className="mb-1 block text-sm font-medium">
              Date
            </label>
            <Input
              id="schedule-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="flex gap-2" role="group" aria-label="Schedule view">
            <Button
              variant={mode === 'day' ? 'primary' : 'secondary'}
              aria-pressed={mode === 'day'}
              onClick={() => setMode('day')}
            >
              Day
            </Button>
            <Button
              variant={mode === 'week' ? 'primary' : 'secondary'}
              aria-pressed={mode === 'week'}
              onClick={() => setMode('week')}
            >
              Week
            </Button>
          </div>
          <div className="flex gap-2" role="group" aria-label="Change date">
            <Button
              variant="secondary"
              onClick={() => setDate(shiftDate(date, mode === 'week' ? -7 : -1))}
              aria-label={mode === 'week' ? 'Previous week' : 'Previous day'}
            >
              ← Prev
            </Button>
            <Button variant="secondary" onClick={() => setDate(todayLabel(timezone))}>
              Today
            </Button>
            <Button
              variant="secondary"
              onClick={() => setDate(shiftDate(date, mode === 'week' ? 7 : 1))}
              aria-label={mode === 'week' ? 'Next week' : 'Next day'}
            >
              Next →
            </Button>
          </div>
          <div>
            <label htmlFor="screen-filter" className="mb-1 block text-sm font-medium">
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
          <div>
            <label htmlFor="status-filter" className="mb-1 block text-sm font-medium">
              Status
            </label>
            <Select
              id="status-filter"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">All statuses</option>
              <option value="SCHEDULED">On sale</option>
              <option value="PAUSED">Sales paused</option>
              <option value="CANCELLED">Cancelled</option>
            </Select>
          </div>
        </div>

        {/*
          State the clock being used. Every date and time on this page is local to the venue,
          and an operator working across cinemas has no other way to tell which one they are
          reading — the difference between a Hyderabad and a Sydney day is not visible from
          the numbers alone.
        */}
        <p className="mt-3 text-caption text-text-muted">
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
        <div className="space-y-3" aria-busy="true" aria-label="Loading schedule">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
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
          {screens.map((group) => (
            <ScreenTimeline
              key={group.screenId}
              screenName={group.screenName}
              shows={group.shows}
              timezone={timezone}
              onChanged={refresh}
              toast={toast}
            />
          ))}
          {emptyScreens.map((s) => (
            <Card key={s.id}>
              <h3 className="text-base font-semibold">{s.name}</h3>
              <p className="mt-1 text-sm text-slate-500">
                Nothing scheduled on this date.
                {s.status && s.status !== 'ACTIVE'
                  ? ` This screen is ${s.status.toLowerCase()} and cannot take new shows.`
                  : ''}
              </p>
            </Card>
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
  onChanged,
  toast,
}: {
  screenName: string;
  shows: ShowRow[];
  timezone: string;
  onChanged: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  return (
    <Card>
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-base font-semibold">{screenName}</h3>
        <span className="text-sm text-slate-500" data-testid="screen-show-count">
          {shows.length} {shows.length === 1 ? 'show' : 'shows'}
        </span>
      </div>
      <ul className="divide-y divide-slate-200">
        {shows.map((show) => (
          <ShowRowItem
            key={show.sessionId}
            show={show}
            timezone={timezone}
            onChanged={onChanged}
            toast={toast}
          />
        ))}
      </ul>
    </Card>
  );
}

function ShowRowItem({
  show,
  timezone,
  onChanged,
  toast,
}: {
  show: ShowRow;
  timezone: string;
  onChanged: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const presentation = effectiveShowBadge(show, new Date(), timezone);
  const actions = availableActions(show, new Date());
  const occupancy = occupancyPercent(show);
  const [cancelling, setCancelling] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pricing, setPricing] = useState(false);

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
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <span className="w-32 font-mono text-sm tabular-nums">
        {formatLocalTime(show.startsAt, timezone)} – {formatLocalTime(show.endsAt, timezone)}
      </span>
      <span className="min-w-[10rem] flex-1 font-medium">{show.movieTitle ?? 'Untitled'}</span>

      {/* Text alongside the badge: state is never carried by colour alone. */}
      {/*
        The label is real text inside the badge, not a colour swatch, so status survives
        greyscale, colour-blindness and a screen reader. No duplicate sr-only copy — that
        made assistive tech announce the status twice.
      */}
      {/*
        ONE badge, carrying the booking window as well as the lifecycle. A show can be
        perfectly SCHEDULED and still unsellable because its window has not opened or has
        already closed, and an operator reading "On sale" while customers are turned away
        has been told the wrong thing. `title` carries the explanation for a pointer user;
        the label alone is enough to act on.
      */}
      <span className="flex items-center gap-2" title={presentation.hint}>
        <Badge tone={presentation.tone}>{presentation.label}</Badge>
      </span>

      <span className="w-32 text-sm text-slate-500">
        {show.seatsTotal > 0 ? (
          <>
            {show.seatsSold}/{show.seatsTotal} sold
            {occupancy !== null ? ` (${occupancy}%)` : ''}
          </>
        ) : (
          '—'
        )}
      </span>

      <span className="flex gap-2">
        {actions.pause ? (
          <Button
            variant="secondary"
            disabled={run.isPending}
            onClick={() => setPausing(true)}
            aria-label={`Pause sales for ${show.movieTitle ?? 'show'} at ${formatLocalTime(show.startsAt, timezone)}`}
          >
            Pause
          </Button>
        ) : null}
        {actions.reopen ? (
          <Button
            variant="secondary"
            disabled={run.isPending}
            onClick={() => run.mutate(() => api.shows.reopen(show.sessionId))}
            aria-label={`Reopen sales for ${show.movieTitle ?? 'show'}`}
          >
            Reopen
          </Button>
        ) : null}
        {actions.edit ? (
          <Button
            variant="secondary"
            disabled={run.isPending}
            onClick={() => setEditing(true)}
            aria-label={`Move ${show.movieTitle ?? 'show'} at ${formatLocalTime(show.startsAt, timezone)}`}
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
            variant="secondary"
            disabled={run.isPending}
            onClick={() => setPricing(true)}
            aria-label={`Set prices for ${show.movieTitle ?? 'show'} at ${formatLocalTime(show.startsAt, timezone)}`}
          >
            Pricing
          </Button>
        ) : null}
        {actions.cancel ? (
          <Button
            variant="secondary"
            disabled={run.isPending}
            onClick={() => setCancelling(true)}
            aria-label={`Cancel ${show.movieTitle ?? 'show'} at ${formatLocalTime(show.startsAt, timezone)}`}
          >
            Cancel
          </Button>
        ) : null}
      </span>

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
                  `Cancelled. ${result.bookingsRequiringRefund.length} booking(s) need refunding — they have NOT been refunded yet.`,
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
      <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-600">
        <li>Tickets already sold stay valid — nobody loses a seat.</li>
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
        {show.movieTitle} at {formatLocalTime(show.startsAt, timezone)} — {show.screenName}.
      </p>
      {show.seatsSold > 0 ? (
        <p className="mt-3 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
          <strong>{show.seatsSold} seat(s) are already sold.</strong> Cancelling does not refund
          anyone by itself. The affected bookings are handed to the refund process, which runs
          separately — do not tell customers they have been refunded yet.
        </p>
      ) : null}
      <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-600">
        <li>Sales stop immediately and unsold seats are released.</li>
        <li>The show and its booking history are kept, not deleted.</li>
        <li>This cannot be undone — schedule a new show instead.</li>
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
        <p id="cancel-reason-help" className="mt-1 text-xs text-slate-500">
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
