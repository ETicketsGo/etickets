'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { api, ErrorState, PrintableTickets, Skeleton, errorMessage } from '@eticketsgo/web-kit';

/**
 * The box-office copy.
 *
 * ── WHY STAFF CAN PRINT A BOOKING THEY DO NOT OWN ──────────────────────────────────
 * Indian cinemas print at the counter. A customer who paid in cash, or who arrives without a
 * phone, or whose battery died in the queue, still needs something the doorperson can read —
 * and the person handing it over is staff, not the buyer. The wallet's own print page cannot
 * serve them: it answers "what did I buy", and this is somebody asking "what did THIS customer
 * buy".
 *
 * Authorisation is membership of the organization that sold the booking, checked on the
 * server. The sheet itself is the same component the customer prints, so the counter copy and
 * the customer copy cannot drift apart and describe one seat differently.
 *
 * ── WHY IT IS AUDITED ──────────────────────────────────────────────────────────────
 * The QR on the sheet is a bearer credential: whoever holds it can be admitted. Printing one
 * for the customer at the counter is the point; printing one for somebody who never asked is
 * how a seat gets used by the wrong person. The API records every print for that reason.
 */
export default function BoxOfficePrintPage() {
  const { bookingId } = useParams<{ bookingId: string }>();

  const q = useQuery({
    queryKey: ['staff-print-tickets', bookingId],
    queryFn: () => api.tickets.forBookingAsStaff(bookingId),
  });

  if (q.isLoading) return <Skeleton className="mx-auto mt-8 h-96 w-full max-w-2xl" />;
  if (q.isError)
    return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;

  const tickets = q.data ?? [];
  if (tickets.length === 0) {
    return (
      <p className="mx-auto max-w-2xl p-8 text-sm text-text-muted">
        This booking has no tickets to print. Tickets are issued once a booking is confirmed.
      </p>
    );
  }

  return (
    <>
      {/*
        A way back, because this page has no console chrome. And a button that can be seen: its
        colour class was `bg-brand-primary`, which the design tokens do not define, so it
        rendered white text on a white page — the same defect the customer's print page had.
      */}
      <div className="no-print mx-auto flex max-w-2xl flex-wrap items-center justify-between gap-3 p-6">
        <div className="flex flex-wrap items-center gap-4">
          <button
            type="button"
            onClick={() => {
              if (window.history.length > 1) window.history.back();
              else window.location.assign('/organizer/bookings');
            }}
            className="text-sm font-medium text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            ← Back
          </button>
          <p className="text-sm text-text-muted">
            {tickets.length} ticket{tickets.length === 1 ? '' : 's'} · printing is recorded against
            your account.
          </p>
        </div>
        <button
          type="button"
          onClick={() => window.print()}
          className="rounded-md bg-action-primary px-4 py-2 text-sm font-medium text-action-primary-foreground hover:bg-action-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          Print
        </button>
      </div>
      {/*
        Labelled, so a sheet found later is identifiable as the counter's copy rather than
        something a customer printed at home. Not auto-printed: staff usually want to see it
        before committing paper, and a dialog that opens itself at a busy counter is an
        interruption rather than a shortcut.
      */}
      <PrintableTickets tickets={tickets} copyLabel="Box office copy" />
    </>
  );
}
