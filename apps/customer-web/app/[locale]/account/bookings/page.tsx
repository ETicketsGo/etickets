'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useRouter } from '@/i18n/navigation';
import { CalendarDays, Receipt } from 'lucide-react';
import {
  Button,
  ButtonLink,
  Card,
  Drawer,
  EmptyState,
  ErrorState,
  Skeleton,
  StatusBadge,
  Textarea,
  errorMessage,
  useToast,
} from '@eticketsgo/web-kit';
import { api, tokenStore } from '@/lib/api';
import { money, dateTime, zoneAbbrev } from '@/lib/format';
import { useTranslations } from 'next-intl';

const REFUNDABLE = ['CONFIRMED', 'PARTIALLY_REFUNDED'];

/**
 * How many tickets to claim this booking has.
 *
 * ── WHY NOT JUST `_count.tickets` ──────────────────────────────────────────────────
 * Tickets are issued on confirmation, so an order still being paid for has none — and the
 * list said "0 ticket(s)" next to PENDING PAYMENT. To the person who has just typed their
 * card in, that reads as "your money went somewhere and you got nothing", which is the worst
 * possible reading of a screen that is simply waiting. Observed on QA and reported as
 * "after payment it is still showing pending payment".
 *
 * A count is only meaningful once there is something to count. Before that the status badge
 * beside it already says what is happening, so this says nothing rather than something wrong.
 */
function ticketCount(row: { status: string; _count: { tickets: number } }): string {
  const n = row._count.tickets;
  if (n === 0) return '';
  return `${n} ticket${n === 1 ? '' : 's'}`;
}

export default function BookingsPage() {
  const n = useTranslations('common.nav');
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!tokenStore.access) router.push('/login?next=/account/bookings');
  }, [router]);

  const list = useQuery({
    queryKey: ['bookings'],
    queryFn: () => api.listBookings(),
    enabled: typeof window !== 'undefined' && !!tokenStore.access,
  });

  const detail = useQuery({
    queryKey: ['booking', selectedId],
    queryFn: () => api.getBooking(selectedId!),
    enabled: !!selectedId,
  });
  const refunds = useQuery({
    queryKey: ['refunds', selectedId],
    queryFn: () => api.refundsForBooking(selectedId!),
    enabled: !!selectedId,
  });

  const requestRefund = useMutation({
    mutationFn: () => api.requestRefund({ bookingId: selectedId!, reason }),
    onSuccess: () => {
      toast.push('Refund requested. We’ll review it shortly.', 'success');
      setReason('');
      qc.invalidateQueries({ queryKey: ['refunds', selectedId] });
      qc.invalidateQueries({ queryKey: ['booking', selectedId] });
      qc.invalidateQueries({ queryKey: ['bookings'] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const b = detail.data;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-h2 font-bold tracking-tight text-text-primary">My bookings</h1>
        <p className="mt-1.5 text-[0.9375rem] text-text-muted">
          Your order history — view details or request a refund.
        </p>
      </div>

      {list.isError ? (
        <ErrorState
          message="We couldn't load your bookings. Please try again."
          onRetry={() => list.refetch()}
        />
      ) : list.isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : list.data && list.data.data.length > 0 ? (
        <div className="space-y-3">
          {list.data.data.map((row) => (
            <button
              key={row.id}
              onClick={() => setSelectedId(row.id)}
              className="flex w-full items-center justify-between gap-4 rounded-lg border border-border bg-background-surface p-5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
            >
              <div className="min-w-0">
                <p className="truncate font-semibold text-text-primary">{row.event.title}</p>
                <p className="mt-1 flex items-center gap-1.5 text-caption text-text-muted">
                  <CalendarDays className="h-3.5 w-3.5" />
                  {dateTime(row.eventSession.startsAt)}
                  {ticketCount(row) && ` · ${ticketCount(row)}`}
                </p>
                {row.reference && (
                  <p className="mt-1 font-mono text-caption text-text-muted">{row.reference}</p>
                )}
              </div>
              <StatusBadge status={row.status} />
            </button>
          ))}
        </div>
      ) : (
        <EmptyState
          title="No bookings yet"
          hint="When you book an event it will show up here."
          icon={Receipt}
          action={<ButtonLink href="/events">{n('browseEvents')}</ButtonLink>}
        />
      )}

      <Drawer open={!!selectedId} onClose={() => setSelectedId(null)} title="Booking details">
        {detail.isError ? (
          <ErrorState
            message="We couldn't load these booking details. Please try again."
            onRetry={() => detail.refetch()}
          />
        ) : detail.isLoading || !b ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <div className="space-y-5">
            <div>
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold text-text-primary">{b.event.title}</p>
                <StatusBadge status={b.status} />
              </div>
              <p className="mt-1 text-[0.9375rem] text-text-muted">
                {/* The cinema's clock, named — see the API comment on `timeZone`. */}
                {dateTime(b.eventSession.startsAt, undefined, b.timeZone ?? undefined)}
                {b.timeZone ? (
                  <span className="text-text-muted">
                    {' '}
                    ({zoneAbbrev(b.eventSession.startsAt, b.timeZone)})
                  </span>
                ) : null}
              </p>
              {b.reference && (
                <p className="mt-1 font-mono text-caption text-text-muted">Ref {b.reference}</p>
              )}
            </div>

            <Card className="p-4">
              <div className="space-y-1.5 text-[0.9375rem]">
                <div className="flex justify-between">
                  <span className="text-text-secondary">Subtotal</span>
                  <span className="text-text-primary">{money(b.subtotalMinor)}</span>
                </div>
                {b.discountMinor > 0 && (
                  <div className="flex justify-between">
                    <span className="text-text-secondary">Discount</span>
                    <span className="text-text-primary">- {money(b.discountMinor)}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-text-secondary">Fees</span>
                  <span className="text-text-primary">
                    {money(b.bookingFeeMinor + b.paymentFeeMinor)}
                  </span>
                </div>
                <div className="flex justify-between border-t border-border pt-1.5 font-semibold">
                  <span className="text-text-primary">Total paid</span>
                  <span className="text-text-primary">{money(b.totalMinor)}</span>
                </div>
              </div>
            </Card>

            <div>
              <p className="mb-2 text-caption font-semibold uppercase tracking-wide text-text-muted">
                Tickets ({b.tickets.length})
              </p>
              <ul className="space-y-1.5">
                {/*
                  A ticket a person can recognise.

                  This listed a truncated cuid — "cmt9co5zc0…" — which identifies a row to
                  the database and nothing at all to the buyer holding it. The seat is what
                  they care about; the id is a last resort for a general-admission ticket
                  that genuinely has nothing else to show.
                */}
                {b.tickets.map((t) => (
                  <li
                    key={t.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-[0.9375rem]"
                  >
                    <span className="min-w-0 text-text-primary">
                      {t.seatLabel ? (
                        <>
                          Seat <strong>{t.seatLabel}</strong>
                        </>
                      ) : (
                        (t.ticketTypeName ?? 'General admission')
                      )}
                      {t.seatLabel && t.ticketTypeName ? (
                        <span className="text-text-muted"> · {t.ticketTypeName}</span>
                      ) : null}
                    </span>
                    <StatusBadge status={t.status} />
                  </li>
                ))}
              </ul>
            </div>

            {/* Existing refunds */}
            {refunds.data && refunds.data.length > 0 && (
              <div>
                <p className="mb-2 text-caption font-semibold uppercase tracking-wide text-text-muted">
                  Refunds
                </p>
                <ul className="space-y-1.5">
                  {refunds.data.map((r) => (
                    <li
                      key={r.id}
                      className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-[0.9375rem]"
                    >
                      <span className="text-text-primary">{money(r.amountMinor)}</span>
                      <StatusBadge status={r.status} />
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/*
              Whether to offer a refund at all.

              Three reasons not to, all reported from QA:

                - A request is already open. Asking again does nothing except create a second
                  request for the organizer to work through, and it reads as though the first
                  one failed.
                - The booking cost nothing. There is no money to return, and offering to
                  return it is confusing at best.
                - The organizer does not offer refunds for this event. Showing the button
                  anyway means the platform advertising terms the organizer never agreed to.
            */}
            {(() => {
              const openRefund = (refunds.data ?? []).find((r) =>
                ['REQUESTED', 'PROCESSING'].includes(r.status),
              );
              const free = b.totalMinor <= 0;
              const offered = b.event.refundsEnabled !== false;
              const hasActive = b.tickets.some((t) => t.status === 'ACTIVE');
              const canAsk =
                REFUNDABLE.includes(b.status) && hasActive && !openRefund && !free && offered;

              if (openRefund) {
                return (
                  <div className="rounded-lg border border-border bg-background-subtle/50 p-4">
                    <p className="font-medium text-text-primary">Refund requested</p>
                    <p className="mt-1 text-caption text-text-muted">
                      {money(openRefund.amountMinor)} is with the organizer to review. We will email
                      you when they decide — there is nothing else to do.
                    </p>
                  </div>
                );
              }
              if (!offered && REFUNDABLE.includes(b.status) && hasActive) {
                return (
                  <div className="rounded-lg border border-border bg-background-subtle/50 p-4">
                    <p className="font-medium text-text-primary">Refunds not offered</p>
                    <p className="mt-1 text-caption text-text-muted">
                      The organizer does not offer refunds for this event.
                      {b.event.title ? ' Contact them directly if something has gone wrong.' : ''}
                    </p>
                  </div>
                );
              }
              if (!canAsk) return null;
              return (
                <div className="rounded-lg border border-border bg-background-subtle/50 p-4">
                  <p className="font-medium text-text-primary">Request a refund</p>
                  <p className="mt-1 text-caption text-text-muted">
                    Eligibility follows the event’s refund policy. We’ll review your request.
                  </p>
                  <Textarea
                    id="reason"
                    className="mt-3"
                    rows={3}
                    placeholder="Reason for the refund…"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                  <Button
                    variant="danger"
                    className="mt-3 w-full"
                    loading={requestRefund.isPending}
                    disabled={reason.trim().length < 3}
                    onClick={() => requestRefund.mutate()}
                  >
                    Request refund
                  </Button>
                </div>
              );
            })()}
          </div>
        )}
      </Drawer>
    </div>
  );
}
