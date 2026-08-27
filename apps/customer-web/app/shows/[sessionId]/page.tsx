'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { MonitorPlay, Armchair, X, Clock, ChevronLeft, Accessibility } from 'lucide-react';
import { useToast, VenueMap } from '@eticketsgo/web-kit';
import { api, tokenStore, ApiRequestError, type SeatLayout } from '@/lib/api';
import { money } from '@/lib/format';
import { Button, Card, EmptyState, ErrorState } from '@/components/ui';
import { nextStepAfterBooking } from '@/lib/after-booking';

const MAX_SEATS = 10;

/**
 * How an accessible seat is described and drawn.
 *
 * ── WHY THE CUSTOMER NEEDS THIS AND DID NOT HAVE IT ────────────────────────────────
 * `Seat.kind` has always existed and the organizer's own seat map has always shown it. The
 * customer's did not — the API never sent it — so a wheelchair bay rendered as an ordinary
 * seat. Two people are failed by that at once: the customer who needs the space cannot find
 * it, and the customer who does not need it takes it without ever knowing.
 *
 * Marked with an icon AND named in the accessible label, because a symbol alone is invisible
 * to a screen reader and a label alone is invisible to everyone else.
 */
const SEAT_KIND_LABEL: Record<string, string> = {
  WHEELCHAIR: 'wheelchair space',
  COMPANION: 'companion seat',
};

/** True for the seats that need marking. Ordinary seats are the overwhelming majority. */
const isAccessible = (kind: string) => kind === 'WHEELCHAIR' || kind === 'COMPANION';

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

/** One line of the price breakdown. Mirrors the payment screen so the two read alike. */
function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-[0.9375rem]">
      <span className="text-text-secondary">{label}</span>
      <span className="text-text-primary">{value}</span>
    </div>
  );
}

export default function SeatSelectionPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const router = useRouter();
  const toast = useToast();

  /*
    Which block of a large venue is open, if any.

    Null means "show me the venue". A cinema never leaves null — its layout comes back whole
    and the map step does not exist for it, which is right: a room of two hundred seats does
    not need an overview to choose from.
  */
  const [sectionId, setSectionId] = useState<string | null>(null);

  const {
    data: layout,
    isLoading,
    isError,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ['seats', sessionId, sectionId],
    queryFn: () => api.showSeats(sessionId, sectionId ?? undefined),
  });

  // Selected seat ids.
  const [selected, setSelected] = useState<string[]>([]);

  /*
    What we know about every seat the customer has SEEN, not just the block on screen.

    This has to accumulate. A large venue is read one block at a time, so a customer who
    takes two seats in the stalls and then opens the balcony would otherwise have the
    stalls seats vanish from their basket the moment the payload changed — the summary,
    the price and the booking call all derive from this map. Accumulating means their
    selection survives moving around the venue, which is the whole point of being able to.
  */
  const [known, setKnown] = useState<
    Map<string, { label: string; rowLabel: string; categoryId: string }>
  >(new Map());

  useEffect(() => {
    if (!layout || layout.view !== 'seats') return;
    setKnown((prev) => {
      const next = new Map(prev);
      for (const section of layout.sections) {
        for (const row of section.rows) {
          for (const seat of row.seats) {
            next.set(seat.id, {
              label: seat.label,
              rowLabel: row.label,
              categoryId: seat.categoryId,
            });
          }
        }
      }
      return next;
    });
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

  /*
    Seat id → the label a human uses, which includes the ROW.

    `seat.label` on its own is the number within the row, so the summary listed "11, 12" and
    left the buyer to work out which row from the map they had just clicked away from.
    Reported from QA. It is also genuinely ambiguous here: the seat CATEGORY in this layout
    is called "A", so "A / 11, 12" read as row A.
  */
  const seatLabelById = useMemo(() => {
    const map = new Map<string, string>();
    // Built from everything seen so far, so a seat chosen in another block still has a name
    // in the summary after the customer has moved on.
    known.forEach((seat, id) => map.set(id, `${seat.rowLabel}${seat.label}`));
    return map;
  }, [known]);

  // Group the current selection by seat category for the summary + booking items.
  const grouped = useMemo(() => {
    const byCat = new Map<string, { seatIds: string[]; labels: string[] }>();
    for (const id of selected) {
      const seat = known.get(id);
      if (!seat) continue;
      const entry = byCat.get(seat.categoryId) ?? { seatIds: [], labels: [] };
      entry.seatIds.push(id);
      entry.labels.push(seatLabelById.get(id) ?? seat.label);
      byCat.set(seat.categoryId, entry);
    }
    return byCat;
  }, [selected, known, seatLabelById]);

  /*
    Price the cart here, not on the next screen.

    Reported from QA: this panel showed a ticket subtotal and the words "transparent fees
    shown on the next step", so the number the buyer actually pays first appeared AFTER they
    had committed to seats. The quote endpoint holds nothing and writes nothing, so it is
    safe to call on every change to the selection or the code.
  */
  const [code, setCode] = useState('');
  const [appliedCode, setAppliedCode] = useState<string | null>(null);

  // The seat category already names the ticket type that sells it, which is what the
  // booking call uses too — so a quote and the booking price the identical cart.
  const items = useMemo(
    () =>
      Array.from(grouped.entries()).map(([catId, entry]) => ({
        ticketTypeId: categoriesById.get(catId)?.ticketTypeId ?? '',
        quantity: entry.seatIds.length,
        seatIds: entry.seatIds,
      })),
    [grouped, categoriesById],
  );

  const quoteQ = useQuery({
    queryKey: ['quote', sessionId, items, appliedCode],
    queryFn: () =>
      api.quoteBooking({
        eventSessionId: sessionId,
        items,
        ...(appliedCode ? { couponCode: appliedCode } : {}),
      }),
    enabled: items.length > 0 && items.every((i) => i.ticketTypeId),
    // A stale price is worse than a brief spinner: this is the number the buyer is agreeing
    // to, and the fee tiers it comes from are per-order.
    staleTime: 0,
  });
  const quote = quoteQ.data?.fees;
  const codeRejected = Boolean(appliedCode) && quoteQ.data?.coupon.applied === false;

  /** Offers the organizer chose to advertise. Private codes are typed, never listed. */
  const offersQ = useQuery({
    queryKey: ['offers', sessionId],
    queryFn: () => api.sessionOffers(sessionId),
    staleTime: 300_000,
  });

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
        // Carried through, so the price quoted on this screen is the price booked. Without
        // this the buyer would watch a discount they applied vanish on the next step.
        ...(appliedCode && !codeRejected ? { couponCode: appliedCode } : {}),
        buyerName: me.fullName,
        buyerEmail: me.email,
      });
    },
    onSuccess: (booking) => router.push(nextStepAfterBooking(booking)),
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

  /*
    The venue overview: blocks around a stage, with no seats in them.

    Rendered instead of the seat grid, never alongside it. A page that showed both would be
    asking the customer to choose in two places at once, and on a phone the grid would be
    below the fold anyway.
  */
  if (layout.view === 'overview') {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-h2 font-bold tracking-tight text-text-primary">Choose your area</h1>
          <p className="mt-1.5 text-[0.9375rem] text-text-muted">
            Pick where you&apos;d like to sit — you&apos;ll choose exact seats next.
          </p>
        </div>
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Card>
              <VenueMap
                focal={layout.focal}
                sections={layout.sections}
                onSelect={(id) => setSectionId(id)}
                formatPrice={(minor) => money(minor)}
                pendingSectionId={isFetching ? sectionId : null}
              />
            </Card>
          </div>
          {selected.length > 0 ? (
            /*
              The basket stays visible on the map.

              Someone who has taken two seats in the stalls and gone back to look at the
              balcony must be able to see they still hold those two — otherwise the natural
              reading of an empty sidebar is that browsing away discarded them.
            */
            <div className="lg:col-span-1">
              <Card title="Your seats so far">
                <p className="text-[0.9375rem] text-text-secondary">
                  {selected.length} seat{selected.length === 1 ? '' : 's'} held in your basket.
                  Choose an area to add more, or open the area you were in to review them.
                </p>
              </Card>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  const hasSeats = layout.sections.some((s) => s.rows.some((r) => r.seats.length > 0));
  const hasSold = layout.sections.some((s) =>
    s.rows.some((r) => r.seats.some((seat) => seat.status === 'SOLD')),
  );
  const hasHeld = layout.sections.some((s) =>
    s.rows.some((r) => r.seats.some((seat) => seat.status === 'HELD')),
  );
  const hasAccessible = layout.sections.some((s) =>
    s.rows.some((r) => r.seats.some((seat) => isAccessible(seat.kind))),
  );
  // True only when the customer arrived here from a venue map, which is the only case
  // where "back to the map" is a place they can actually return to.
  const cameFromMap = sectionId !== null;

  return (
    <div className="space-y-6">
      <div>
        {cameFromMap ? (
          <button
            type="button"
            onClick={() => setSectionId(null)}
            className="mb-2 inline-flex items-center gap-1.5 rounded-md text-[0.9375rem] text-action-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <ChevronLeft className="h-4 w-4" />
            Back to the venue map
          </button>
        ) : null}
        <h1 className="text-h2 font-bold tracking-tight text-text-primary">
          {cameFromMap ? (layout.sections[0]?.name ?? 'Select seats') : 'Select seats'}
        </h1>
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
              <div className="overflow-x-auto">
                {/*
                  The screen and the seating are ONE column, sized by the seating.

                  They used to be laid out independently: the screen was centred in the card
                  and capped at a fixed width, while the rows were left-aligned and as wide as
                  the room needed. So the arc floated off to one side of the seats it was
                  supposed to be in front of, and a wide room overflowed it entirely — which
                  is exactly the "seating doesn't match the screen" an organizer reported.

                  `w-fit` makes this wrapper exactly as wide as the widest row, `mx-auto`
                  centres the pair, and the arc below takes its width from the wrapper. The
                  left padding is the row-label gutter, so the arc spans the SEATS rather than
                  the labels beside them.
                */}
                <div className="mx-auto w-fit space-y-8">
                  <div className="pl-8">
                    <div className="mx-auto h-2 w-full rounded-t-[100%] bg-gradient-to-b from-action-primary/40 to-transparent" />
                    <p className="mt-1 flex items-center justify-center gap-2 text-caption font-medium uppercase tracking-widest text-text-muted">
                      <MonitorPlay className="h-3.5 w-3.5" />
                      Screen this way
                    </p>
                  </div>

                  <div className="space-y-6">
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
                                          aria-label={`Seat ${row.label}${seat.label}${
                                            SEAT_KIND_LABEL[seat.kind]
                                              ? `, ${SEAT_KIND_LABEL[seat.kind]}`
                                              : ''
                                          }${priceLabel ? `, ${priceLabel}` : ''}, ${seat.status.toLowerCase()}`}
                                          onClick={() => toggle(seat.id, seat.status)}
                                          title={`${row.label}${seat.label}${cat ? ` · ${cat.name}` : ''}${
                                            SEAT_KIND_LABEL[seat.kind]
                                              ? ` · ${SEAT_KIND_LABEL[seat.kind]}`
                                              : ''
                                          }`}
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
                                          {/*
                                          The mark wins over the number on an accessible
                                          seat. A customer scanning for somewhere they can
                                          sit needs to spot it at a glance; the number is
                                          still in the tooltip, the accessible name and the
                                          basket.
                                        */}
                                          {!available ? (
                                            seat.status === 'SOLD' ? (
                                              <X className="h-3.5 w-3.5" aria-hidden />
                                            ) : (
                                              <Clock className="h-3 w-3" aria-hidden />
                                            )
                                          ) : isAccessible(seat.kind) ? (
                                            <Accessibility className="h-3.5 w-3.5" aria-hidden />
                                          ) : (
                                            seat.label.replace(/^[A-Za-z]+/, '')
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
                </div>

                {/* Legend — status is conveyed by shape/icon, not colour alone. */}
                <div className="mt-8 space-y-3 border-t border-border pt-4 text-caption text-text-secondary">
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
                    {/*
                      Only shown when the room actually has one. A legend entry for something
                      that is not on the map teaches the customer to expect a mark they will
                      never find.
                    */}
                    {hasAccessible && (
                      <span className="flex items-center gap-1.5">
                        <span className="flex h-3.5 w-3.5 items-center justify-center rounded border border-border">
                          <Accessibility className="h-2.5 w-2.5" aria-hidden />
                        </span>
                        Wheelchair space or companion seat
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
                          {[...entry.labels]
                            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
                            .join(', ')}
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

            {/*
              A discount code, and the offers worth advertising.

              The dropdown lists only codes the organizer PUBLISHED. Listing every active code
              would leak the ones whose whole value is that not everyone has them — so private
              codes are still typed into the box beside it.
            */}
            {selected.length > 0 && (
              <div className="mt-4 border-t border-border pt-4">
                {appliedCode && !codeRejected ? (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[0.9375rem] text-text-secondary">
                      Code <strong className="text-text-primary">{appliedCode}</strong> applied
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setAppliedCode(null);
                        setCode('');
                      }}
                      className="text-caption text-text-muted underline hover:text-text-primary"
                    >
                      Remove
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {(offersQ.data?.length ?? 0) > 0 && (
                      <select
                        aria-label="Available offers"
                        value=""
                        onChange={(e) => {
                          if (!e.target.value) return;
                          setCode(e.target.value);
                          setAppliedCode(e.target.value);
                        }}
                        className="w-full rounded-md border border-border bg-background-surface px-3 py-2 text-[0.9375rem] text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                      >
                        <option value="">Available offers…</option>
                        {offersQ.data!.map((o) => (
                          <option key={o.code} value={o.code}>
                            {o.code} — {o.label}
                          </option>
                        ))}
                      </select>
                    )}
                    <div className="flex items-start gap-2">
                      <input
                        aria-label="Discount code"
                        placeholder="Have a code?"
                        value={code}
                        onChange={(e) => setCode(e.target.value.toUpperCase())}
                        className="min-w-0 flex-1 rounded-md border border-border bg-background-surface px-3 py-2 text-[0.9375rem] uppercase text-text-primary placeholder:normal-case placeholder:text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                      />
                      <button
                        type="button"
                        disabled={!code.trim()}
                        onClick={() => setAppliedCode(code.trim())}
                        className="shrink-0 rounded-md border border-border px-3 py-2 text-[0.9375rem] font-medium text-text-primary transition-colors hover:bg-background-subtle disabled:opacity-40"
                      >
                        Apply
                      </button>
                    </div>
                    {codeRejected && (
                      <p role="alert" className="text-caption text-status-error">
                        That code is not valid for this booking.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/*
              The full breakdown, here rather than one screen later.

              The line this replaced read "Transparent fees shown on the next step" — an
              apology for showing the buyer a number that was not what they would pay. The
              quote is priced by the same code the booking uses, so the two cannot disagree.
            */}
            <div className="mt-4 border-t border-border pt-4">
              {quote ? (
                <div className="space-y-1" data-testid="price-breakdown">
                  <Line label="Tickets" value={money(quote.subtotalMinor)} />
                  {quote.discountMinor > 0 && (
                    <Line label="Discount" value={`- ${money(quote.discountMinor)}`} />
                  )}
                  {quote.bookingFeeMinor > 0 && (
                    <Line label="Booking fee" value={money(quote.bookingFeeMinor)} />
                  )}
                  {quote.paymentFeeMinor > 0 && (
                    <Line label="Payment fee" value={money(quote.paymentFeeMinor)} />
                  )}
                  {(quote.taxLines ?? []).map((t) => (
                    <Line
                      key={`${t.label}-${t.rateBasisPoints}`}
                      label={`${t.label} (${(t.rateBasisPoints / 100).toFixed(
                        t.rateBasisPoints % 100 === 0 ? 0 : 2,
                      )}%)`}
                      value={money(t.amountMinor)}
                    />
                  ))}
                </div>
              ) : null}

              <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
                <span className="text-[0.9375rem] text-text-secondary">
                  Total ({selected.length} seat{selected.length === 1 ? '' : 's'})
                </span>
                <span className="text-title font-bold text-text-primary">
                  {money(quote ? quote.totalMinor : total)}
                </span>
              </div>
              <p className="mt-1 text-caption text-text-muted">
                {quote
                  ? 'This is the full amount you will pay.'
                  : quoteQ.isFetching
                    ? 'Working out fees…'
                    : 'Fees are added once you pick a seat.'}
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
