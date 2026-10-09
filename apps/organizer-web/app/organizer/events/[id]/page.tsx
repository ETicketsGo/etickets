'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import Link from 'next/link';
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
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import { SellabilityPanel } from '@/components/sellability-panel';
import { ReadMore } from '@/components/events/read-more';
import {
  QuickLinks,
  SalesSection,
  SessionsSection,
  TicketsSection,
} from '@/components/events/overview-sections';
import { timeAtVenue } from '@/components/events/event-list-model';

/*
  ── THE ORDER OF THIS PAGE ─────────────────────────────────────────────────────────
  The header above (in the layout) says which event this is and where it stands. Below it,
  from `lg` up, two columns: what the event IS and how it is doing on the left - about, what is
  missing, tickets, sales, sessions - and what to DO on the right: the status actions and the
  way into each section. On a phone the status card comes first, because a phone is where
  somebody goes to pause a show, not to read its description.
*/
export default function EventOverview() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const { orgSentenceName } = useOrg();
  const {
    data: event,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['event', id],
    queryFn: () => api.events.get(id),
  });

  // Named from the event's own organizationId, and only when the name needs qualifying.
  const owningOrg = orgSentenceName(event?.organizationId);

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
    <div className="grid min-w-0 gap-6 lg:grid-cols-3">
      <div className="min-w-0 space-y-6 lg:col-span-2">
        <Card title="About this event">
          {event.description ? (
            <ReadMore text={event.description} />
          ) : (
            <p className="text-[0.9375rem] text-text-muted">
              No description yet. Buyers read this on the event page.{' '}
              <Link
                href={`/organizer/events/${id}/edit`}
                className="font-medium text-action-primary hover:underline"
              >
                Add one
              </Link>
            </p>
          )}
          <dl className="mt-5 grid grid-cols-1 gap-x-6 gap-y-3 border-t border-border pt-4 text-[0.9375rem] sm:grid-cols-2">
            {[
              ['Category', event.category],
              [
                'Venue',
                [event.venue.name, event.venue.address, event.venue.city]
                  .filter(Boolean)
                  .join(', '),
              ],
              ['Age limit', event.ageLimit ? `${event.ageLimit}+` : 'No age limit'],
              [
                'Artists',
                event.artists?.length ? event.artists.map((a) => a.name).join(', ') : 'None',
              ],
              ['Fee handling', event.isFree ? 'Free event' : titleCase(event.feeMode)],
              [
                'Published',
                event.publishedAt ? timeAtVenue(event.publishedAt, event.venue) : 'Not yet',
              ],
            ].map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-caption text-text-muted">{label}</dt>
                <dd className="break-words text-text-primary [overflow-wrap:anywhere]">{value}</dd>
              </div>
            ))}
          </dl>
          {event.reviewNote && (
            <p className="mt-4 break-words rounded-md bg-tint-warning p-3 text-[0.9375rem] text-status-warning">
              Reviewer note: {event.reviewNote}
            </p>
          )}
        </Card>

        {/*
          Before the figures, because it decides whether the submit button will work. An
          organizer who reads this first never meets the refusal; one who does not still gets
          the same list back from the refusal itself.
        */}
        <section aria-label="Readiness">
          <SellabilityPanel eventId={id} />
        </section>

        <TicketsSection event={event} />
        <SalesSection event={event} />
        <SessionsSection event={event} />
      </div>

      {/*
        `contents` below `lg`, so the two cards are items of the page's own grid there and the
        status card can be lifted above the description with `order-first`. From `lg` up it is
        the right-hand column, in order.
      */}
      <div className="contents min-w-0 lg:block lg:space-y-6">
        <div className="order-first min-w-0 lg:order-none">
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
              {(event.status === 'DRAFT' ||
                (event.status === 'PAUSED' && !event.pausedByAdmin)) && (
                <Button
                  className="w-full"
                  loading={submit.isPending}
                  onClick={() => submit.mutate()}
                >
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
              <ButtonLink
                href={`/organizer/events/${id}/checkin`}
                variant="ghost"
                className="w-full"
              >
                Open check-in
              </ButtonLink>
              {/*
              Deleting is for an event nobody has bought into. Once there are bookings the
              button is replaced by the reason, and pausing - above - is how sales stop.
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
        </div>

        <QuickLinks eventId={id} />
      </div>

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
          <span className="font-medium text-text-primary">{event.title}</span>
          {/*
            The EVENT's own organization, not the switcher's.

            They can differ - an organizer reaches this page by link as well as by browsing - so
            naming the active organization here would state something false about what is being
            deleted. Always named on a destructive action, qualified where the name is ambiguous;
            null only when the event belongs to an organization this member cannot see, which
            leaves the sentence as it was rather than printing a gap.
          */}
          {owningOrg ? <> in {owningOrg}</> : null} will be deleted, with its sessions, ticket types
          and images. This cannot be undone.
        </p>
      </Dialog>
    </div>
  );
}
