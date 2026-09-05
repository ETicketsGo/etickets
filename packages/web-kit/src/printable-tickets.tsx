'use client';

import { useEffect } from 'react';
import { dateTime, zoneAbbrev } from '@eticketsgo/shared-types';
import type { WalletTicket } from './api';

/**
 * Tickets, laid out to become paper.
 *
 * ── WHY ONE COMPONENT AND NOT TWO PAGES ────────────────────────────────────────────
 * A customer prints from their wallet; box-office staff print the same booking at the
 * counter. Two implementations of the same sheet is how the counter copy and the customer
 * copy end up disagreeing — different fields, a different time, a different idea of which
 * screen — and the person at the door is then holding two documents that describe one seat.
 * One component, two callers, one sheet.
 *
 * ── WHAT A PRINTED TICKET HAS TO SURVIVE ───────────────────────────────────────────
 * No colour, no hover, no JavaScript once it is on paper, and a reader scanning it in two
 * seconds under bad light. Black on white; screen, seat and show time large enough to read at
 * arm's length; the QR big enough to scan off the sheet rather than decorative.
 *
 * The show time is in the VENUE's zone and says so. A printed time cannot be re-rendered when
 * somebody notices it is wrong — it is wrong in someone's pocket until the show starts without
 * them.
 *
 * ── WHY THE PAGE BREAKS ARE THE ONLY PRINT CSS ─────────────────────────────────────
 * Both callers render this without their app shell, so there is nothing to hide. An earlier
 * version hid the chrome with `visibility: hidden` and lifted the sheet out of flow with
 * `position: absolute` to avoid a blank leading page — which prints exactly one page, because
 * absolutely positioned content is removed from the flow the printer paginates. A two-ticket
 * booking printed one ticket and lost the other, silently.
 */
/**
 * The print rules, exported so a test can assert on the ACTUAL CSS this ships.
 *
 * ── WHY THIS IS A CONSTANT AND NOT A STRING LITERAL IN THE JSX ─────────────────────
 * The behaviour these three rules produce — N tickets become N pages — is only observable in
 * a PDF, and reproducing it in a test previously meant rebuilding the whole app for every
 * variation. A test that has to rebuild an app to check a stylesheet does not get run.
 *
 * Exported, a test can render a fixture with these exact rules and again without them, print
 * both, and show that the page count changes. That is a falsification of the rule itself
 * rather than of a copy of it — if somebody edits this constant, the test that proves it works
 * is reading the edited version.
 */
export const TICKET_PRINT_CSS = `
  @media print {
    .no-print { display: none !important; }
    /* One ticket per page: two on a sheet means the customer hands over both, and the door
       has to work out which seat is being presented. */
    .print-ticket { page-break-after: always; break-after: page; }
    .print-ticket:last-child { page-break-after: auto; break-after: auto; }
    /* And never split one across two sheets. */
    .print-ticket { break-inside: avoid; page-break-inside: avoid; }
  }
`;

export interface PrintableTicketsProps {
  tickets: WalletTicket[];
  /** Shown above the first ticket, e.g. "Box office copy". Omitted on a customer's own sheet. */
  copyLabel?: string;
  /** Open the print dialog once the tickets are on the page. */
  autoPrint?: boolean;
}

export function PrintableTickets({ tickets, copyLabel, autoPrint }: PrintableTicketsProps) {
  /*
    Print only once there is something to print. Calling print() on mount produces a sheet of
    skeletons: the browser does not wait for a query to settle, and the customer gets paper
    with nothing on it.
  */
  useEffect(() => {
    if (!autoPrint || tickets.length === 0) return undefined;
    const id = setTimeout(() => window.print(), 300);
    return () => clearTimeout(id);
  }, [autoPrint, tickets.length]);

  if (tickets.length === 0) return null;

  return (
    <>
      <style>{TICKET_PRINT_CSS}</style>

      <div className="mx-auto max-w-2xl bg-white p-6 text-black">
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
                  {copyLabel ? ` · ${copyLabel}` : ''}
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
                {/* Printed on the ticket, because paper outlives the screen that could have
                    shown it was refunded. */}
                <span>Valid only for the show named above.</span>
              </footer>
            </article>
          );
        })}
      </div>
    </>
  );
}
