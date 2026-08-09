'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  api,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  MetricCard,
  PageHeader,
  Skeleton,
  errorMessage,
  type LiveSeat,
  type OccupancySnapshot,
} from '@eticketsgo/web-kit';
import { OverrideSummary, SeatMap } from './seat-map';
import { SeatOverrideDialog } from './seat-override-dialog';
import {
  formatLocalTime,
  formatMoney,
  freshness,
  isLive,
  occupancyLabel,
  occupancyTone,
} from './seat-presentation';

/**
 * Live cinema operations — today's shows, their occupancy, and the seat map behind each.
 *
 * ── REFRESH ───────────────────────────────────────────────────────────────────────
 * Polling at 15s, matching the events command centre (`POLL_MS = 15_000`). This repository
 * has NO realtime infrastructure — no WebSocket gateway, no SSE — which was verified rather
 * than assumed, and introducing one behind a single dashboard would be a platform decision
 * with its own auth, scaling and reconnect story.
 *
 * A per-second poll would be actively wrong: a fifty-show board would issue three thousand
 * requests a minute to watch numbers that move on the timescale of a booking.
 *
 * ── AUTHORITY ─────────────────────────────────────────────────────────────────────
 * Every number here is computed server-side. Occupancy in particular is NOT recalculated:
 * the API excludes withheld seats from the denominator, and a second implementation here
 * would drift and quietly disagree with every report finance reads.
 */

const POLL_MS = 15_000;

export default function LiveOperationsPage() {
  const { id: cinemaId } = useParams<{ id: string }>();
  const qc = useQueryClient();

  /**
   * The zone the cinema's day is reckoned in.
   *
   * Not the browser's. `Cinema` still carries no timezone column, so this defaults to the
   * India launch market in exactly one place, the same as the scheduling workspace.
   */
  const timezone = 'Asia/Kolkata';

  const [date, setDate] = useState(() =>
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date()),
  );
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [selectedSeat, setSelectedSeat] = useState<LiveSeat | null>(null);

  const cinemaQ = useQuery({
    queryKey: ['cinema', cinemaId],
    queryFn: () => api.cinemas.get(cinemaId),
  });

  // The whole day in ONE request. A busy multiplex has fifty shows, and per-show calls would
  // make this the slowest page in the product.
  const boardQ = useQuery({
    queryKey: ['cinema', cinemaId, 'occupancy', date],
    queryFn: () =>
      api.theaterOps.cinemaOccupancy(
        cinemaId,
        new Date(`${date}T00:00:00Z`).toISOString(),
        new Date(`${date}T23:59:59Z`).toISOString(),
      ),
    refetchInterval: POLL_MS,
  });

  const mapQ = useQuery({
    queryKey: ['show', sessionId, 'live-seat-map'],
    queryFn: () => api.theaterOps.liveSeatMap(sessionId as string),
    enabled: !!sessionId,
    refetchInterval: POLL_MS,
  });

  /** Re-read both after any mutation. Never patch local state. */
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['cinema', cinemaId, 'occupancy'] });
    void qc.invalidateQueries({ queryKey: ['show', sessionId, 'live-seat-map'] });
  };

  const shows = boardQ.data ?? [];
  const now = new Date();
  const selected = shows.find((s) => s.sessionId === sessionId) ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={cinemaQ.data ? `${cinemaQ.data.name} — live operations` : 'Live operations'}
        description="Occupancy, seat states and overrides for shows in progress."
      />

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="ops-date" className="mb-1 block text-sm font-medium">
              Date
            </label>
            <Input
              id="ops-date"
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                setSessionId(null);
              }}
            />
          </div>
          <p className="text-caption text-text-muted">
            Local times at the cinema ({timezone}). Updates every {POLL_MS / 1000}s
            {boardQ.data ? ` · last read ${freshness(new Date().toISOString(), now)}` : ''}.
          </p>
        </div>
      </Card>

      {boardQ.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : boardQ.isError ? (
        <ErrorState message={errorMessage(boardQ.error)} onRetry={() => void boardQ.refetch()} />
      ) : shows.length === 0 ? (
        <EmptyState
          title="No shows on this date"
          hint="Pick another date, or schedule shows from the cinema schedule."
        />
      ) : (
        <>
          <section aria-label="Shows today" className="space-y-2">
            {shows.map((s) => {
              const live = isLive(s, now);
              return (
                <Card key={s.sessionId}>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <span className="w-16 font-mono text-sm tabular-nums">
                      {formatLocalTime(s.startsAt, timezone)}
                    </span>
                    <span className="min-w-[10rem] flex-1 font-medium">
                      {s.movieTitle ?? 'Untitled'}
                    </span>
                    <span className="text-sm text-text-muted">{s.screenName ?? '—'}</span>
                    {live ? <Badge tone="success">On now</Badge> : null}
                    <Badge tone={occupancyTone(s.occupancyPercent)}>
                      {occupancyLabel(s.occupancyPercent)} full
                    </Badge>
                    <span className="text-sm text-text-muted">
                      {s.sold} sold · {s.held} held · {s.blocked} withheld
                    </span>
                    <Button
                      variant={s.sessionId === sessionId ? 'primary' : 'secondary'}
                      aria-pressed={s.sessionId === sessionId}
                      aria-label={`Open seat map for ${s.movieTitle ?? 'show'} at ${formatLocalTime(s.startsAt, timezone)}`}
                      onClick={() => setSessionId(s.sessionId === sessionId ? null : s.sessionId)}
                    >
                      Seat map
                    </Button>
                  </div>
                </Card>
              );
            })}
          </section>

          {selected ? <ShowMetrics snapshot={selected} /> : null}
        </>
      )}

      {sessionId ? (
        <Card title="Live seat map">
          {mapQ.isPending ? (
            <Skeleton className="h-64 w-full" />
          ) : mapQ.isError ? (
            <ErrorState message={errorMessage(mapQ.error)} onRetry={() => void mapQ.refetch()} />
          ) : mapQ.data ? (
            <div className="space-y-4">
              <OverrideSummary map={mapQ.data} />
              <SeatMap
                map={mapQ.data}
                selectedSeatId={selectedSeat?.seatId ?? null}
                onSelect={setSelectedSeat}
              />
            </div>
          ) : null}
        </Card>
      ) : null}

      {selectedSeat && sessionId ? (
        <SeatOverrideDialog
          // Re-read from the freshest map rather than the click-time copy, so a dialog left
          // open across a poll shows what is true now.
          seat={
            mapQ.data?.sections
              .flatMap((s) => s.rows)
              .flatMap((r) => r.seats)
              .find((s) => s.seatId === selectedSeat.seatId) ?? selectedSeat
          }
          sessionId={sessionId}
          timezone={timezone}
          onClose={() => setSelectedSeat(null)}
          onApplied={refresh}
        />
      ) : null}
    </div>
  );
}

/** The counts a duty manager reads at a glance. Every one of them server-computed. */
function ShowMetrics({ snapshot: s }: { snapshot: OccupancySnapshot }) {
  return (
    <section aria-label="Show metrics" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <MetricCard label="Sold" value={String(s.sold)} />
      <MetricCard label="Held" value={String(s.held)} />
      <MetricCard label="Available" value={String(s.available)} />
      <MetricCard label="Withheld" value={String(s.blocked)} />
      <MetricCard label="Occupancy" value={occupancyLabel(s.occupancyPercent)} />
      <MetricCard label="Revenue" value={formatMoney(s.revenueMinor, s.currency)} />
      <MetricCard label="Pending payment" value={formatMoney(s.pendingPaymentMinor, s.currency)} />
      <MetricCard
        label="Sales pace"
        // Null below fifteen minutes of trading: two sales in ninety seconds extrapolates to
        // eighty an hour, and a manager who opens a second screen on that will regret it.
        value={s.salesPacePerHour === null ? '—' : `${s.salesPacePerHour}/hr`}
      />
    </section>
  );
}
