'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  api,
  Button,
  Card,
  Input,
  Select,
  errorMessage,
  money,
  type CounterSaleResult,
  type SeatLayout,
} from '@eticketsgo/web-kit';
import { timeAtVenue } from '@/components/events/event-list-model';
import {
  bestSeats,
  maxFor,
  ticketCount,
  type CounterShow,
  type Quantities,
} from '@/lib/counter-sale';

/** A fresh key per sale, so a double press or a retry after a timeout sells once. */
const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/* At the venue's clock, the way the ticket prints it, whatever zone this device is in. */
const when = (s: CounterShow) => timeAtVenue(s.startsAt, s);

/**
 * Selling at the counter: tickets for the person in front of you, paid in cash, issued now.
 *
 * ── WHAT THE PERSON AT THE COUNTER NEEDS ───────────────────────────────────────────
 * Which show, how many of which ticket, the exact amount to take (fees included, priced by the
 * server as checkout prices it), the buyer's name, and then the tickets to print. Seats on a
 * seated show are given automatically, side by side, and named before the money is taken.
 */
export function CounterSaleForm({ organizationId }: { organizationId: string }) {
  const qc = useQueryClient();
  const showsQ = useQuery({
    queryKey: ['counter-shows', organizationId],
    queryFn: () => api.organizations.counterShows(organizationId),
  });
  const shows = showsQ.data ?? [];

  const [sessionId, setSessionId] = useState('');
  const [qty, setQty] = useState<Quantities>({});
  const [buyerName, setBuyerName] = useState('');
  const [buyerEmail, setBuyerEmail] = useState('');
  const [nameError, setNameError] = useState<string | undefined>();
  const [sold, setSold] = useState<CounterSaleResult | null>(null);
  const key = useRef(newKey());

  const show = shows.find((s) => s.sessionId === sessionId);
  const count = ticketCount(qty);
  const items = useMemo(
    () =>
      (show?.ticketTypes ?? [])
        .filter((t) => (qty[t.id] ?? 0) > 0)
        .map((t) => ({
          ticketTypeId: t.id,
          quantity: qty[t.id],
          seatCategoryId: t.seatCategoryId,
        })),
    [show, qty],
  );

  /*
    Seats for a seated show: every block of the map, read once per show, and the first run of
    seats side by side in each ticket's category. Read again after every sale, so the next
    buyer is not offered the seats just sold.
  */
  const seatsQ = useQuery({
    queryKey: ['counter-seats', sessionId],
    enabled: Boolean(show?.seated),
    queryFn: async (): Promise<SeatLayout[]> => {
      const first = await api.publicShows.seats(sessionId);
      if (first.view === 'seats') return [first];
      const blocks = first.sections.filter((b) => b.kind !== 'ZONE' && b.availableCount > 0);
      const layouts = await Promise.all(blocks.map((b) => api.publicShows.seats(sessionId, b.id)));
      return layouts.filter((l): l is SeatLayout => l.view === 'seats');
    },
  });
  const seatPlan = useMemo(() => {
    if (!show?.seated)
      return {
        lines: items.map((i) => ({
          ...i,
          seatIds: undefined as string[] | undefined,
          labels: [] as string[],
        })),
        missing: [] as string[],
      };
    const taken = new Set<string>();
    const missing: string[] = [];
    const lines = items.map((i) => {
      if (!i.seatCategoryId) return { ...i, seatIds: undefined, labels: [] };
      let found: { ids: string[]; labels: string[] } | null = null;
      for (const layout of seatsQ.data ?? []) {
        found = bestSeats(layout, i.seatCategoryId, i.quantity, taken);
        if (found) break;
      }
      if (!found) {
        missing.push(show.ticketTypes.find((t) => t.id === i.ticketTypeId)?.name ?? 'a ticket');
        return { ...i, seatIds: undefined, labels: [] };
      }
      found.ids.forEach((id) => taken.add(id));
      return { ...i, seatIds: found.ids, labels: found.labels };
    });
    return { lines, missing };
  }, [show, items, seatsQ.data]);

  /* The exact amount to take, from the server's pricing (fees included). */
  const quoteQ = useQuery({
    queryKey: ['counter-quote', sessionId, items],
    enabled: Boolean(show) && count > 0,
    queryFn: () =>
      api.bookingQuote.price({
        eventSessionId: sessionId,
        items: items.map((i) => ({ ticketTypeId: i.ticketTypeId, quantity: i.quantity })),
      }),
  });
  const total = quoteQ.data?.fees.totalMinor;
  const currency = quoteQ.data?.fees.currency ?? show?.ticketTypes[0]?.currency ?? 'INR';
  const fees = quoteQ.data ? quoteQ.data.fees.totalMinor - quoteQ.data.fees.subtotalMinor : 0;

  const sell = useMutation({
    mutationFn: () =>
      api.organizations.counterSale(
        organizationId,
        {
          eventSessionId: sessionId,
          items: seatPlan.lines.map((l) => ({
            ticketTypeId: l.ticketTypeId,
            quantity: l.quantity,
            ...(l.seatIds ? { seatIds: l.seatIds } : {}),
          })),
          buyerName: buyerName.trim(),
          ...(buyerEmail.trim() ? { buyerEmail: buyerEmail.trim() } : {}),
        },
        key.current,
      ),
    onSuccess: (r) => {
      setSold(r);
      qc.invalidateQueries({ queryKey: ['counter-shows', organizationId] });
      qc.invalidateQueries({ queryKey: ['counter-seats', sessionId] });
      qc.invalidateQueries({ queryKey: ['cash-bookings', organizationId] });
    },
  });

  // A new show starts a new cart.
  useEffect(() => {
    setQty({});
  }, [sessionId]);
  /*
    A changed sale is a new sale. The key only has to survive pressing the same button twice;
    reused for a different cart, the server would answer with the first cart's booking.
  */
  useEffect(() => {
    key.current = newKey();
  }, [sessionId, qty, buyerName, buyerEmail]);

  const startAgain = () => {
    setSold(null);
    setQty({});
    setBuyerName('');
    setBuyerEmail('');
    setNameError(undefined);
    sell.reset();
    key.current = newKey();
  };

  const submit = () => {
    if (buyerName.trim().length < 2) {
      setNameError("Type the buyer's name. It is printed on the ticket.");
      return;
    }
    sell.mutate();
  };

  if (sold) {
    return (
      <Card title="Sold">
        <div className="space-y-3" role="status">
          <p className="text-[0.9375rem] text-text-primary">
            <strong>
              {sold.ticketCount} {sold.ticketCount === 1 ? 'ticket' : 'tickets'}
            </strong>{' '}
            issued to {buyerName.trim()}. Booking{' '}
            <span className="font-mono font-semibold">{sold.reference ?? sold.bookingId}</span>.
          </p>
          <p className="text-[0.9375rem] text-text-primary">
            {sold.totalMinor > 0
              ? `Cash taken: ${money(sold.totalMinor, sold.currency)}. It is recorded against you.`
              : 'Free tickets. Nothing to take.'}{' '}
            A copy went to {sold.emailedTo}.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link
              href={`/organizer/bookings/${sold.bookingId}/print`}
              className="inline-flex h-10 items-center rounded-md bg-action-primary px-4 text-ui font-semibold text-action-primary-foreground"
            >
              Print tickets
            </Link>
            <Button variant="outline" onClick={startAgain}>
              Sell to the next person
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card title="Sell tickets">
      <div className="space-y-4">
        <p className="text-caption text-text-secondary">
          For somebody at the counter now. You take the cash, the tickets are issued at once, and
          you can print them.
        </p>

        {showsQ.isError ? (
          <p className="text-caption text-status-error">
            We could not load your shows.{' '}
            <button type="button" className="underline" onClick={() => showsQ.refetch()}>
              Try again
            </button>
          </p>
        ) : !showsQ.isLoading && shows.length === 0 ? (
          <p className="text-[0.9375rem] text-text-secondary">
            Nothing is on sale right now. Only published events with a date still to come can be
            sold here.
          </p>
        ) : (
          <Select
            id="counter-show"
            label="Show"
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
          >
            <option value="">{showsQ.isLoading ? 'Loading...' : 'Choose a show...'}</option>
            {shows.map((s) => (
              <option key={s.sessionId} value={s.sessionId}>
                {s.eventTitle} - {when(s)}
                {s.venueName ? ` - ${s.venueName}` : ''}
              </option>
            ))}
          </Select>
        )}

        {show ? (
          <fieldset className="space-y-2">
            <legend className="text-ui font-semibold text-text-primary">Tickets</legend>
            {show.ticketTypes.length === 0 ? (
              <p className="text-caption text-text-muted">This show has no tickets on sale.</p>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {show.ticketTypes.map((t) => {
                  const max = maxFor(t);
                  const n = qty[t.id] ?? 0;
                  return (
                    <li key={t.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium text-text-primary">{t.name}</span>
                        <span className="block text-caption text-text-muted">
                          {t.priceMinor === 0 ? 'Free' : money(t.priceMinor, t.currency)}
                          {t.left !== null ? ` - ${t.left} left` : ''}
                        </span>
                      </span>
                      <span className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={`One fewer ${t.name}`}
                          disabled={n === 0}
                          onClick={() => setQty({ ...qty, [t.id]: n - 1 })}
                        >
                          -
                        </Button>
                        <span className="w-6 text-center tabular-nums" aria-live="polite">
                          {n}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={`One more ${t.name}`}
                          disabled={n >= max}
                          onClick={() => setQty({ ...qty, [t.id]: n + 1 })}
                        >
                          +
                        </Button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </fieldset>
        ) : null}

        {show?.seated && count > 0 ? (
          <div className="rounded-md border border-border bg-background-subtle p-3 text-caption">
            {seatsQ.isLoading ? (
              'Finding seats together...'
            ) : seatPlan.missing.length > 0 ? (
              <span className="text-status-error">
                No row has {count === 1 ? 'a free seat' : `${count} free seats together`} for{' '}
                {seatPlan.missing.join(', ')}. Sell fewer, or another ticket type.
              </span>
            ) : (
              <span className="text-text-primary">
                Seats: <strong>{seatPlan.lines.flatMap((l) => l.labels).join(', ')}</strong>. Side
                by side, nearest the front.
              </span>
            )}
          </div>
        ) : null}

        {show && count > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              id="counter-buyer-name"
              label="Buyer's name"
              value={buyerName}
              error={nameError}
              onChange={(e) => {
                setBuyerName(e.target.value);
                setNameError(undefined);
              }}
              autoComplete="off"
            />
            <Input
              id="counter-buyer-email"
              type="email"
              label="Buyer's email (optional)"
              hint="We email the tickets here. Leave it empty and the copy goes to your organization's email."
              value={buyerEmail}
              onChange={(e) => setBuyerEmail(e.target.value)}
              autoComplete="off"
            />
          </div>
        ) : null}

        {show && count > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
            <div aria-live="polite">
              {quoteQ.isError ? (
                <p className="text-caption text-status-error">{errorMessage(quoteQ.error)}</p>
              ) : total === undefined ? (
                <p className="text-caption text-text-muted">Working out the price...</p>
              ) : (
                <>
                  <p className="text-title font-semibold tabular-nums text-text-primary">
                    {total === 0 ? 'Free' : `Take ${money(total, currency)}`}
                  </p>
                  {fees > 0 ? (
                    <p className="text-caption text-text-muted">
                      Tickets {money(quoteQ.data!.fees.subtotalMinor, currency)} + fees{' '}
                      {money(fees, currency)}, the same as online.
                    </p>
                  ) : null}
                </>
              )}
            </div>
            <Button
              onClick={submit}
              loading={sell.isPending}
              disabled={
                total === undefined ||
                quoteQ.isError ||
                (show.seated && (seatsQ.isLoading || seatPlan.missing.length > 0))
              }
            >
              {total === 0
                ? `Issue ${count} free ${count === 1 ? 'ticket' : 'tickets'}`
                : `Cash taken - issue ${count} ${count === 1 ? 'ticket' : 'tickets'}`}
            </Button>
          </div>
        ) : null}

        {sell.isError ? (
          <p role="alert" className="text-caption text-status-error">
            {errorMessage(sell.error)}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
