'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  api,
  Button,
  Card,
  Dialog,
  ButtonLink,
  Skeleton,
  ErrorState,
  StatusBadge,
  useToast,
  errorMessage,
  titleCase,
  dateTime,
} from '@eticketsgo/web-kit';
import { SellabilityPanel } from '@/components/sellability-panel';

export default function EventOverview() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const {
    data: event,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['event', id],
    queryFn: () => api.events.get(id),
  });

  const onSuccess = (label: string) => () => {
    toast.push(`${label} succeeded.`, 'success');
    qc.invalidateQueries({ queryKey: ['event', id] });
  };
  const onError = (e: unknown) => toast.push(errorMessage(e), 'error');

  const submit = useMutation({
    mutationFn: () => api.events.submit(id),
    onSuccess: onSuccess('Submit for review'),
    onError,
  });
  const pause = useMutation({
    mutationFn: () => api.events.pause(id),
    onSuccess: onSuccess('Pause'),
    onError,
  });
  const resume = useMutation({
    mutationFn: () => api.events.resume(id),
    onSuccess: (result) => {
      // "Resume succeeded" for an event that is now in the review queue would read as live.
      if (result.sentForReview) {
        toast.push('Sent for review because it was edited while paused.', 'info');
        qc.invalidateQueries({ queryKey: ['event', id] });
      } else {
        onSuccess('Resume')();
      }
    },
    onError,
  });
  const router = useRouter();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.events.remove(id),
    onSuccess: () => {
      toast.push('Event deleted.', 'success');
      qc.invalidateQueries({ queryKey: ['events'] });
      router.push('/organizer/events');
    },
    onError: (e) => {
      setConfirmDelete(false);
      onError(e);
    },
  });

  if (isError)
    return (
      <ErrorState message="We couldn't load this. Please try again." onRetry={() => refetch()} />
    );
  if (isLoading || !event) return <Skeleton className="h-64 w-full" />;

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2" title="Details">
        <dl className="grid grid-cols-2 gap-y-3 text-sm">
          <dt className="text-text-muted">Category</dt>
          <dd className="text-text-primary">{event.category}</dd>
          <dt className="text-text-muted">Venue</dt>
          <dd className="text-text-primary">
            {event.venue.name}, {event.venue.city}
          </dd>
          <dt className="text-text-muted">Fee handling</dt>
          <dd className="text-text-primary">{titleCase(event.feeMode)}</dd>
          <dt className="text-text-muted">Sessions</dt>
          <dd className="text-text-primary">{event.sessions.length}</dd>
          <dt className="text-text-muted">Published</dt>
          <dd className="text-text-primary">
            {event.publishedAt ? dateTime(event.publishedAt) : '—'}
          </dd>
        </dl>
        {event.description && (
          <p className="mt-4 text-sm text-text-secondary">{event.description}</p>
        )}
        {event.reviewNote && (
          <p className="mt-4 rounded-md bg-status-warning/10 p-3 text-sm text-status-warning">
            Reviewer note: {event.reviewNote}
          </p>
        )}
      </Card>

      {/*
        Above the submit button, because it decides whether that button will work. An
        organizer who reads this first never meets the refusal; one who does not still gets
        the same list back from the refusal itself.
      */}
      <div className="lg:col-span-2 lg:order-last">
        <SellabilityPanel eventId={id} />
      </div>

      <Card title="Status & actions">
        <div className="mb-4">
          <StatusBadge status={event.status} />
        </div>
        <div className="space-y-2">
          {/*
            A pause by the platform team is theirs to lift, and the API refuses both ways back
            to sale. The reason replaces the buttons, so the organizer is not offered two
            controls that can only fail.
          */}
          {event.status === 'PAUSED' && event.pausedByAdmin && (
            <p className="rounded-md border border-status-warning/40 bg-tint-warning p-3 text-sm text-status-warning">
              This event was paused by the platform team. Contact support to resume it.
            </p>
          )}
          {(event.status === 'DRAFT' || (event.status === 'PAUSED' && !event.pausedByAdmin)) && (
            <Button className="w-full" loading={submit.isPending} onClick={() => submit.mutate()}>
              Submit for approval
            </Button>
          )}
          {event.status === 'PUBLISHED' && (
            <Button
              variant="outline"
              className="w-full"
              loading={pause.isPending}
              onClick={() => pause.mutate()}
            >
              Pause event
            </Button>
          )}
          {event.status === 'PAUSED' && !event.pausedByAdmin && (
            <>
              <Button
                variant="outline"
                className="w-full"
                loading={resume.isPending}
                onClick={() => resume.mutate()}
              >
                Resume event
              </Button>
              {event.needsReviewOnResume && (
                <p className="text-caption text-text-muted">
                  Details were edited while paused, so resuming may send it for review first.
                </p>
              )}
            </>
          )}
          <ButtonLink href={`/organizer/events/${id}/edit`} variant="ghost" className="w-full">
            Edit details
          </ButtonLink>
          <ButtonLink href={`/organizer/events/${id}/checkin`} variant="ghost" className="w-full">
            Open check-in
          </ButtonLink>
          {/*
            Deleting is for an event nobody has bought into. Once there are bookings the button
            is replaced by the reason, and pausing — above — is how sales stop.
          */}
          <div className="border-t border-border pt-2">
            {(event._count?.bookings ?? 0) === 0 ? (
              <Button
                variant="ghost"
                className="w-full text-status-error"
                onClick={() => setConfirmDelete(true)}
              >
                Delete event
              </Button>
            ) : (
              <p className="text-caption text-text-muted">
                This event has bookings, so it cannot be deleted. Pause it to stop sales.
              </p>
            )}
          </div>
        </div>
      </Card>

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this event?"
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setConfirmDelete(false)}
              disabled={remove.isPending}
            >
              Cancel
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
              Delete event
            </Button>
          </>
        }
      >
        <p>
          <span className="font-medium text-text-primary">{event.title}</span> will be deleted, with
          its sessions, ticket types and images. This cannot be undone.
        </p>
      </Dialog>
    </div>
  );
}
