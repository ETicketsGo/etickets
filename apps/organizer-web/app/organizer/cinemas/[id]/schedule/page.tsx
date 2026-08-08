'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  api,
  Badge,
  Button,
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
  formatLocalTime,
  groupByScreen,
  occupancyPercent,
  presentShow,
  shiftDate,
  todayLabel,
} from './show-status';
import { BulkScheduler } from './bulk-scheduler';
import { CopyScheduleDialog } from './copy-schedule';

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

  const [date, setDate] = useState(todayLabel());
  const [screenFilter, setScreenFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [bulkOpen, setBulkOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);

  /**
   * The zone the cinema's day is reckoned in.
   *
   * NOT the browser's zone, which is what this used to be and was wrong: a Hyderabad
   * theater operated by someone travelling in London must still show the Hyderabad day, and
   * a 09:00 show would otherwise slide onto the previous date. It is also not fixed-offset
   * arithmetic — the IANA name is sent and the server resolves it, so DST markets stay
   * correct.
   *
   * Defaulted to the India launch market because `Cinema` carries no timezone column yet.
   * That is a real gap: a chain operating across zones needs it per venue, and this is the
   * one place that will need changing when the column exists.
   */
  const timezone = 'Asia/Kolkata';

  const cinemaQ = useQuery({
    queryKey: ['cinema', cinemaId],
    queryFn: () => api.cinemas.get(cinemaId),
  });
  const screensQ = useQuery({
    queryKey: ['cinema', cinemaId, 'screens'],
    queryFn: () => api.cinemas.screens(cinemaId),
  });
  const scheduleQ = useQuery({
    queryKey: ['cinema', cinemaId, 'schedule', date, timezone],
    queryFn: () => api.shows.cinemaSchedule(cinemaId, date, timezone),
  });

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
          <div className="flex gap-2" role="group" aria-label="Change date">
            <Button variant="secondary" onClick={() => setDate(shiftDate(date, -1))}>
              ← Prev
            </Button>
            <Button variant="secondary" onClick={() => setDate(todayLabel())}>
              Today
            </Button>
            <Button variant="secondary" onClick={() => setDate(shiftDate(date, 1))}>
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
      </Card>

      {scheduleQ.isPending ? (
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
          hint="Add a screen to this cinema before scheduling shows."
        />
      ) : (
        <div className="space-y-4">
          {screens.map((group) => (
            <ScreenTimeline
              key={group.screenId}
              screenName={group.screenName}
              shows={group.shows}
              cinemaId={cinemaId}
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
  onChanged,
  toast,
}: {
  screenName: string;
  shows: ShowRow[];
  cinemaId: string;
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
          <ShowRowItem key={show.sessionId} show={show} onChanged={onChanged} toast={toast} />
        ))}
      </ul>
    </Card>
  );
}

function ShowRowItem({
  show,
  onChanged,
  toast,
}: {
  show: ShowRow;
  onChanged: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const presentation = presentShow(show.status);
  const actions = availableActions(show, new Date());
  const occupancy = occupancyPercent(show);
  const [cancelling, setCancelling] = useState(false);
  const [pausing, setPausing] = useState(false);

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
        {formatLocalTime(show.startsAt)} – {formatLocalTime(show.endsAt)}
      </span>
      <span className="min-w-[10rem] flex-1 font-medium">{show.movieTitle ?? 'Untitled'}</span>

      {/* Text alongside the badge: state is never carried by colour alone. */}
      {/*
        The label is real text inside the badge, not a colour swatch, so status survives
        greyscale, colour-blindness and a screen reader. No duplicate sr-only copy — that
        made assistive tech announce the status twice.
      */}
      <span className="flex items-center gap-2">
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
            aria-label={`Pause sales for ${show.movieTitle ?? 'show'} at ${formatLocalTime(show.startsAt)}`}
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
        {actions.cancel ? (
          <Button
            variant="secondary"
            disabled={run.isPending}
            onClick={() => setCancelling(true)}
            aria-label={`Cancel ${show.movieTitle ?? 'show'} at ${formatLocalTime(show.startsAt)}`}
          >
            Cancel
          </Button>
        ) : null}
      </span>

      {pausing ? (
        <PauseDialog
          show={show}
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
  busy,
  onClose,
  onConfirm,
}: {
  show: ShowRow;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason?: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <Dialog open onClose={onClose} title="Pause new ticket sales for this show?">
      <p className="text-sm">
        {show.movieTitle} at {formatLocalTime(show.startsAt)}.
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
  busy,
  onClose,
  onConfirm,
}: {
  show: ShowRow;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const tooShort = reason.trim().length < 3;
  return (
    <Dialog open onClose={onClose} title="Cancel this show?">
      <p className="text-sm">
        {show.movieTitle} at {formatLocalTime(show.startsAt)} — {show.screenName}.
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
