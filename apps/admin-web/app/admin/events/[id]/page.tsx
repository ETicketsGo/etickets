'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  api,
  Button,
  Card,
  Textarea,
  Skeleton,
  StatusBadge,
  PageHeader,
  Dialog,
  ErrorState,
  useToast,
  errorMessage,
  titleCase,
  dateTime,
  money,
} from '@eticketsgo/web-kit';

export default function AdminEventDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);

  const {
    data: event,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['event', id],
    queryFn: () => api.events.get(id),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['event', id] });
  const onErr = (e: unknown) => toast.push(errorMessage(e), 'error');

  const review = useMutation({
    mutationFn: (decision: 'APPROVE' | 'REJECT') =>
      api.admin.reviewEvent(id, decision, note || undefined),
    onSuccess: (_r, decision) => {
      toast.push(
        `Event ${decision === 'APPROVE' ? 'approved & published' : 'rejected'}.`,
        'success',
      );
      invalidate();
    },
    onError: onErr,
  });
  const setStatus = useMutation({
    mutationFn: (status: string) => api.admin.setEventStatus(id, status),
    onSuccess: () => {
      toast.push('Event status updated.', 'success');
      setConfirmCancel(false);
      invalidate();
    },
    onError: onErr,
  });

  if (isError)
    return (
      <ErrorState message="We couldn't load this. Please try again." onRetry={() => refetch()} />
    );
  if (isLoading || !event) return <Skeleton className="h-64 w-full" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title={event.title}
        breadcrumbs={[{ label: 'Events', href: '/admin/events' }, { label: event.title }]}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Details" className="lg:col-span-2">
          <dl className="grid grid-cols-2 gap-y-3 text-sm">
            <dt className="text-text-muted">Status</dt>
            <dd>
              <StatusBadge status={event.status} />
            </dd>
            <dt className="text-text-muted">Category</dt>
            <dd className="text-text-primary">{event.category}</dd>
            <dt className="text-text-muted">Venue</dt>
            <dd className="text-text-primary">
              {event.venue.name}, {event.venue.city}
            </dd>
            <dt className="text-text-muted">Fee handling</dt>
            <dd className="text-text-primary">{titleCase(event.feeMode)}</dd>
          </dl>
          {event.description && (
            <p className="mt-4 text-sm text-text-secondary">{event.description}</p>
          )}

          <h3 className="mt-6 text-sm font-semibold text-text-primary">Sessions & tickets</h3>
          <div className="mt-2 space-y-3">
            {event.sessions.map((s) => (
              <div key={s.id} className="rounded-md border border-border p-3 text-sm">
                <p className="font-medium text-text-primary">{dateTime(s.startsAt)}</p>
                <ul className="mt-1 text-text-secondary">
                  {(s.ticketTypes ?? []).map((t) => (
                    <li key={t.id}>
                      {t.name} — {money(t.priceMinor)} × {t.quantityTotal}
                    </li>
                  ))}
                  {(!s.ticketTypes || s.ticketTypes.length === 0) && (
                    <li className="text-text-muted">No ticket types</li>
                  )}
                </ul>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Moderation">
          {event.status === 'UNDER_REVIEW' && (
            <div className="space-y-3">
              <Textarea
                id="note"
                label="Reviewer note (optional)"
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="flex gap-2">
                <Button
                  loading={review.isPending && review.variables === 'APPROVE'}
                  disabled={review.isPending}
                  onClick={() => review.mutate('APPROVE')}
                >
                  Approve
                </Button>
                <Button
                  variant="danger"
                  loading={review.isPending && review.variables === 'REJECT'}
                  disabled={review.isPending}
                  onClick={() => review.mutate('REJECT')}
                >
                  Reject
                </Button>
              </div>
            </div>
          )}
          <div className="mt-4 space-y-2">
            {event.status === 'PUBLISHED' && (
              <Button
                variant="outline"
                className="w-full"
                loading={setStatus.isPending && setStatus.variables === 'PAUSED'}
                disabled={setStatus.isPending}
                onClick={() => setStatus.mutate('PAUSED')}
              >
                Pause event
              </Button>
            )}
            {event.status === 'PAUSED' && (
              <Button
                variant="outline"
                className="w-full"
                loading={setStatus.isPending && setStatus.variables === 'PUBLISHED'}
                disabled={setStatus.isPending}
                onClick={() => setStatus.mutate('PUBLISHED')}
              >
                Republish event
              </Button>
            )}
            {['PUBLISHED', 'PAUSED', 'UNDER_REVIEW'].includes(event.status) && (
              <Button variant="danger" className="w-full" onClick={() => setConfirmCancel(true)}>
                Cancel event
              </Button>
            )}
          </div>
        </Card>
      </div>

      <Dialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title="Cancel this event?"
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmCancel(false)}>
              Keep event
            </Button>
            <Button
              variant="danger"
              loading={setStatus.isPending}
              onClick={() => setStatus.mutate('CANCELLED')}
            >
              Cancel event
            </Button>
          </>
        }
      >
        This will set the event to CANCELLED. Existing bookings are not automatically refunded.
      </Dialog>
    </div>
  );
}
