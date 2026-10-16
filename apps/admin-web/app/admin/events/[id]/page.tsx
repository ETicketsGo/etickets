'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  api,
  apiAssetUrl,
  Button,
  Card,
  Textarea,
  Skeleton,
  PageHeader,
  Dialog,
  ErrorState,
  useToast,
  errorMessage,
  timeAtVenue,
  money,
  termsList,
} from '@eticketsgo/web-kit';
import { StatusBadge } from '@/components/status-badge';
import { feeModeWords, statusWords } from '@/lib/words';
import { taxCategoryLabel } from '@eticketsgo/shared-types';

export default function AdminEventDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /*
    Rejecting and pausing each ask why first. A rejection's note is what the organizer is sent as
    the reason, and an empty one told them "no" and nothing to fix. A pause stopped a live event
    selling with one click, no confirmation and no record of why (walked on QA, 2026-10-15).
  */
  const [rejecting, setRejecting] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [pauseReason, setPauseReason] = useState('');

  const remove = useMutation({
    mutationFn: () => api.events.remove(id),
    onSuccess: () => {
      toast.push('Event deleted.', 'success');
      // Nothing left on this page to look at.
      window.location.href = '/admin/events';
    },
    onError: (e) => {
      setConfirmDelete(false);
      toast.push(errorMessage(e), 'error');
    },
  });

  const {
    data: event,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['event', id],
    queryFn: () => api.events.get(id),
  });

  /*
    The events list and the dashboard's counts show this status too. Refreshing only the detail
    left an approved event sitting "under review" on the list the reviewer goes back to.
  */
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['event', id] });
    qc.invalidateQueries({ queryKey: ['admin', 'events'] });
    qc.invalidateQueries({ queryKey: ['admin', 'dashboard'] });
  };
  const onErr = (e: unknown) => toast.push(errorMessage(e), 'error');

  const review = useMutation({
    mutationFn: (decision: 'APPROVE' | 'REJECT') =>
      api.admin.reviewEvent(id, decision, note || undefined),
    onSuccess: (_r, decision) => {
      toast.push(
        decision === 'APPROVE'
          ? 'Approved. It is on sale now, and the organizer has been told.'
          : 'Rejected. It is back with the organizer as a draft, with your reason.',
        'success',
      );
      setRejecting(false);
      invalidate();
    },
    onError: onErr,
  });
  const setStatus = useMutation({
    mutationFn: ({ status, reason }: { status: string; reason?: string }) =>
      api.admin.setEventStatus(id, status, reason),
    onSuccess: (_r, { status }) => {
      // Say what changed for buyers, not that "a status" did.
      toast.push(
        status === 'PAUSED'
          ? 'Paused. Tickets stop selling now and the organizer has been told why.'
          : status === 'PUBLISHED'
            ? 'Back on sale. Buyers can book again.'
            : status === 'CANCELLED'
              ? 'Cancelled. Nothing more can be sold. Existing bookings were not refunded.'
              : `Now ${statusWords(status).toLowerCase()}.`,
        'success',
      );
      setConfirmCancel(false);
      setPausing(false);
      setPauseReason('');
      invalidate();
    },
    onError: onErr,
  });
  /*
    Who is selling it. The page named the venue and never the organizer, so a reviewer could not
    see who they were approving, or get from the event to the seller to check them.
  */
  const orgQ = useQuery({
    queryKey: ['org', event?.organizationId],
    queryFn: () => api.organizations.get(event!.organizationId),
    enabled: Boolean(event?.organizationId),
  });

  if (isError)
    return (
      <ErrorState message="We couldn't load this. Please try again." onRetry={() => refetch()} />
    );
  if (isLoading || !event) return <Skeleton className="h-64 w-full" />;

  // The show time at the venue, with its zone said, like every other screen. Where the venue
  // has no known zone the reader's own is used and called theirs, not passed off as the venue's.
  const showTime = (iso: string) => timeAtVenue(iso, event.venue);

  return (
    <div className="space-y-6">
      <PageHeader
        title={event.title}
        breadcrumbs={[{ label: 'Events', href: '/admin/events' }, { label: event.title }]}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Details" className="lg:col-span-2">
          {/*
            The images are content too, and the cover is what buyers see first — so all of them
            are in front of the reviewer, cover first and labelled.
          */}
          {(event.images?.length ?? 0) > 0 && (
            <ul className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {event.images!.map((image, index) => (
                <li key={image.id} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={apiAssetUrl(image.path) ?? undefined}
                    alt={`Image ${index + 1} of ${event.images!.length} for ${event.title}`}
                    className="aspect-video w-full rounded-md border border-border object-cover"
                  />
                  {index === 0 && (
                    <span className="absolute left-2 top-2 rounded bg-black/75 px-1.5 py-0.5 text-xs font-medium text-white">
                      Cover
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <dl className="grid grid-cols-2 gap-y-3 text-sm">
            <dt className="text-text-muted">Status</dt>
            <dd>
              <StatusBadge status={event.status} />
            </dd>
            <dt className="text-text-muted">Category</dt>
            <dd className="text-text-primary">{event.category}</dd>
            <dt className="text-text-muted">Organizer</dt>
            <dd className="text-text-primary">
              {orgQ.data ? (
                <Link
                  href={`/admin/organizers/${event.organizationId}`}
                  className="text-action-primary underline-offset-4 hover:underline"
                >
                  {orgQ.data.name}
                </Link>
              ) : (
                '...'
              )}
              {orgQ.data && orgQ.data.status !== 'APPROVED' && (
                <span className="ml-2 text-caption text-status-warning">
                  {statusWords(orgQ.data.status)}
                </span>
              )}
            </dd>
            <dt className="text-text-muted">Venue</dt>
            <dd className="text-text-primary">
              {event.venue.name}, {event.venue.city}
            </dd>
            {/*
              What the event is for tax. Shown to the reviewer because the GST rate a buyer pays
              follows from it, and an organizer who changes it on a live event sends it back here.
            */}
            <dt className="text-text-muted">Tax classification</dt>
            <dd className="text-text-primary">{taxCategoryLabel(event.taxCategory)}</dd>
            <dt className="text-text-muted">Fee handling</dt>
            <dd className="text-text-primary">
              {event.isFree ? 'Free event, no fees' : feeModeWords(event.feeMode)}
            </dd>
            <dt className="text-text-muted">Refunds</dt>
            <dd className="text-text-primary">
              {event.refundsEnabled === false
                ? 'No refunds'
                : event.refundCutoffHours !== undefined
                  ? `Until ${event.refundCutoffHours} hours before the show`
                  : 'Allowed'}
            </dd>
            <dt className="text-text-muted">Age limit</dt>
            <dd className="text-text-primary">
              {event.ageLimit ? `${event.ageLimit}+` : 'No age limit'}
            </dd>
          </dl>
          {event.description && (
            <p className="mt-4 text-sm text-text-secondary">{event.description}</p>
          )}
          {/*
            What a buyer will be told before paying, shown to the reviewer who approves it. The
            age limit, the terms and the line-up are reviewed details: an organizer who changes
            one on a live event sends it back here.
          */}
          {event.artists?.length ? (
            <div className="mt-4 text-sm">
              <p className="font-semibold text-text-primary">Artists</p>
              <ul className="mt-1 space-y-1 text-text-secondary">
                {event.artists.map((a, i) => (
                  <li key={i}>
                    <span className="text-text-primary">{a.name}</span>
                    {a.role ? ` - ${a.role}` : ''}
                    {a.bio ? (
                      <span className="block text-caption text-text-muted">{a.bio}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {termsList(event.termsAndConditions).length ? (
            <div className="mt-4 text-sm">
              <p className="font-semibold text-text-primary">Terms and conditions</p>
              <ol className="mt-1 list-decimal space-y-1 pl-5 text-text-secondary">
                {termsList(event.termsAndConditions).map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ol>
            </div>
          ) : null}

          <h3 className="mt-6 text-sm font-semibold text-text-primary">Sessions & tickets</h3>
          <div className="mt-2 space-y-3">
            {event.sessions.map((s) => (
              <div key={s.id} className="rounded-md border border-border p-3 text-sm">
                <p className="font-medium text-text-primary">{showTime(s.startsAt)}</p>
                <ul className="mt-1 text-text-secondary">
                  {(s.ticketTypes ?? []).map((t) => (
                    <li key={t.id}>
                      {t.name} — {money(t.priceMinor, t.currency)} × {t.quantityTotal}
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
                label={rejecting ? 'Why are you rejecting it?' : 'Note to the organizer (optional)'}
                hint={
                  rejecting
                    ? 'Sent to the organizer. Say what they need to change before they submit again.'
                    : 'Sent to the organizer with the decision.'
                }
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              {rejecting ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="danger"
                    loading={review.isPending}
                    disabled={review.isPending || note.trim().length === 0}
                    onClick={() => review.mutate('REJECT')}
                  >
                    Reject and send reason
                  </Button>
                  <Button variant="outline" onClick={() => setRejecting(false)}>
                    Back
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button
                    loading={review.isPending && review.variables === 'APPROVE'}
                    disabled={review.isPending}
                    onClick={() => review.mutate('APPROVE')}
                  >
                    Approve
                  </Button>
                  <Button
                    variant="danger"
                    disabled={review.isPending}
                    onClick={() => setRejecting(true)}
                  >
                    Reject
                  </Button>
                </div>
              )}
              <p className="text-caption text-text-muted">Approving puts it on sale at once.</p>
            </div>
          )}
          <div className="mt-4 space-y-2">
            {event.status === 'PUBLISHED' && (
              <>
                <p className="text-sm text-text-secondary">On sale.</p>
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={setStatus.isPending}
                  onClick={() => setPausing(true)}
                >
                  Pause sales
                </Button>
              </>
            )}
            {event.status === 'PAUSED' && (
              <>
                <p className="text-sm text-text-secondary">
                  {event.pausedByAdmin
                    ? 'Paused by the platform team. The organizer cannot resume it.'
                    : 'Paused by the organizer.'}
                </p>
                {/* What the organizer was told, so whoever answers their reply sees the same words. */}
                {event.pausedByAdmin && event.pausedByAdminReason ? (
                  <p className="break-words text-sm text-text-primary">
                    Reason sent to the organizer: {event.pausedByAdminReason}
                  </p>
                ) : null}
                {event.pausedByAdmin ? (
                  <p className="text-caption text-text-muted">
                    Putting it back on sale tells the organizer by email and in their console.
                  </p>
                ) : null}
                <Button
                  variant="outline"
                  className="w-full"
                  loading={setStatus.isPending && setStatus.variables?.status === 'PUBLISHED'}
                  disabled={setStatus.isPending}
                  onClick={() => setStatus.mutate({ status: 'PUBLISHED' })}
                >
                  Put back on sale
                </Button>
              </>
            )}
          </div>
        </Card>

        {/*
          Cancelling and deleting are not review decisions. They sit in their own section, away
          from Approve and Reject, so a reviewer's thumb does not land on them, and each one
          asks again before it acts.
        */}
        <Card title="Danger zone" className="border-status-error/40 lg:col-span-3">
          <p className="mb-3 text-sm text-text-secondary">
            These actions change what buyers can do and cannot be undone from here. Each one asks
            you to confirm.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            {['PUBLISHED', 'PAUSED', 'UNDER_REVIEW'].includes(event.status) && (
              <Button variant="danger" className="sm:w-auto" onClick={() => setConfirmCancel(true)}>
                Cancel event
              </Button>
            )}
            {/*
              Delete, which the console had no way to do at all - an admin could cancel an
              event and nothing more, so a duplicate or a test event stayed on the books
              forever. The API refuses one that has ANY booking against it, including an
              expired hold, and says so; this surfaces that refusal rather than hiding the
              button, because "why can I not delete this" is the question worth answering.
            */}
            <Button variant="danger" className="sm:w-auto" onClick={() => setConfirmDelete(true)}>
              Delete event
            </Button>
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
              onClick={() => setStatus.mutate({ status: 'CANCELLED' })}
            >
              Cancel event
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-secondary">
          Nothing more can be sold and the event cannot be put back on sale. Bookings already made
          are not refunded by this: refund them from Refunds, or ask the organizer to.
        </p>
      </Dialog>

      <Dialog
        open={pausing}
        onClose={() => setPausing(false)}
        title={`Pause sales for ${event.title}?`}
        footer={
          <>
            <Button variant="outline" onClick={() => setPausing(false)}>
              Keep selling
            </Button>
            <Button
              loading={setStatus.isPending}
              disabled={!pauseReason.trim()}
              onClick={() => setStatus.mutate({ status: 'PAUSED', reason: pauseReason.trim() })}
            >
              Pause sales
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-text-secondary">
            Tickets stop selling the moment you confirm. Tickets already sold stay valid. The
            organizer is told by email and in their console, with your reason, and cannot resume it
            themselves.
          </p>
          <Textarea
            label="Why are you pausing it?"
            rows={3}
            maxLength={500}
            value={pauseReason}
            hint="Sent to the organizer as you write it, and recorded in the audit log with your name."
            onChange={(e) => setPauseReason(e.target.value)}
          />
        </div>
      </Dialog>

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${event.title}?`}
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
              Delete permanently
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-secondary">
          This removes the event, its sessions and its ticket types. It is refused if anybody has
          ever booked against it - even a cancelled booking or an expired hold - because those
          records outlive the event. Cancel it instead in that case, which keeps the record and
          stops the sales.
        </p>
      </Dialog>
    </div>
  );
}
