'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ExternalLink, Printer, Ticket, Undo2 } from 'lucide-react';
import {
  api,
  DataTable,
  StatusBadge,
  Select,
  SearchInput,
  Pagination,
  Drawer,
  money,
  dateOnly,
  errorMessage,
  useToast,
  currencyForCountry,
  type Column,
  type OrderRow,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import { timeAtVenue } from '@/components/events/event-list-model';
import { cashPaymentLabel } from '@/lib/booking-status';

/* The filter in the words the table's own status pills use, not the stored names. */
const STATUSES: { value: string; label: string }[] = [
  { value: 'PENDING_PAYMENT', label: 'Waiting for payment' },
  { value: 'CONFIRMED', label: 'Confirmed' },
  { value: 'PARTIALLY_REFUNDED', label: 'Partly refunded' },
  { value: 'REFUNDED', label: 'Refunded' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'EXPIRED', label: 'Expired' },
];

/*
  How the order was paid, in words. A cash booking has no payment row, so the column used to
  read "-" for a sale the counter had been paid for in full.
*/
function PaymentCell({ order }: { order: OrderRow }) {
  const cash = cashPaymentLabel(order);
  if (cash) return <span className="whitespace-nowrap text-sm text-text-primary">{cash}</span>;
  return order.paymentStatus ? <StatusBadge status={order.paymentStatus} /> : <span>-</span>;
}

export default function OrdersTab() {
  const { id } = useParams<{ id: string }>();
  const { activeOrg, can } = useOrg();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const [selected, setSelected] = useState<OrderRow | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['orders', id, page, status, applied],
    queryFn: () =>
      api.events.orders(id, {
        page,
        pageSize: 15,
        status: status || undefined,
        q: applied || undefined,
      }),
  });
  /*
    Money carries its own currency, or `money()` formats it as rupees and a USD order reads ₹.
    Each order row carries its booking's currency; the venue's is only the fallback for a
    response from an API that predates it.
  */
  const eventQ = useQuery({ queryKey: ['event', id], queryFn: () => api.events.get(id) });
  const venueCurrency = currencyForCountry(eventQ.data?.venue?.country) ?? 'INR';
  const currencyOf = (o: OrderRow) => o.currency ?? venueCurrency;
  /*
    When a booking was made, at the VENUE: the attendee list and its CSV already say it that
    way, and this tab said "2:54 am" for the same 14:24 IST booking to anyone outside India.
  */
  const placedAt = (iso: string) => timeAtVenue(iso, eventQ.data?.venue ?? {});

  /*
    Refund requests waiting on THIS event. They were only on Finance > Refunds, so an organizer
    looking at the event's bookings never learned a buyer had asked. Owners and managers only:
    the API refuses the list to check-in staff.
  */
  const waitingRefunds = useQuery({
    queryKey: ['org-refunds', activeOrg.id, 'REQUESTED', 1, id],
    queryFn: () =>
      api.organizations.refunds(activeOrg.id, {
        status: 'REQUESTED',
        page: 1,
        pageSize: 1,
        eventId: id,
      }),
    enabled: can.financials,
  });
  const refundsWaiting = waitingRefunds.data?.meta.total ?? 0;

  const columns: Column<OrderRow>[] = [
    {
      key: 'reference',
      header: 'Reference',
      render: (o) => (
        <span className="font-mono text-xs text-text-muted">{o.reference ?? '—'}</span>
      ),
    },
    {
      key: 'buyer',
      header: 'Buyer',
      render: (o) => (
        <div>
          <p className="font-medium text-text-primary">{o.buyerName}</p>
          <p className="text-xs text-text-muted">{o.buyerEmail}</p>
        </div>
      ),
    },
    { key: 'tickets', header: 'Tickets', render: (o) => o.ticketCount },
    {
      key: 'total',
      header: 'Total',
      sortable: true,
      sortValue: (o) => o.totalMinor,
      render: (o) => money(o.totalMinor, currencyOf(o)),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      sortValue: (o) => o.status,
      render: (o) => <StatusBadge status={o.status} />,
    },
    {
      key: 'payment',
      header: 'Payment',
      render: (o) => <PaymentCell order={o} />,
    },
    {
      key: 'date',
      header: 'Date',
      sortable: true,
      sortValue: (o) => o.createdAt,
      render: (o) => placedAt(o.createdAt),
    },
  ];

  return (
    <div className="space-y-4">
      {refundsWaiting > 0 ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-status-warning/30 bg-tint-warning px-4 py-3"
        >
          <p className="flex items-center gap-2 text-sm text-text-primary">
            <Undo2 className="h-4 w-4 shrink-0 text-status-warning" aria-hidden />
            {refundsWaiting === 1
              ? '1 refund request is waiting for your decision.'
              : `${refundsWaiting} refund requests are waiting for your decision.`}
          </p>
          <Link
            href={`/organizer/refunds?event=${id}`}
            className="text-sm font-medium text-action-primary underline underline-offset-2"
          >
            Review {refundsWaiting === 1 ? 'it' : 'them'}
          </Link>
        </div>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
        <SearchInput
          value={q}
          onChange={setQ}
          onSubmit={() => {
            setApplied(q);
            setPage(1);
          }}
          placeholder="Search reference, buyer name or email…"
        />
        <Select
          aria-label="Status filter"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
      </div>

      <DataTable
        columns={columns}
        rows={data?.data}
        loading={isLoading}
        rowKey={(o) => o.id}
        onRowClick={setSelected}
        error={isError ? "We couldn't load this. Please try again." : undefined}
        onRetry={() => refetch()}
      />
      {data && (
        <Pagination page={data.meta.page} totalPages={data.meta.totalPages} onChange={setPage} />
      )}

      <Drawer
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.reference ? `Booking ${selected.reference}` : 'Booking'}
      >
        {selected && (
          <div className="space-y-5">
            {/*
              The booking reference leads, because it is what the buyer quotes and what is
              printed on the ticket. The database id that stood here meant nothing to anyone.
            */}
            <dl className="space-y-2 text-sm">
              <Field label="Reference" value={selected.reference ?? '-'} mono />
              <Field label="Buyer" value={selected.buyerName} />
              <Field label="Email" value={selected.buyerEmail} />
              <Field label="Tickets" value={String(selected.ticketCount)} />
              <Field label="Total" value={money(selected.totalMinor, currencyOf(selected))} />
              <div className="flex justify-between">
                <dt className="text-text-muted">Status</dt>
                <dd>
                  <StatusBadge status={selected.status} />
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-text-muted">Payment</dt>
                <dd>
                  <PaymentCell order={selected} />
                </dd>
              </div>
              <Field label="Booked" value={placedAt(selected.createdAt)} />
            </dl>
            {can.financials ? <BookingDocuments bookingId={selected.id} /> : null}
            {/* Where to act on it: who holds which ticket, a reprint, and a waiting refund. */}
            <div className="flex flex-col gap-2 border-t border-border pt-4 text-sm">
              {selected.reference ? (
                <Link
                  href={`/organizer/events/${id}/attendees?q=${encodeURIComponent(selected.reference)}`}
                  className="inline-flex items-center gap-2 font-medium text-action-primary underline underline-offset-2"
                >
                  <Ticket className="h-4 w-4" aria-hidden /> See its tickets and check-in
                </Link>
              ) : null}
              {/*
                Only while tickets exist that still work: an unpaid booking has none to print, and
                a cancelled or refunded one has only void tickets, which the print page refuses.
              */}
              {selected.ticketCount > 0 &&
              (selected.status === 'CONFIRMED' || selected.status === 'PARTIALLY_REFUNDED') ? (
                <Link
                  href={`/organizer/bookings/${selected.id}/print`}
                  className="inline-flex items-center gap-2 font-medium text-action-primary underline underline-offset-2"
                >
                  <Printer className="h-4 w-4" aria-hidden /> Print its tickets
                </Link>
              ) : null}
              {refundsWaiting > 0 ? (
                <Link
                  href={`/organizer/refunds?event=${id}`}
                  className="inline-flex items-center gap-2 font-medium text-action-primary underline underline-offset-2"
                >
                  <Undo2 className="h-4 w-4" aria-hidden /> Refund requests for this event
                </Link>
              ) : null}
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}

const DOCUMENT_KIND: Record<string, string> = {
  TAX_INVOICE: 'Tax invoice',
  RECEIPT: 'Receipt',
  CREDIT_NOTE: 'Credit note',
};

/*
  The financial documents issued for this booking: the receipt or tax invoice of the sale and,
  once it was refunded or its show was cancelled, the credit note that reverses it. Owners and
  managers only, as on Receipts and invoices: a document names a buyer and an amount.
*/
function BookingDocuments({ bookingId }: { bookingId: string }) {
  const toast = useToast();
  const docs = useQuery({
    queryKey: ['booking-receipts', bookingId],
    queryFn: () => api.receipts.forBooking(bookingId),
  });
  if (docs.isLoading || docs.isError || !docs.data || docs.data.length === 0) return null;
  return (
    <div className="space-y-2 border-t border-border pt-4 text-sm">
      <p className="font-medium text-text-primary">Receipts and credit notes</p>
      <ul className="space-y-2">
        {docs.data.map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-3">
            <div>
              <p className="text-text-primary">
                {DOCUMENT_KIND[d.kind] ?? d.kind}{' '}
                <span className="font-mono text-xs text-text-muted">{d.number}</span>
              </p>
              <p className="text-caption text-text-muted">
                {dateOnly(d.issuedAt)}, {money(d.totalMinor, d.currency)}
              </p>
            </div>
            <button
              type="button"
              onClick={() =>
                api.receipts.openHtml(d.id).catch((e) => toast.push(errorMessage(e), 'error'))
              }
              className="inline-flex items-center gap-1 text-caption text-action-primary hover:underline"
            >
              Open <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-text-muted">{label}</dt>
      <dd className={`text-right text-text-primary ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </div>
  );
}
