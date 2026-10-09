'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  api,
  Badge,
  Button,
  DataTable,
  Pagination,
  SearchInput,
  Select,
  StatusBadge,
  dateTime,
  errorMessage,
  useToast,
  type AttendeeFilter,
  type AttendeeRow,
  type AttendeeState,
  type BadgeTone,
  type Column,
} from '@eticketsgo/web-kit';

/*
  The organizer's "who booked" list.

  Everything is filtered, counted and paged by the server, and Export asks the server for the
  same filter as a CSV. It used to page this list from the browser and write the file itself:
  two serialisers that could disagree about what "this view" was, and no formula guard on the
  names buyers type.
*/

const STATE_LABELS: Record<AttendeeState, string> = {
  CONFIRMED: 'Confirmed',
  PENDING: 'Reserved, not paid',
  CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded',
};
const STATES: AttendeeState[] = ['CONFIRMED', 'PENDING', 'CANCELLED', 'REFUNDED'];

const PAYMENT: Record<string, { label: string; tone: BadgeTone }> = {
  SUCCEEDED: { label: 'Paid', tone: 'success' },
  REFUNDED: { label: 'Refunded', tone: 'error' },
  PARTIALLY_REFUNDED: { label: 'Partly refunded', tone: 'warning' },
  REQUIRES_PAYMENT: { label: 'Not paid', tone: 'warning' },
  PROCESSING: { label: 'Processing', tone: 'info' },
  AUTHORIZED: { label: 'Authorised', tone: 'info' },
  FAILED: { label: 'Failed', tone: 'error' },
  VOIDED: { label: 'Voided', tone: 'neutral' },
  CASH_DUE: { label: 'Cash, not paid', tone: 'warning' },
  CASH_PAID: { label: 'Cash, paid', tone: 'success' },
  NONE: { label: 'No payment', tone: 'neutral' },
};

function PaymentBadge({ code }: { code: string }) {
  const p = PAYMENT[code] ?? { label: code, tone: 'neutral' as const };
  return <Badge tone={p.tone}>{p.label}</Badge>;
}

function CheckInCell({ row }: { row: AttendeeRow }) {
  if (!row.ticketId)
    return <span className="whitespace-nowrap text-caption text-text-muted">No ticket yet</span>;
  if (row.checkedIn) {
    return (
      <Badge tone="info">Checked in{row.checkedInAt ? ` ${dateTime(row.checkedInAt)}` : ''}</Badge>
    );
  }
  return <span className="whitespace-nowrap text-caption text-text-muted">Not checked in</span>;
}

/** Whether the ticket names somebody other than the buyer, which is worth a second line. */
function attendeeIsSomeoneElse(r: AttendeeRow): boolean {
  return Boolean(r.attendeeName && r.attendeeName !== r.buyerName);
}

export default function AttendeesTab() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<AttendeeState | ''>('');
  const [sessionId, setSessionId] = useState('');
  const [ticketTypeId, setTicketTypeId] = useState('');
  const [checkIn, setCheckIn] = useState<NonNullable<AttendeeFilter['checkIn']> | ''>('');
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const [exporting, setExporting] = useState(false);

  // ONE filter object, sent to the list and to the export alike.
  const filter: AttendeeFilter = {
    status: status || undefined,
    sessionId: sessionId || undefined,
    ticketTypeId: ticketTypeId || undefined,
    checkIn: checkIn || undefined,
    q: applied || undefined,
  };

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['attendees', id, page, filter],
    queryFn: () => api.events.attendees(id, { page, pageSize: 25, ...filter }),
    // Keep the old page on screen while the next loads, so the filters do not jump.
    placeholderData: (prev) => prev,
  });

  const isFree = data?.event.isFree ?? false;
  const canSeeContact = data?.viewer.canSeeContact ?? false;
  const canExport = data?.viewer.canExport ?? false;
  const showPayment = canSeeContact && !isFree;
  const total = data?.meta.total ?? 0;
  const sessions = data?.filters.sessions ?? [];
  const ticketTypes = (data?.filters.ticketTypes ?? []).filter(
    (t) => !sessionId || t.sessionId === sessionId,
  );
  // Ticket types belong to a session, so one name can repeat; say which session it is for.
  const sessionLabel = (sid: string) => sessions.find((s) => s.id === sid)?.label ?? '';
  const filtered = Boolean(status || sessionId || ticketTypeId || checkIn || applied);

  const refilter = (change: () => void) => {
    change();
    setPage(1);
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      await api.events.exportAttendees(id, filter);
    } catch (e) {
      toast.push(errorMessage(e), 'error');
    } finally {
      setExporting(false);
    }
  };

  /*
    Five columns, not seven: the console's content area is under 1000px wide even on a large
    screen, and a table that hides its status column behind a sideways scroll hides the one
    thing an organizer scans it for. Status, check-in and payment share a cell instead.
  */
  const columns: Column<AttendeeRow>[] = [
    {
      key: 'buyer',
      header: 'Buyer',
      render: (r) => (
        <div>
          <p className="font-medium text-text-primary">{r.buyerName}</p>
          {r.buyerEmail && <p className="break-all text-xs text-text-muted">{r.buyerEmail}</p>}
          {attendeeIsSomeoneElse(r) && (
            <p className="mt-1 text-xs text-text-secondary">
              For: {r.attendeeName}
              {r.attendeeEmail && r.attendeeEmail !== r.buyerEmail ? ` (${r.attendeeEmail})` : ''}
              {r.attendeePhone ? `, ${r.attendeePhone}` : ''}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'booking',
      header: 'Booking',
      render: (r) => (
        <div>
          <p className="whitespace-nowrap font-mono text-xs text-text-primary">
            {r.reference ?? 'No reference yet'}
          </p>
          <p className="text-caption text-text-muted">Booked {dateTime(r.bookedAt)}</p>
        </div>
      ),
    },
    {
      key: 'ticket',
      header: 'Ticket',
      render: (r) => (
        <div>
          <p className="text-text-primary">
            {r.ticketType}
            {r.quantity > 1 ? ` x ${r.quantity}` : ''}
          </p>
          {r.seatLabel && <p className="text-caption text-text-muted">Seat {r.seatLabel}</p>}
          {r.serial && (
            <p className="whitespace-nowrap font-mono text-caption text-text-muted">{r.serial}</p>
          )}
        </div>
      ),
    },
    {
      key: 'session',
      header: 'Session',
      render: (r) => (
        <div>
          <p className="whitespace-nowrap text-text-primary">{r.sessionLabel}</p>
          {/* Said out loud, so a venue with no zone set reads as UTC rather than as local. */}
          <p className="text-caption text-text-muted">{r.timeZone} time</p>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <div className="flex flex-col items-start gap-1.5">
          <StatusBadge status={r.status} label={STATE_LABELS[r.status]} />
          <CheckInCell row={r} />
          {showPayment && r.payment && <PaymentBadge code={r.payment} />}
        </div>
      ),
    },
  ];

  const byStatus = data?.totals.byStatus;
  const chips: { key: AttendeeState | ''; label: string; count: number }[] = [
    {
      key: '',
      label: 'All',
      count: byStatus ? STATES.reduce((n, s) => n + byStatus[s].rows, 0) : 0,
    },
    ...STATES.map((s) => ({ key: s, label: STATE_LABELS[s], count: byStatus?.[s].rows ?? 0 })),
  ];

  return (
    <div className="space-y-4">
      {/* Status chips: colour AND words, each counted under the other filters. */}
      <div role="group" aria-label="Booking status" className="flex flex-wrap gap-2">
        {chips.map((chip) => {
          const active = status === chip.key;
          return (
            <button
              key={chip.key || 'all'}
              type="button"
              aria-pressed={active}
              onClick={() => refilter(() => setStatus(chip.key))}
              className={`inline-flex min-h-[2.5rem] items-center gap-2 rounded-full border px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                active
                  ? 'border-action-primary bg-tint-primary text-text-primary'
                  : 'border-border bg-background-surface text-text-secondary hover:bg-background-subtle'
              }`}
            >
              {chip.key ? (
                <StatusBadge status={chip.key} label={chip.label} />
              ) : (
                <span className="font-medium">{chip.label}</span>
              )}
              <span className="font-semibold tabular-nums">{chip.count}</span>
            </button>
          );
        })}
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,2.5fr)_repeat(3,minmax(0,1fr))]">
        <SearchInput
          value={q}
          onChange={setQ}
          onSubmit={() => refilter(() => setApplied(q.trim()))}
          placeholder={
            canSeeContact ? 'Search name, email or booking reference' : 'Search name or reference'
          }
        />
        <Select
          aria-label="Session"
          value={sessionId}
          onChange={(e) =>
            refilter(() => {
              setSessionId(e.target.value);
              setTicketTypeId('');
            })
          }
        >
          <option value="">All sessions</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Ticket type"
          value={ticketTypeId}
          onChange={(e) => refilter(() => setTicketTypeId(e.target.value))}
        >
          <option value="">All ticket types</option>
          {ticketTypes.map((t) => (
            <option key={t.id} value={t.id}>
              {sessions.length > 1 && !sessionId
                ? `${t.name} (${sessionLabel(t.sessionId)})`
                : t.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Check-in"
          value={checkIn}
          onChange={(e) =>
            refilter(() => setCheckIn(e.target.value as NonNullable<AttendeeFilter['checkIn']>))
          }
        >
          <option value="">Any check-in</option>
          <option value="checked_in">Checked in</option>
          <option value="not_checked_in">Not checked in</option>
        </Select>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-border bg-background-subtle p-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-text-secondary" aria-live="polite">
          {data ? (
            <>
              <span className="font-semibold text-text-primary">{total}</span>{' '}
              {total === 1 ? 'row' : 'rows'}, {data.totals.tickets}{' '}
              {data.totals.tickets === 1 ? 'ticket' : 'tickets'}, {data.totals.checkedIn} checked in
              {filtered ? ' (filtered)' : ''}
            </>
          ) : (
            'Loading...'
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {filtered && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                refilter(() => {
                  setStatus('');
                  setSessionId('');
                  setTicketTypeId('');
                  setCheckIn('');
                  setQ('');
                  setApplied('');
                })
              }
            >
              Clear filters
            </Button>
          )}
          {canExport ? (
            <Button
              variant="outline"
              size="sm"
              onClick={exportCsv}
              loading={exporting}
              disabled={exporting || total === 0}
            >
              {`Export ${total} ${total === 1 ? 'row' : 'rows'} (CSV)`}
            </Button>
          ) : (
            data && (
              <span className="text-caption text-text-muted">
                Only owners and managers can export.
              </span>
            )
          )}
        </div>
      </div>

      {isFree && canSeeContact && (
        <p className="text-caption text-text-muted">
          This is a free event, so there is no payment to show.
        </p>
      )}

      {/* Wide screens: a table, which scrolls inside its own box and never the page. */}
      <div className="hidden md:block">
        <DataTable
          columns={columns}
          rows={data?.data}
          loading={isLoading}
          rowKey={(r) => r.id}
          error={isError ? "We couldn't load this. Please try again." : undefined}
          onRetry={() => refetch()}
          empty={<EmptyAttendees filtered={filtered} />}
        />
      </div>

      {/* Phones: one card per row, so nothing needs a sideways scroll. */}
      <div className="md:hidden">
        {isError || isLoading ? (
          <DataTable
            columns={columns}
            rows={undefined}
            loading={isLoading}
            rowKey={(r) => r.id}
            error={isError ? "We couldn't load this. Please try again." : undefined}
            onRetry={() => refetch()}
          />
        ) : data && data.data.length === 0 ? (
          <EmptyAttendees filtered={filtered} />
        ) : (
          <ul className="space-y-3">
            {data?.data.map((r) => (
              <li
                key={r.id}
                className="rounded-lg border border-border bg-background-surface p-4 shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-text-primary">{r.buyerName}</p>
                    {r.buyerEmail && (
                      <p className="break-all text-xs text-text-muted">{r.buyerEmail}</p>
                    )}
                  </div>
                  <StatusBadge status={r.status} label={STATE_LABELS[r.status]} />
                </div>
                {attendeeIsSomeoneElse(r) && (
                  <p className="mt-1 text-xs text-text-secondary">
                    For: {r.attendeeName}
                    {r.attendeePhone ? `, ${r.attendeePhone}` : ''}
                  </p>
                )}
                <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                  <dt className="text-text-muted">Booking</dt>
                  <dd className="break-all font-mono text-xs leading-5 text-text-primary">
                    {r.reference ?? 'No reference yet'}
                  </dd>
                  <dt className="text-text-muted">Ticket</dt>
                  <dd className="text-text-primary">
                    {r.ticketType}
                    {r.quantity > 1 ? ` x ${r.quantity}` : ''}
                    {r.seatLabel ? `, seat ${r.seatLabel}` : ''}
                  </dd>
                  <dt className="text-text-muted">Session</dt>
                  <dd className="text-text-primary">
                    {r.sessionLabel}{' '}
                    <span className="text-caption text-text-muted">({r.timeZone})</span>
                  </dd>
                  <dt className="text-text-muted">Check-in</dt>
                  <dd>
                    <CheckInCell row={r} />
                  </dd>
                  {showPayment && r.payment && (
                    <>
                      <dt className="text-text-muted">Payment</dt>
                      <dd>
                        <PaymentBadge code={r.payment} />
                      </dd>
                    </>
                  )}
                </dl>
              </li>
            ))}
          </ul>
        )}
      </div>

      {data && (
        <Pagination page={data.meta.page} totalPages={data.meta.totalPages} onChange={setPage} />
      )}
    </div>
  );
}

function EmptyAttendees({ filtered }: { filtered: boolean }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-8 text-center">
      <p className="font-medium text-text-primary">
        {filtered ? 'Nobody matches these filters.' : 'Nobody has booked yet.'}
      </p>
      <p className="mt-1 text-sm text-text-muted">
        {filtered
          ? 'Try a different session, status or search.'
          : 'Bookings appear here as soon as they are made.'}
      </p>
    </div>
  );
}
