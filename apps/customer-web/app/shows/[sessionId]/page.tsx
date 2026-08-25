'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { MonitorPlay, Armchair, X, Clock } from 'lucide-react';
import { useToast } from '@eticketsgo/web-kit';
import { api, tokenStore, ApiRequestError, type SeatLayout } from '@/lib/api';
import { money } from '@/lib/format';
import { Button, Card, EmptyState, ErrorState } from '@/components/ui';

const MAX_SEATS = 10;

/**
 * Pick a readable foreground for a selected seat filled with an arbitrary
 * category swatch, so selection never relies on a fixed `text-white` that may
 * be invisible on a light swatch. Uses perceived (Rec. 601) luminance and
 * returns design-token colours.
 */
function readableTextOn(hex?: string): string {
  if (!hex) return 'var(--action-primary-foreground)';
  const raw = hex.replace('#', '');
  const full =
    raw.length === 3
      ? raw
          .split('')
          .map((c) => c + c)
          .join('')
      : raw;
  if (full.length < 6) return 'var(--action-primary-foreground)';
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? 'var(--text-primary)' : '#ffffff';
}

export default function SeatSelectionPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const router = useRouter();
  const toast = useToast();

  const {
    data: layout,
    isLoading,
    isError,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ['seats', sessionId],
    queryFn: () => api.showSeats(sessionId),
  });

  // Selected seat ids.
  const [selected, setSelected] = useState<string[]>([]);

  // Fast lookup: seatId → its seat record; and categoryId → category.
  const seatsById = useMemo(() => {
    const map = new Map<string, SeatLayout['sections'][number]['rows'][number]['seats'][number]>();
    layout?.sections.forEach((sec) =>
      sec.rows.forEach((row) => row.seats.forEach((seat) => map.set(seat.id, seat))),
    );
    return map;
  }, [layout]);

  const categoriesById = useMemo(() => {
    const map = new Map<string, SeatLayout['categories'][number]>();
    layout?.categories.forEach((c) => map.set(c.id, c));
    return map;
  }, [layout]);

  const toggle = (seatId: string, status: string) => {
    if (status !== 'AVAILABLE') return;
    setSelected((prev) => {
      if (prev.includes(seatId)) return prev.filter((s) => s !== seatId);
      if (prev.length >= MAX_SEATS) {
        toast.push(`You can select up to ${MAX_SEATS} seats.`, 'warning');
        return prev;
      }
      return [...prev, seatId];
    });
  };

  // Group the current selection by seat category for the summary + booking items.
  const grouped = useMemo(() => {
    const byCat = new Map<string, { seatIds: string[]; labels: string[] }>();
    for (const id of selected) {
      const seat = seatsById.get(id);
      if (!seat) continue;
      const entry = byCat.get(seat.categoryId) ?? { seatIds: [], labels: [] };
      entry.seatIds.push(id);
      entry.labels.push(seat.label);
      byCat.set(seat.categoryId, entry);
    }
    return byCat;
  }, [selected, seatsById]);

  const total = useMemo(() => {
    let sum = 0;
    grouped.forEach((entry, catId) => {
      const cat = categoriesById.get(catId);
      if (cat) sum += cat.priceMinor * entry.seatIds.length;
    });
    return sum;
  }, [grouped, categoriesById]);

  const book = useMutation({
    mutationFn: async () => {
      if (!tokenStore.access) {
        router.push(`/login?next=/shows/${sessionId}`);
        throw new Error('login');
      }
      const me = await api.me();
      const items = Array.from(grouped.entries())
        .map(([catId, entry]) => {
          const cat = categoriesById.get(catId);
          if (!cat) return null;
          return {
            ticketTypeId: cat.ticketTypeId,
            quantity: entry.seatIds.length,
            seatIds: entry.seatIds,
          };
        })
        .filter(Boolean) as {
        ticketTypeId: string;
        quantity: number;
        seatIds: string[];
      }[];
      return api.createBooking({
        eventSessionId: sessionId,
        items,
        buyerName: me.fullName,
        buyerEmail: me.email,
      });
    },
    onSuccess: (booking) => router.push(`/booking/${booking.id}/payment`),
    onError: (e) => {
      if ((e as Error).message === 'login') return;
      // A seat may have been taken between load and submit — reset + refetch.
      toast.push(
        e instanceof ApiRequestError ? e.message : 'Some seats were just taken. Please pick again.',
        'error',
      );
      setSelected([]);
      refetch();
    },
  });

  if (isLoading) return <div className="h-96 animate-pulse rounded-lg bg-background-subtle" />;
  if (isError)
    return (
      <ErrorState
        message="We couldn't load the seat map. Please try again."
        onRetry={() => refetch()}
      />
    );
  if (!layout)
    return (
      <EmptyState title="Seat map unavailable" hint="This show has no seat map." icon={Armchair} />
    );

  const hasSeats = layout.sections.some((s) => s.rows.some((r) => r.seats.length > 0));
  const hasSold = layout.sections.some((s) =>
    s.rows.some((r) => r.seats.some((seat) => seat.status === 'SOLD')),
  );
  const hasHeld = layout.sections.some((s) =>
    s.rows.some((r) => r.seats.some((seat) => seat.status === 'HELD')),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-h2 font-bold tracking-tight text-text-primary">Select seats</h1>
        <p className="mt-1.5 text-[0.9375rem] text-text-muted">
          Tap available seats to add them to your booking.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Seat map */}
        <div className="lg:col-span-2">
          <Card>
            {!hasSeats ? (
              <EmptyState
                title="No seats to show"
                hint="This show doesn't have a seat layout yet."
                icon={Armchair}
              />
            ) : (
              <div className="space-y-8">
                {/* Screen indicator */}
                <div className="mx-auto max-w-xl">
                  <div className="mx-auto h-2 w-3/4 rounded-t-[100%] bg-gradient-to-b from-action-primary/40 to-transparent" />
                  <p className="mt-1 flex items-center justify-center gap-2 text-caption font-medium uppercase tracking-widest text-text-muted">
                    <MonitorPlay className="h-3.5 w-3.5" />
                    Screen this way
                  </p>
                </div>

                {/* Sections */}
                <div className="space-y-6 overflow-x-auto">
                  {layout.sections.map((section) => (
                    <div key={section.name}>
                      <p className="mb-2 text-caption font-semibold uppercase tracking-wide text-text-muted">
                        {section.name}
                      </p>
                      <div className="space-y-1.5">
                        {section.rows.map((row) => {
                          const sorted = [...row.seats].sort((a, b) => a.colIndex - b.colIndex);
                          return (
                            <div key={row.label} className="flex items-center gap-2">
                              <span className="w-6 shrink-0 text-center text-caption font-medium text-text-muted">
                                {row.label}
                              </span>
                              <div className="flex gap-1.5">
                                {sorted.map((seat, i) => {
                                  // Insert an aisle gap where column indices jump.
                                  const gap =
                                    i > 0 ? seat.colIndex - sorted[i - 1].colIndex - 1 : 0;
                                  const cat = categoriesById.get(seat.categoryId);
                                  const color = cat?.colorHex ?? undefined;
                                  const isSelected = selected.includes(seat.id);
                                  const available = seat.status === 'AVAILABLE';
                                  const priceLabel = cat ? money(cat.priceMinor) : '';
                                  return (
                                    <span key={seat.id} className="flex">
                                      {gap > 0 && (
                                        <span
                                          aria-hidden
                                          style={{ width: `${Math.min(gap, 3) * 0.75}rem` }}
                                        />
                                      )}
                                      <button
                                        type="button"
                                        disabled={!available}
                                        aria-pressed={isSelected}
                                        /*
                                          The ROW is part of the seat's name.

                                          `seat.label` is only the number within the row, so
                                          the accessible name was "Seat 1" for the first seat
                                          of every row — A1 and B1 announced identically, and
                                          a screen-reader user had no way to tell which row
                                          they were in. The visible grid conveys it by
                                          position, which conveys nothing to a screen reader.
                                        */
                                        aria-label={`Seat ${row.label}${seat.label}${priceLabel ? `, ${priceLabel}` : ''}, ${seat.status.toLowerCase()}`}
                                        onClick={() => toggle(seat.id, seat.status)}
                                        title={`${row.label}${seat.label}${cat ? ` · ${cat.name}` : ''}`}
                                        style={
                                          available && !isSelected && color
                                            ? { borderColor: color, color }
                                            : isSelected && color
                                              ? {
                                                  backgroundColor: color,
                                                  borderColor: color,
                                                  color: readableTextOn(color),
                                                }
                                              : undefined
                                        }
                                        className={`flex h-9 w-9 items-center justify-center rounded-md border text-[0.625rem] font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 sm:h-7 sm:w-7 ${
                                          !available
                                            ? 'cursor-not-allowed border-border bg-background-subtle text-text-muted/60'
                                            : isSelected
                                              ? 'bg-action-primary text-action-primary-foreground ring-2 ring-action-primary ring-offset-1 ring-offset-background-surface hover:scale-110'
                                              : 'bg-background-surface hover:scale-110'
                                        }`}
                                      >
                                        {available ? (
                                          seat.label.replace(/^[A-Za-z]+/, '')
                                        ) : seat.status === 'SOLD' ? (
                                          <X className="h-3.5 w-3.5" aria-hidden />
                                        ) : (
                                          <Clock className="h-3 w-3" aria-hidden />
                                        )}
                                      </button>
                                    </span>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Legend — status is conveyed by shape/icon, not colour alone. */}
                <div className="space-y-3 border-t border-border pt-4 text-caption text-text-secondary">
                  {/* Available seats, by price tier */}
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                    <span className="font-medium text-text-muted">Available</span>
                    {layout.categories.map((c) => (
                      <span key={c.id} className="flex items-center gap-1.5">
                        <span
                          className="h-3.5 w-3.5 rounded border"
                          style={{
                            borderColor: c.colorHex ?? 'var(--border)',
                            backgroundColor: c.colorHex ? `${c.colorHex}22` : undefined,
                          }}
                        />
                        {c.name} · {money(c.priceMinor)}
                      </span>
                    ))}
                  </div>
                  {/* Selection & unavailable states, each with a non-colour affordance */}
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block h-3.5 w-3.5 rounded bg-action-primary ring-2 ring-action-primary ring-offset-1 ring-offset-background-surface" />
                      Selected
                    </span>
                    {hasSold && (
                      <span className="flex items-center gap-1.5">
                        <span className="flex h-3.5 w-3.5 items-center justify-center rounded border border-border bg-background-subtle text-text-muted/60">
                          <X className="h-2.5 w-2.5" aria-hidden />
                        </span>
                        Sold
                      </span>
                    )}
                    {hasHeld && (
                      <span className="flex items-center gap-1.5">
                        <span className="flex h-3.5 w-3.5 items-center justify-center rounded border border-border bg-background-subtle text-text-muted/60">
                          <Clock className="h-2.5 w-2.5" aria-hidden />
                        </span>
                        Held
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}
          </Card>
        </div>

        {/* Summary */}
        <div className="lg:sticky lg:top-24 lg:h-fit">
          <Card>
            <div className="mb-4 flex items-center gap-2">
              <Armchair className="h-5 w-5 text-action-primary" />
              <h2 className="text-title font-semibold text-text-primary">Your seats</h2>
            </div>

            {selected.length === 0 ? (
              <p className="text-[0.9375rem] text-text-muted">
                No seats selected yet. Pick seats from the map.
              </p>
            ) : (
              <div className="space-y-3">
                {Array.from(grouped.entries()).map(([catId, entry]) => {
                  const cat = categoriesById.get(catId);
                  return (
                    <div key={catId} className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium text-text-primary">{cat?.name ?? 'Seats'}</p>
                        <p className="text-caption text-text-muted">
                          {[...entry.labels].sort().join(', ')}
                        </p>
                      </div>
                      <span className="whitespace-nowrap text-[0.9375rem] text-text-secondary">
                        {money((cat?.priceMinor ?? 0) * entry.seatIds.length)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="mt-4 border-t border-border pt-4">
              <div className="flex items-center justify-between">
                <span className="text-[0.9375rem] text-text-secondary">
                  Total ({selected.length} seat{selected.length === 1 ? '' : 's'})
                </span>
                <span className="text-title font-bold text-text-primary">{money(total)}</span>
              </div>
              <p className="mt-1 text-caption text-text-muted">
                Transparent fees shown on the next step.
              </p>
            </div>

            <Button
              className="mt-4 w-full"
              loading={book.isPending}
              disabled={selected.length === 0 || book.isPending || isFetching}
              onClick={() => book.mutate()}
            >
              {book.isPending ? 'Holding seats…' : 'Proceed to pay'}
            </Button>
          </Card>
        </div>
      </div>
    </div>
  );
}
