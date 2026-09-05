'use client';

import { useQuery } from '@tanstack/react-query';
import { PrintableTickets } from '@eticketsgo/web-kit';
import { useParams } from 'next/navigation';
import { fetchWalletWithOffline } from '@/lib/offline/sync';

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

  if (isLoading) return <p className="p-8 text-sm">Preparing your tickets…</p>;
  if (isError || tickets.length === 0)
    return <p className="p-8 text-sm">These tickets could not be loaded.</p>;

  return (
    <>
      <div className="no-print mx-auto max-w-2xl p-6">
        <button
          onClick={() => window.print()}
          className="rounded-md bg-brand-primary px-4 py-2 text-white"
        >
          Print again
        </button>
      </div>
      {/* The same sheet the box office prints — see PrintableTickets for why it is shared. */}
      <PrintableTickets tickets={tickets} autoPrint />
    </>
  );
}
