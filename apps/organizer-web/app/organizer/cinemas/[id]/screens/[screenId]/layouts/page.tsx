'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  api,
  Badge,
  ButtonLink,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorState,
  Input,
  PageHeader,
  Skeleton,
  dateTime,
  errorMessage,
  type BadgeTone,
  type SeatLayoutStatus,
  type SeatLayoutSummary,
} from '@eticketsgo/web-kit';

/**
 * Seat layout versions for one screen.
 *
 * Sits alongside the existing seat-map designer rather than replacing it: the designer draws
 * a room, this page manages the LIFECYCLE of the rooms a screen has had. Published versions
 * are read-only here and in the API, because sold tickets point at their seats.
 */

const STATUS_TONE: Record<SeatLayoutStatus, BadgeTone> = {
  DRAFT: 'warning',
  PUBLISHED: 'success',
  ARCHIVED: 'neutral',
};

const STATUS_HINT: Record<SeatLayoutStatus, string> = {
  DRAFT: 'Editable. Not visible to scheduling until published.',
  PUBLISHED: 'Frozen. Shows can be scheduled against it.',
  ARCHIVED: 'Retired. Existing shows keep working — they hold their own seats.',
};

export default function SeatLayoutsPage() {
  const { id: cinemaId, screenId } = useParams<{ id: string; screenId: string }>();
  const qc = useQueryClient();

  const [publishing, setPublishing] = useState<SeatLayoutSummary | null>(null);
  const [archiving, setArchiving] = useState<SeatLayoutSummary | null>(null);
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [compareTo, setCompareTo] = useState<string | null>(null);

  const layoutsQ = useQuery({
    queryKey: ['screen', screenId, 'layouts'],
    queryFn: () => api.theaterOps.layouts(screenId),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['screen', screenId, 'layouts'] });

  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => {
      refresh();
      setPublishing(null);
      setArchiving(null);
      setError(null);
    },
    // Refusals here carry a policy code and a written explanation; showing the server's
    // sentence is better than inventing one that may not match the actual rule.
    onError: (e) => setError(errorMessage(e)),
  });

  const layouts = layoutsQ.data ?? [];
  const now = new Date();
  const activeId = activeVersion(layouts, now)?.id ?? null;

  const compareQ = useQuery({
    queryKey: ['layout-compare', compareTo],
    queryFn: () => {
      const to = layouts.find((l) => l.id === compareTo)!;
      const from = layouts.find((l) => l.id === to.clonedFromId)!;
      return api.theaterOps.compareLayouts(from.id, to.id);
    },
    enabled: !!compareTo && !!layouts.find((l) => l.id === compareTo)?.clonedFromId,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Seat layout versions"
        description="Clone, edit and publish the seating for this screen. Published versions are frozen."
        action={
          <Button variant="outline" onClick={() => history.back()}>
            Back to screen
          </Button>
        }
      />

      <Card>
        <p className="text-sm text-text-secondary">
          A published layout is never edited in place — sold tickets and issued seats point at its
          rows. To change the room, clone the current version, edit the draft, then publish it.
          Publishing with a future date leaves tonight&rsquo;s shows exactly as they are.
        </p>
      </Card>

      {layoutsQ.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : layoutsQ.isError ? (
        <ErrorState
          message={errorMessage(layoutsQ.error)}
          onRetry={() => void layoutsQ.refetch()}
        />
      ) : layouts.length === 0 ? (
        <EmptyState
          title="This screen has no seat layout yet"
          hint="Until it has one, this screen cannot hold a show — there are no seats to sell."
          action={
            <ButtonLink href={`/organizer/cinemas/${cinemaId}/screens/${screenId}/seatmap`}>
              Design the seat layout
            </ButtonLink>
          }
        />
      ) : (
        <ul className="space-y-3">
          {layouts.map((l) => (
            /* One unambiguous boundary per version, so an assertion about v1 cannot
               accidentally match v2's badge. */
            <li key={l.id} data-testid={`layout-${l.version}`}>
              <Card>
                <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
                  <span className="font-mono text-sm font-semibold tabular-nums">v{l.version}</span>
                  <span className="min-w-[8rem] flex-1">
                    <span className="font-medium">{l.name ?? 'Layout'}</span>
                    <span className="block text-caption text-text-muted">
                      {STATUS_HINT[l.status]}
                    </span>
                  </span>

                  <Badge tone={STATUS_TONE[l.status]}>{l.status}</Badge>
                  {l.id === activeId ? <Badge tone="info">Active today</Badge> : null}
                  {isFuture(l, now) ? (
                    <Badge tone="warning">Starts {dateTime(l.effectiveFrom as string)}</Badge>
                  ) : null}

                  <span className="text-sm text-text-muted">
                    {l.capacity} seats
                    {l.futureShows > 0
                      ? ` · ${l.futureShows} upcoming show${l.futureShows === 1 ? '' : 's'}`
                      : ''}
                    {l.historicalShows > 0 ? ` · ${l.historicalShows} played` : ''}
                  </span>

                  <span className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      disabled={run.isPending}
                      aria-label={`Clone version ${l.version} as a new draft`}
                      onClick={() => run.mutate(() => api.theaterOps.cloneLayout(l.id))}
                    >
                      Clone
                    </Button>
                    {l.status === 'DRAFT' ? (
                      <Button
                        disabled={run.isPending}
                        aria-label={`Publish version ${l.version}`}
                        onClick={() => {
                          setEffectiveFrom('');
                          setError(null);
                          setPublishing(l);
                        }}
                      >
                        Publish
                      </Button>
                    ) : null}
                    {l.status === 'PUBLISHED' ? (
                      <Button
                        variant="secondary"
                        disabled={run.isPending}
                        aria-label={`Archive version ${l.version}`}
                        onClick={() => {
                          setError(null);
                          setArchiving(l);
                        }}
                      >
                        Archive
                      </Button>
                    ) : null}
                    {l.clonedFromId ? (
                      <Button
                        variant="outline"
                        aria-label={`Compare version ${l.version} with the version it was cloned from`}
                        onClick={() => setCompareTo(compareTo === l.id ? null : l.id)}
                      >
                        Compare
                      </Button>
                    ) : null}
                  </span>
                </div>

                {compareTo === l.id ? (
                  <div className="mt-3 border-t border-border pt-3">
                    {compareQ.isPending ? (
                      <Skeleton className="h-16 w-full" />
                    ) : compareQ.data ? (
                      <Comparison data={compareQ.data} />
                    ) : null}
                  </div>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}

      {error && !publishing && !archiving ? (
        <p role="alert" className="rounded-md bg-status-error/10 p-3 text-sm">
          {error}
        </p>
      ) : null}

      {publishing ? (
        <Dialog
          open
          onClose={() => setPublishing(null)}
          title={`Publish v${publishing.version}`}
          footer={
            <>
              <Button
                variant="outline"
                onClick={() => setPublishing(null)}
                disabled={run.isPending}
              >
                Cancel
              </Button>
              <Button
                loading={run.isPending}
                onClick={() =>
                  run.mutate(() =>
                    api.theaterOps.publishLayout(
                      publishing.id,
                      effectiveFrom ? new Date(effectiveFrom).toISOString() : undefined,
                    ),
                  )
                }
              >
                Publish
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <p className="text-sm">
              Publishing freezes this version. It cannot be edited afterwards — to change it again,
              clone it.
            </p>
            <div>
              <label htmlFor="eff-from" className="mb-1 block text-sm font-medium">
                Takes effect from (optional)
              </label>
              <Input
                id="eff-from"
                type="datetime-local"
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
              />
              <p className="mt-1 text-caption text-text-muted">
                Leave blank to take effect immediately. A future date applies only to shows
                scheduled to start on or after it — shows already on the schedule keep the layout
                they were built against.
              </p>
            </div>
            {error ? (
              <p role="alert" className="rounded-md bg-status-error/10 p-3 text-sm">
                {error}
              </p>
            ) : null}
          </div>
        </Dialog>
      ) : null}

      {archiving ? (
        <Dialog
          open
          onClose={() => setArchiving(null)}
          title={`Archive v${archiving.version}`}
          footer={
            <>
              <Button variant="outline" onClick={() => setArchiving(null)} disabled={run.isPending}>
                Cancel
              </Button>
              <Button
                loading={run.isPending}
                onClick={() => run.mutate(() => api.theaterOps.archiveLayout(archiving.id))}
              >
                Archive version
              </Button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <p>
              Archiving retires this version from new scheduling. It is never deleted, and shows
              already using it keep working — they hold their own seats.
            </p>
            {archiving.futureShows > 0 ? (
              <p role="alert" className="rounded-md bg-status-warning/10 p-3">
                {archiving.futureShows} upcoming show
                {archiving.futureShows === 1 ? '' : 's'} still use this layout. The server will
                refuse until they are rescheduled or cancelled.
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="rounded-md bg-status-error/10 p-3">
                {error}
              </p>
            ) : null}
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

/**
 * The version in effect right now.
 *
 * Mirrors the server's rule — latest published whose effective date has passed — purely to
 * label a row. Scheduling never uses this; the API decides.
 */
function activeVersion(layouts: SeatLayoutSummary[], now: Date): SeatLayoutSummary | null {
  const candidates = layouts
    .filter((l) => l.status === 'PUBLISHED')
    .filter((l) => new Date(l.effectiveFrom ?? l.publishedAt ?? l.createdAt) <= now);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, l) =>
    new Date(l.effectiveFrom ?? l.publishedAt ?? l.createdAt) >
    new Date(best.effectiveFrom ?? best.publishedAt ?? best.createdAt)
      ? l
      : best,
  );
}

function isFuture(l: SeatLayoutSummary, now: Date): boolean {
  return l.status === 'PUBLISHED' && !!l.effectiveFrom && new Date(l.effectiveFrom) > now;
}

/** What changed between a draft and the version it came from. */
function Comparison({ data }: { data: import('@eticketsgo/web-kit').LayoutComparison }) {
  const nothing =
    data.addedSeats.length === 0 &&
    data.removedSeats.length === 0 &&
    data.changedSeats.length === 0;

  return (
    <div className="space-y-2 text-sm">
      <p className="font-medium">
        v{data.from.version} → v{data.to.version}
      </p>
      {nothing ? (
        <p className="text-text-muted">Identical to the version it was cloned from.</p>
      ) : (
        <ul className="space-y-1 text-text-secondary">
          {data.addedSeats.length > 0 ? (
            <li>Added: {data.addedSeats.map((s) => s.seat).join(', ')}</li>
          ) : null}
          {data.removedSeats.length > 0 ? (
            <li>Removed: {data.removedSeats.map((s) => s.seat).join(', ')}</li>
          ) : null}
          {data.changedSeats.map((s) => (
            <li key={s.seat}>
              {s.seat}: {s.from?.categoryName}/{s.from?.kind} → {s.to?.categoryName}/{s.to?.kind}
            </li>
          ))}
        </ul>
      )}
      <p className="text-caption text-text-muted">
        Capacity change: {data.capacityDelta > 0 ? '+' : ''}
        {data.capacityDelta} · {data.unchangedCount} seats unchanged
      </p>
    </div>
  );
}
