'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useRouter } from '@/i18n/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Armchair, ChevronLeft, Info } from 'lucide-react';
import {
  api as webKit,
  applySeatTap,
  currencyForCountry,
  seatGroupName,
  MAX_SEATS_PER_BOOKING,
  strandedSeats,
  useAuthUser,
  useToast,
  VenueMap,
  BuyerRegionField,
  type SelectableSeat,
} from '@eticketsgo/web-kit';
import { api, ApiRequestError, type SeatLayout } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { Button, Card, EmptyState, ErrorState } from '@/components/ui';
import { nextStepAfterBooking } from '@/lib/after-booking';
import { GuestBuyerFields, useGuestBuyer } from '@/components/guest-buyer';
import { startGuestBooking } from '@/lib/guest-session';
import { PriceBreakdown } from '@/components/price-breakdown';
import { ShowHeader } from '@/components/seat-selection/show-header';
import { TicketCount } from '@/components/seat-selection/ticket-count';
import { SeatMap } from '@/components/seat-selection/seat-map';
import { SeatLegend } from '@/components/seat-selection/seat-legend';
import { BookingBar } from '@/components/seat-selection/booking-bar';
import { useTranslations } from 'next-intl';

/**
 * Errors about the SHOW rather than about the seats.
 *
 * ── WHY THE CODE AND NOT THE STATUS ────────────────────────────────────────────────
 * Both arrive as 409. A seat lost to somebody faster and a showing whose regulatory pricing
 * was never configured are the same HTTP status, so the status cannot tell them apart — and
 * every one of these is raised as VALIDATION_FAILED, while no seat conflict is.
 *
 * The distinction decides what happens to the buyer's cart. Every one of these means
 * re-picking seats cannot possibly help: the price ceiling is unmapped, the event is marked
 * free while its tickets carry a price, this organizer does not take cash. Clearing the
 * selection for them throws away work the customer did for no reason, and the visible reset
 * reads as the failure while the sentence explaining it scrolls past.
 */
const SHOW_LEVEL_ERROR_CODES = ['VALIDATION_FAILED'];

/**
 * How an accessible seat is described.
 *
 * `Seat.kind` has always existed and the organizer's own seat map has always shown it; the
 * customer's did not, so a wheelchair bay rendered as an ordinary seat — failing the customer
 * who needs it and the one who takes it without knowing. Marked with an icon AND named in the
 * accessible label, because a symbol alone is invisible to a screen reader and a label alone
 * is invisible to everyone else.
 */
const SEAT_KIND_KEY: Record<string, 'wheelchair' | 'companion'> = {
  WHEELCHAIR: 'wheelchair',
  COMPANION: 'companion',
};

const isAccessible = (kind: string) => kind === 'WHEELCHAIR' || kind === 'COMPANION';

/** Where the mobile pay bar's "Price details" link lands. */
const SUMMARY_ID = 'seat-summary';

export default function SeatSelectionPage() {
  const sf = useTranslations('storefront');
  const s = useTranslations('storefront.seats');
  const k = useTranslations('storefront.checkout');
  const { money } = useFormat();
  const { sessionId } = useParams<{ sessionId: string }>();

  /** A seat's state in words, for its accessible name. Anything unrecognised is unavailable. */
  const seatStatusLabel = (status: string) =>
    status === 'AVAILABLE'
      ? s('statusAvailable')
      : status === 'SOLD'
        ? s('statusSold')
        : status === 'HELD'
          ? s('statusHeld')
          : s('statusUnavailable');
  const router = useRouter();
  const toast = useToast();

  /*
    Which block of a large venue is open, if any.

    Null means "show me the venue". A cinema never leaves null — its layout comes back whole
    and the map step does not exist for it, which is right: a room of two hundred seats does
    not need an overview to choose from.
  */
  const [sectionId, setSectionId] = useState<string | null>(null);

  /*
    Optional, only rendered for Indian venues, and PREFILLED from the last answer — the event
    page's rule, so a returning customer is not asked the same optional question every time.
    `touched` stops a late-arriving profile overwriting a choice made on this screen.
  */
  const { user } = useAuthUser();
  const [buyerRegion, setBuyerRegion] = useState('');
  const [regionTouched, setRegionTouched] = useState(false);
  useEffect(() => {
    if (!regionTouched && !buyerRegion && user?.lastBuyerRegion) {
      setBuyerRegion(user.lastBuyerRegion);
    }
  }, [user?.lastBuyerRegion, regionTouched, buyerRegion]);

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

  /*
    Which show this is. Failing to load it costs the header, never the seats: the map and the
    booking work without it, so it neither blocks the page nor retries into a delay.
  */
  const summaryQ = useQuery({
    queryKey: ['show-summary', sessionId],
    queryFn: () => webKit.publicShows.summary(sessionId),
    staleTime: 60_000,
    retry: false,
  });
  const summary = summaryQ.data;

  // Selected seat ids, and the ticket count the buyer chose (null = pick one by one).
  const [selected, setSelected] = useState<string[]>([]);
  const [quantity, setQuantity] = useState<number | null>(null);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  /* Buying without an account. False for a signed-in customer, so their screen is unchanged. */
  const guest = useGuestBuyer();

  /*
    ── SEATS THAT SURVIVE A TRIP TO THE SIGN-IN PAGE ─────────────────────────────────
    Signing in navigates away and back, and this page held its seats in component state only
    -- so the buyer returned to an empty map and had to find their seats again. The event page
    has saved its selection for a while; this is the same idea for a seat map.

    Saved by SEAT ID and re-checked against the live layout on the way back in, never restored
    blind: a seat somebody else bought in the meantime is gone, and silently re-selecting it
    would put a seat in the basket that the next request must refuse.
  */
  const selectionKey = `etg_seatsel_${sessionId}`;
  const [restoring, setRestoring] = useState<string[] | null>(null);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(selectionKey);
      if (!raw) return;
      const saved = JSON.parse(raw) as {
        sectionId?: string | null;
        selected?: unknown;
        quantity?: unknown;
      } | null;
      if (!saved) return;
      const ids = Array.isArray(saved.selected)
        ? saved.selected.filter((id): id is string => typeof id === 'string')
        : [];
      if (ids.length === 0) return;
      setSectionId(saved.sectionId ?? null);
      setQuantity(typeof saved.quantity === 'number' ? saved.quantity : null);
      setRestoring(ids);
    } catch {
      /* A browser that will not read it simply starts with an empty map. */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey]);

  /*
    What we know about every seat the customer has SEEN, not just the block on screen.

    This has to accumulate. A large venue is read one block at a time, so a customer who
    takes two seats in the stalls and then opens the balcony would otherwise have the
    stalls seats vanish from their basket the moment the payload changed — the summary,
    the price and the booking call all derive from this map.
  */
  const [known, setKnown] = useState<
    Map<string, { label: string; rowLabel: string; categoryId: string; sectionName: string }>
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
              // The block the buyer saw it under — what the basket calls it (see seatGroupName).
              sectionName: section.name,
            });
          }
        }
      }
      return next;
    });
  }, [layout]);

  /* Put a saved selection back, keeping only the seats that are still free to take. */
  useEffect(() => {
    if (!restoring || !layout || layout.view !== 'seats') return;
    const free = new Set<string>();
    for (const section of layout.sections) {
      for (const row of section.rows) {
        for (const seat of row.seats) if (seat.status === 'AVAILABLE') free.add(seat.id);
      }
    }
    const kept = restoring.filter((id) => free.has(id));
    if (kept.length > 0) setSelected(kept);
    setRestoring(null);
  }, [restoring, layout]);

  /*
    And keep it saved. Nothing is written while a restore is still pending, or the empty
    starting state would erase the very value being restored.
  */
  useEffect(() => {
    if (restoring) return;
    try {
      if (selected.length === 0) localStorage.removeItem(selectionKey);
      else localStorage.setItem(selectionKey, JSON.stringify({ sectionId, selected, quantity }));
    } catch {
      /* ignore */
    }
  }, [selectionKey, restoring, sectionId, selected, quantity]);

  const categoriesById = useMemo(() => {
    const map = new Map<string, SeatLayout['categories'][number]>();
    layout?.categories.forEach((c) => map.set(c.id, c));
    return map;
  }, [layout]);

  const tap = (seatId: string, row: readonly SelectableSeat[]) => {
    const result = applySeatTap({ selected, row, seatId, quantity });
    if (result.limitReached) {
      toast.push(s('maxSeats', { max: MAX_SEATS_PER_BOOKING }), 'warning');
      return;
    }
    setSelected(result.selected);
  };

  const chooseQuantity = (count: number | null) => {
    setQuantity(count);
    // Fewer tickets than seats already chosen: keep the first ones, in the order they were chosen.
    if (count !== null) setSelected((prev) => prev.slice(0, count));
  };

  /*
    Seat id → the label a human uses, which includes the ROW. `seat.label` on its own is the
    number within the row, so the summary listed "11, 12" and left the buyer to work out which
    row from the map they had just clicked away from.
  */
  const seatLabelById = useMemo(() => {
    const map = new Map<string, string>();
    known.forEach((seat, id) => map.set(id, `${seat.rowLabel}${seat.label}`));
    return map;
  }, [known]);

  const selectedLabels = useMemo(
    () =>
      selected
        .map((id) => seatLabelById.get(id))
        .filter((label): label is string => Boolean(label))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    [selected, seatLabelById],
  );

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
    Seats this selection leaves on their own. A suggestion to shift along, never a refusal —
    a buyer may have every reason to want exactly these seats.
  */
  const stranded = useMemo(() => {
    const ids = new Set<string>();
    if (!layout || layout.view !== 'seats' || selected.length === 0) return ids;
    for (const section of layout.sections) {
      for (const row of section.rows) {
        for (const id of strandedSeats(row.seats, selectedSet)) ids.add(id);
      }
    }
    return ids;
  }, [layout, selected.length, selectedSet]);
  const strandedLabels = [...stranded]
    .map((id) => seatLabelById.get(id))
    .filter((label): label is string => Boolean(label))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

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
    // buyerRegion is part of the key: it can change the tax SPLIT on the fee, so a quote
    // taken before the buyer chose their state is a different quote.
    queryKey: ['quote', sessionId, items, appliedCode, buyerRegion],
    queryFn: () =>
      api.quoteBooking({
        eventSessionId: sessionId,
        items,
        ...(appliedCode ? { couponCode: appliedCode } : {}),
        ...(buyerRegion ? { buyerRegion } : {}),
      }),
    enabled: items.length > 0 && items.every((i) => i.ticketTypeId),
    // A stale price is worse than a brief spinner: this is the number the buyer is agreeing
    // to, and the fee tiers it comes from are per-order.
    staleTime: 0,
  });
  const quote = quoteQ.data?.fees;
  /*
    What every price on this screen is in: the quote once there is something to price, and the
    venue's country before that — the same rule the server uses. Without it, `money()` fell
    back to INR and a seat map for a cinema in Boise priced every seat in rupees.
  */
  const currency = quote?.currency ?? currencyForCountry(layout?.country) ?? 'INR';
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
      const bookingItems = Array.from(grouped.entries())
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
      const order = {
        eventSessionId: sessionId,
        items: bookingItems,
        // Carried through, so the price quoted on this screen is the price booked.
        ...(appliedCode && !codeRejected ? { couponCode: appliedCode } : {}),
        ...(buyerRegion ? { buyerRegion } : {}),
      };
      /*
        A guest buys through the guest route. `startBooking` has already validated the name
        and the email, and this re-reads them rather than trusting a copy.
      */
      if (guest.asGuest) {
        const buyer = guest.validate();
        if (!buyer) throw new Error('details');
        return startGuestBooking({ ...order, buyerName: buyer.name, buyerEmail: buyer.email });
      }
      const me = await api.me();
      return api.createBooking({ ...order, buyerName: me.fullName, buyerEmail: me.email });
    },
    onSuccess: (booking) => {
      /*
        The seats are held now, so the saved selection has done its job. Leaving it behind
        would put an already-bought seat back in the basket on the way past this page again.
      */
      try {
        localStorage.removeItem(selectionKey);
      } catch {
        /* ignore */
      }
      router.push(nextStepAfterBooking(booking));
    },
    onError: (e) => {
      // 'details' is the guest form talking to itself: the fields already say what is missing.
      if ((e as Error).message === 'details') return;
      /*
        Only a seat that is genuinely gone justifies emptying the cart. A conflict means pick
        again; anything identifiably about the show means read this and try again, with the
        seats still selected. Anything not identifiably about the show keeps the old behaviour
        — assume a seat went and re-read the map — the safer default of the two.
      */
      const showLevel = e instanceof ApiRequestError && SHOW_LEVEL_ERROR_CODES.includes(e.code);
      toast.push(e instanceof ApiRequestError ? e.message : s('seatTaken'), 'error');
      if (!showLevel) {
        setSelected([]);
        refetch();
      }
    },
  });

  const payDisabled = selected.length === 0 || book.isPending || isFetching;
  const payableMinor = quote?.totalMinor ?? total;

  /**
   * Press Pay, from the summary panel or from the bar at the bottom of a phone.
   *
   * Nothing is sent until the guest form is satisfied. A failed check puts focus in the field
   * that is wrong, which also scrolls it into view -- the bar is fixed to the bottom of the
   * screen and the form it is complaining about may be well above it.
   */
  const startBooking = () => {
    if (guest.asGuest && !guest.validate()) return;
    book.mutate();
  };

  // Heading levels: the show's title is the page's h1 when we know it; otherwise the map's is.
  const MapHeading = summary ? 'h2' : 'h1';

  if (isLoading) return <div className="h-96 animate-pulse rounded-lg bg-background-subtle" />;
  if (isError) return <ErrorState message={s('loadError')} onRetry={() => refetch()} />;
  if (!layout)
    return (
      <EmptyState title={s('mapUnavailableTitle')} hint={s('mapUnavailableHint')} icon={Armchair} />
    );

  const header = summary ? <ShowHeader summary={summary} /> : null;

  /*
    The venue overview: blocks around a stage, with no seats in them.

    Rendered instead of the seat grid, never alongside it. A page that showed both would be
    asking the customer to choose in two places at once, and on a phone the grid would be
    below the fold anyway.
  */
  if (layout.view === 'overview') {
    return (
      <div className="space-y-6">
        {header}
        <div>
          <MapHeading className="text-h3 font-bold tracking-tight text-text-primary">
            {s('chooseArea')}
          </MapHeading>
          <p className="mt-1.5 text-[0.9375rem] text-text-muted">{s('chooseAreaLead')}</p>
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="min-w-0 lg:col-span-2">
            <Card>
              <VenueMap
                focal={layout.focal}
                sections={layout.sections}
                onSelect={(id) => setSectionId(id)}
                formatPrice={(minor) => money(minor, currency)}
                pendingSectionId={isFetching ? sectionId : null}
              />
            </Card>
          </div>
          {selected.length > 0 ? (
            /*
              The basket stays visible on the map: someone who has taken two seats in the stalls
              and gone back to look at the balcony must be able to see they still hold those two.
            */
            <div className="lg:col-span-1">
              <Card title={s('basketTitle')}>
                <p className="text-[0.9375rem] text-text-secondary">
                  {s('basketBody', { count: selected.length })}
                </p>
              </Card>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  const allSeats = layout.sections.flatMap((section) => section.rows.flatMap((row) => row.seats));
  const hasSeats = allSeats.length > 0;
  const hasSold = allSeats.some((seat) => seat.status === 'SOLD');
  const hasHeld = allSeats.some((seat) => seat.status === 'HELD' || seat.status === 'BLOCKED');
  const hasAccessible = allSeats.some((seat) => isAccessible(seat.kind));
  // True only when the customer arrived here from a venue map, which is the only case
  // where "back to the map" is a place they can actually return to.
  const cameFromMap = sectionId !== null;

  return (
    <div className={`space-y-6 ${selected.length > 0 ? 'pb-24 lg:pb-0' : ''}`}>
      {header}

      {/* Announced, not shown: the map itself shows what is chosen. */}
      <p className="sr-only" aria-live="polite">
        {selected.length > 0
          ? `${s('selectionCount', { count: selected.length })}: ${selectedLabels.join(', ')}`
          : ''}
      </p>

      {/*
        One column that cannot grow past the screen, stated rather than implied: an implicit grid
        track sizes to its widest content, and a seat map is wider than a phone.
      */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        {/* Seat map */}
        <div className="min-w-0">
          <Card>
            <div className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  {cameFromMap ? (
                    <button
                      type="button"
                      onClick={() => setSectionId(null)}
                      className="mb-1 inline-flex items-center gap-1.5 rounded-md text-[0.9375rem] text-action-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      <ChevronLeft className="h-4 w-4" aria-hidden />
                      {s('backToMap')}
                    </button>
                  ) : null}
                  <MapHeading className="text-title font-semibold text-text-primary">
                    {cameFromMap
                      ? (layout.sections[0]?.name ?? s('selectSeats'))
                      : s('selectSeats')}
                  </MapHeading>
                </div>
                {selected.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setSelected([])}
                    className="rounded-md text-caption font-medium text-text-muted underline-offset-2 hover:text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    {s('clearSeats')}
                  </button>
                ) : null}
              </div>

              {hasSeats ? <TicketCount value={quantity} onChange={chooseQuantity} /> : null}

              {strandedLabels.length > 0 ? (
                <p
                  role="status"
                  className="flex items-start gap-2 rounded-md bg-tint-warning px-3 py-2 text-caption text-status-warning"
                >
                  <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>
                    {strandedLabels.length === 1
                      ? s('strandedOne', { seats: strandedLabels[0] })
                      : s('strandedMany', { seats: strandedLabels.join(', ') })}{' '}
                    {s('strandedAdvice')}
                  </span>
                </p>
              ) : null}

              {!hasSeats ? (
                <EmptyState title={s('noSeatsTitle')} hint={s('noSeatsHint')} icon={Armchair} />
              ) : (
                <>
                  <SeatMap
                    layout={layout}
                    selected={selectedSet}
                    stranded={stranded}
                    onTap={tap}
                    formatMinor={(minor) => money(minor, currency)}
                    seatStatusLabel={seatStatusLabel}
                    kindLabel={(kind) => (SEAT_KIND_KEY[kind] ? s(SEAT_KIND_KEY[kind]) : null)}
                  />
                  <SeatLegend hasSold={hasSold} hasHeld={hasHeld} hasAccessible={hasAccessible} />
                </>
              )}
            </div>
          </Card>
        </div>

        {/* Summary */}
        <div id={SUMMARY_ID} className="scroll-mt-24 lg:sticky lg:top-24 lg:h-fit">
          <Card>
            <div className="mb-4 flex items-center gap-2">
              <Armchair className="h-5 w-5 text-action-primary" aria-hidden />
              <h2 className="text-title font-semibold text-text-primary">{s('yourSeats')}</h2>
            </div>

            {selected.length === 0 ? (
              <p className="text-[0.9375rem] text-text-muted">{s('noneSelected')}</p>
            ) : (
              <div className="space-y-3">
                {Array.from(grouped.entries()).map(([catId, entry]) => {
                  const cat = categoriesById.get(catId);
                  return (
                    <div key={catId} className="flex items-start justify-between gap-3">
                      <div>
                        {(() => {
                          const name = seatGroupName(
                            entry.seatIds.map((id) => known.get(id)?.sectionName ?? ''),
                            cat?.name,
                          );
                          return (
                            <p className="font-medium text-text-primary">
                              {name.title || s('seatsFallback')}
                              {name.category ? (
                                <span className="font-normal text-text-muted">
                                  {' '}
                                  - {name.category}
                                </span>
                              ) : null}
                            </p>
                          );
                        })()}
                        <p className="text-caption text-text-muted">
                          {[...entry.labels]
                            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
                            .join(', ')}
                        </p>
                      </div>
                      <span className="whitespace-nowrap text-[0.9375rem] tabular-nums text-text-secondary">
                        {money((cat?.priceMinor ?? 0) * entry.seatIds.length, currency)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {/*
              A discount code, and the offers worth advertising. The dropdown lists only codes the
              organizer PUBLISHED; private codes are still typed into the box beside it.
            */}
            {selected.length > 0 && (
              <div className="mt-4 border-t border-border pt-4">
                {appliedCode && !codeRejected ? (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[0.9375rem] text-text-secondary">
                      {s.rich('codeApplied', {
                        code: appliedCode,
                        strong: (chunks) => <strong className="text-text-primary">{chunks}</strong>,
                      })}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setAppliedCode(null);
                        setCode('');
                      }}
                      className="text-caption text-text-muted underline hover:text-text-primary"
                    >
                      {k('remove')}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {(offersQ.data?.length ?? 0) > 0 && (
                      <select
                        aria-label={k('availableOffers')}
                        value=""
                        onChange={(e) => {
                          if (!e.target.value) return;
                          setCode(e.target.value);
                          setAppliedCode(e.target.value);
                        }}
                        className="w-full rounded-md border border-border-input bg-background-surface px-3 py-2 text-[0.9375rem] text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                      >
                        <option value="">{k('availableOffers')}</option>
                        {offersQ.data!.map((o) => (
                          <option key={o.code} value={o.code}>
                            {o.code} - {o.label}
                          </option>
                        ))}
                      </select>
                    )}
                    <div className="flex items-start gap-2">
                      <input
                        aria-label={k('discountCode')}
                        placeholder={s('haveCode')}
                        value={code}
                        onChange={(e) => setCode(e.target.value.toUpperCase())}
                        className="min-w-0 flex-1 rounded-md border border-border-input bg-background-surface px-3 py-2 text-[0.9375rem] uppercase text-text-primary placeholder:normal-case placeholder:text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                      />
                      <button
                        type="button"
                        disabled={!code.trim()}
                        onClick={() => setAppliedCode(code.trim())}
                        className="shrink-0 rounded-md border border-border-input px-3 py-2 text-[0.9375rem] font-medium text-text-primary transition-colors hover:bg-background-subtle disabled:opacity-40"
                      >
                        {k('apply')}
                      </button>
                    </div>
                    {codeRejected && (
                      <p role="alert" className="text-caption text-status-error">
                        {k('couponRejected')}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Above the breakdown, because it can change what the breakdown says. */}
            <div className="mt-4">
              <BuyerRegionField
                value={buyerRegion}
                onChange={(region) => {
                  setRegionTouched(true);
                  setBuyerRegion(region);
                }}
                country={layout?.country}
                // Translated: the field's English defaults showed on French Indian pages (QA).
                label={k('buyerRegionLabel')}
                hint={k('buyerRegionHint')}
                noneLabel={k('buyerRegionNone')}
                prefilled={Boolean(user?.lastBuyerRegion) && !regionTouched}
                prefilledNote={k('buyerRegionPrefilled')}
              />
            </div>

            {/*
              The full breakdown, here rather than one screen later — shared with the event page
              so the platform never quotes two prices for the same purchase.
            */}
            <div className="mt-4">
              <PriceBreakdown
                quote={quote}
                loading={quoteQ.isFetching}
                fallbackTotalMinor={total}
                fallbackCurrency={currency}
                totalLabel={sf('event.totalSeats', { count: selected.length })}
                emptyNote={sf('event.priceAddSeat')}
              />
            </div>

            {/*
              Name and email, for somebody with no account. Only once there is something to
              buy: an empty map does not need to ask who the buyer is.
            */}
            {guest.asGuest && selected.length > 0 && <GuestBuyerFields state={guest} />}

            {/* On phones the pay button lives in the bar at the bottom of the screen. */}
            <div className="mt-4 hidden lg:block">
              <Button
                className="w-full"
                loading={book.isPending}
                disabled={payDisabled}
                onClick={startBooking}
              >
                {book.isPending ? s('holdingSeats') : s('proceedToPay')}
              </Button>
            </div>
          </Card>
        </div>
      </div>

      {selected.length > 0 ? (
        <BookingBar
          count={selected.length}
          seats={selectedLabels.join(', ')}
          amount={money(payableMinor, currency)}
          pending={book.isPending}
          disabled={payDisabled}
          onPay={startBooking}
          detailsHref={`#${SUMMARY_ID}`}
        />
      ) : null}
    </div>
  );
}
