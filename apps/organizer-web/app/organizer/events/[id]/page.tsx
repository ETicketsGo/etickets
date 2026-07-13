'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import {
  api,
  Button,
  Card,
  ButtonLink,
  Skeleton,
  ErrorState,
  StatusBadge,
  useToast,
  errorMessage,
  titleCase,
  dateTime,
} from '@eticketsgo/web-kit';

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
    onSuccess: onSuccess('Resume'),
    onError,
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

      <Card title="Status & actions">
        <div className="mb-4">
          <StatusBadge status={event.status} />
        </div>
        <div className="space-y-2">
          {(event.status === 'DRAFT' || event.status === 'PAUSED') && (
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
          {event.status === 'PAUSED' && (
            <Button
              variant="outline"
              className="w-full"
              loading={resume.isPending}
              onClick={() => resume.mutate()}
            >
              Resume event
            </Button>
          )}
          <ButtonLink href={`/organizer/events/${id}/edit`} variant="ghost" className="w-full">
            Edit details
          </ButtonLink>
          <ButtonLink href={`/organizer/events/${id}/checkin`} variant="ghost" className="w-full">
            Open check-in
          </ButtonLink>
        </div>
      </Card>
    </div>
  );
}
