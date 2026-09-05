'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { fetchWalletWithOffline } from '@/lib/offline/sync';
import { dateTime, zoneAbbrev } from '@/lib/format';

/**
 * A ticket on paper.
 *
 * ── WHY PRINT AT ALL, IN 2026 ──────────────────────────────────────────────────────
 * Indian cinemas print at the counter and admit on a visual check. A customer who booked
 * online still hands over something the doorperson reads, and plenty of people would rather
 * carry paper than hold up a phone with a dying battery in a queue. A platform that only
 * renders a ticket on a screen has quietly decided how its customers must behave.
 *
 * ── WHAT A PRINTED TICKET HAS TO SURVIVE ───────────────────────────────────────────
 * No colour, no hover, no JavaScript once it is on paper, and a reader who is scanning it in
 * two seconds under bad light. So: black on white, every value large enough to read at arm's
 * length, and the QR big enough to scan off the sheet rather than decorative. The show time
 * is in the VENUE's zone and says so — a printed time cannot be re-rendered when somebody
 * notices it is wrong.
 *
 * One ticket per page, deliberately. Two on a sheet means the customer tears them apart badly
 * or hands over both, and a doorperson holding two seats has to work out which one is being
 * presented.
 */
export default function PrintTicketsPage() {
  const { bookingId } = useParams<{ bookingId: string }>();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['wallet-tickets-print'],
    queryFn: fetchWalletWithOffline,
  });

  /*
    Filtered client-side from the wallet, as the on-screen ticket page does. A dedicated
    endpoint would be a second way to ask the same question, and the first time the two
    disagreed the customer would be holding paper that says something the screen does not.
  */
  const tickets = (data ?? []).filter((t) => t.bookingId === bookingId);

  /*
    Print once the tickets are actually on the page. Calling print() on mount produces a sheet
    of skeletons — the browser does not wait for a query to settle, and the customer gets paper
    with nothing on it.
  */
  useEffect(() => {
    if (tickets.length > 0) {
      const id = setTimeout(() => window.print(), 300);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [tickets.length]);

  if (isLoading) return <p className="p-8 text-sm">Preparing your tickets…</p>;
  if (isError || tickets.length === 0)
    return <p className="p-8 text-sm">These tickets could not be loaded.</p>;

  return (
    <>
      {/*
        Scoped to this route. The app's own chrome — navigation, footer, theme — is useful on a
        screen and is wasted ink on paper, so print hides everything except the sheet.
      */}
      <style>{`
        @media print {
          body { background: #fff !important; }
          body * { visibility: hidden; }
          .print-sheet, .print-sheet * { visibility: visible; }
          .print-sheet { position: absolute; inset: 0; margin: 0; }
          .print-ticket { page-break-after: always; break-after: page; }
          .print-ticket:last-child { page-break-after: auto; break-after: auto; }
          .no-print { display: none !important; }
        }
      `}</style>

      <div className="no-print mx-auto max-w-2xl p-6">
        <button
          onClick={() => window.print()}
          className="rounded-md bg-brand-primary px-4 py-2 text-white"
        >
          Print again
        </button>
      </div>

      <div className="print-sheet mx-auto max-w-2xl bg-white p-6 text-black">
        {tickets.map((t, i) => {
          const zone = t.timezone ? zoneAbbrev(t.startsAt, t.timezone) : null;
          const place = [t.cinemaName, t.venueName].filter(Boolean).join(', ');
          return (
            <article
              key={t.id}
              className="print-ticket mb-8 border border-black/30 p-5"
              aria-label={`Ticket ${i + 1} of ${tickets.length}`}
            >
              <header className="border-b border-black/20 pb-2">
                <p className="text-[0.7rem] uppercase tracking-widest text-black/60">
                  ETicketsGo · Ticket {i + 1} of {tickets.length}
                </p>
                <h1 className="mt-1 text-xl font-bold leading-tight">{t.event.title}</h1>
                {place && <p className="text-sm text-black/70">{place}</p>}
              </header>

              <div className="mt-3 flex items-start justify-between gap-5">
                <dl className="grid flex-1 grid-cols-2 gap-x-4 gap-y-3">
                  {/* Screen and seat first: they are what the door reads. */}
                  {t.screenName && (
                    <div>
                      <dt className="text-[0.65rem] uppercase tracking-wider text-black/55">
                        Screen
                      </dt>
                      <dd className="text-lg font-bold leading-tight">{t.screenName}</dd>
                    </div>
                  )}
                  {t.seatLabel && (
                    <div>
                      <dt className="text-[0.65rem] uppercase tracking-wider text-black/55">
                        Seat
                      </dt>
                      <dd className="text-lg font-bold leading-tight">{t.seatLabel}</dd>
                    </div>
                  )}
                  <div className="col-span-2">
                    <dt className="text-[0.65rem] uppercase tracking-wider text-black/55">
                      Show time{zone ? ` (${zone})` : ''}
                    </dt>
                    <dd className="text-lg font-bold leading-tight">
                      {dateTime(t.startsAt, undefined, t.timezone ?? undefined)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[0.65rem] uppercase tracking-wider text-black/55">
                      Ticket
                    </dt>
                    <dd className="text-sm">{t.ticketType}</dd>
                  </div>
                  {t.bookingRef && (
                    <div>
                      <dt className="text-[0.65rem] uppercase tracking-wider text-black/55">
                        Booking
                      </dt>
                      <dd className="font-mono text-sm">{t.bookingRef}</dd>
                    </div>
                  )}
                  {t.holderName && (
                    <div className="col-span-2">
                      <dt className="text-[0.65rem] uppercase tracking-wider text-black/55">
                        Attendee
                      </dt>
                      <dd className="text-sm">{t.holderName}</dd>
                    </div>
                  )}
                </dl>

                {t.qrDataUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={t.qrDataUrl}
                    alt={`Code for ticket ${t.serial}`}
                    className="h-36 w-36 shrink-0"
                  />
                )}
              </div>

              <footer className="mt-3 flex items-center justify-between border-t border-black/20 pt-2 text-[0.7rem] text-black/60">
                <span className="font-mono">{t.serial}</span>
                {/* Printed on the ticket, because a printed ticket outlives the screen that
                    could have shown it was refunded. */}
                <span>Valid only for the show named above.</span>
              </footer>
            </article>
          );
        })}
      </div>
    </>
  );
}
