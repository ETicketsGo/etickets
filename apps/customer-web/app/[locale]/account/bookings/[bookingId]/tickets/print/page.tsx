'use client';

import { useQuery } from '@tanstack/react-query';
import { PrintableTickets } from '@eticketsgo/web-kit';
import { useParams } from 'next/navigation';
import { ArrowLeft, Printer } from 'lucide-react';
import { Link } from '@/i18n/navigation';
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
 *
 * ── THE WAY BACK ───────────────────────────────────────────────────────────────────
 * This page has no site header — paper should not carry one — so it has to carry its own way
 * out. It did not: once the print dialog closed, the only control was a "Print again" button
 * whose colour class did not exist, white text on a white page. Reported from QA as "there is
 * no way to come back". The toolbar is hidden when printing and always shown on screen.
 */
function Toolbar({ bookingId, canPrint }: { bookingId: string; canPrint: boolean }) {
  return (
    <div className="no-print mx-auto flex max-w-2xl flex-wrap items-center justify-between gap-3 p-6">
      <Link
        href={`/account/bookings/${bookingId}/tickets`}
        className="inline-flex items-center gap-1.5 rounded-md text-[0.9375rem] font-medium text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden /> Back to tickets
      </Link>
      {canPrint && (
        <button
          type="button"
          onClick={() => window.print()}
          className="inline-flex items-center gap-2 rounded-md bg-action-primary px-4 py-2 text-[0.9375rem] font-medium text-action-primary-foreground transition-colors hover:bg-action-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
        >
          <Printer className="h-4 w-4" aria-hidden /> Print or save as PDF
        </button>
      )}
    </div>
  );
}

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

  if (isLoading)
    return (
      <>
        <Toolbar bookingId={bookingId} canPrint={false} />
        <p className="mx-auto max-w-2xl px-6 text-sm">Preparing your tickets…</p>
      </>
    );
  if (isError || tickets.length === 0)
    return (
      <>
        <Toolbar bookingId={bookingId} canPrint={false} />
        <p className="mx-auto max-w-2xl px-6 text-sm">These tickets could not be loaded.</p>
      </>
    );

  return (
    <>
      <Toolbar bookingId={bookingId} canPrint />
      {/* The same sheet the box office prints — see PrintableTickets for why it is shared. */}
      <PrintableTickets tickets={tickets} autoPrint />
    </>
  );
}
