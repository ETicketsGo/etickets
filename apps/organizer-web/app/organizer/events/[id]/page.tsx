'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  api,
  Button,
  Card,
  Dialog,
  Skeleton,
  SkeletonCard,
  ErrorState,
  useToast,
  errorMessage,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import { SellabilityPanel } from '@/components/sellability-panel';
import { PendingImageUploads } from '@/components/image-upload-status';
import { ReadMore } from '@/components/events/read-more';
import {
  QuickLinks,
  SalesSection,
  SessionsSection,
  TicketsSection,
} from '@/components/events/overview-sections';
import { ManageTiles, OverviewLead } from '@/components/events/overview-lead';
import { timeAtVenue } from '@/components/events/event-list-model';
import { useEventSaleState } from '@/components/events/event-header';
import {
  hasSessionToday,
  nextStepOf,
  saleStateOf,
  setupOf,
} from '@/components/events/event-lifecycle';

/*
  ── THE ORDER OF THIS PAGE ─────────────────────────────────────────────────────────
  1. Where the event stands - stage, sales, setup, each in its own words - and the ONE thing
     to do next, with every other action in a labelled "More" menu.
  2. The four places an organizer goes from here, each with its live fact.
  3. What stops a sale, when anything does (the "See what to fix" target).
  4. The figures: tickets, sales, sessions. Then what the event IS, which the organizer wrote
     and rarely needs to reread.
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
  // The configuration check, for the setup checklist and what to fix.
  const sellability = useQuery({
    queryKey: ['event-sellability', id],
    queryFn: () => api.events.sellability(id),
    staleTime: 0,
    retry: false,
  });

  /*
    Whether it is selling: the server's unified answer over every upcoming show (the event and
    show status, each ticket type's window and places, and checkout's sale-eligibility rule).
    The same answer the Overview and the event list show, so the three cannot disagree.
    Owners and managers only; anybody else sees "Sale check unavailable", never a guess.
  */
  const orgId = event?.organizationId;
  const saleQ = useEventSaleState(id, orgId);
  const saleAnswer = saleQ.data?.events.find((e) => e.eventId === id);

  const owningOrg = orgSentenceName(event?.organizationId);

  // What changed, in a sentence: "Resume succeeded." told nobody whether tickets were on sale.
  const onSuccess = (sentence: string) => () => {
    toast.push(sentence, 'success');
    qc.invalidateQueries({ queryKey: ['event', id] });
    qc.invalidateQueries({ queryKey: ['event-sellability', id] });
    qc.invalidateQueries({ queryKey: ['organizer-event-sale-states'] });
  };
  const onError = (e: unknown) => toast.push(errorMessage(e), 'error');

  const submit = useMutation({
    mutationFn: () => api.events.submit(id),
    // An organization trusted to publish without review goes straight on sale.
    onSuccess: (ev) =>
      onSuccess(
        ev?.status === 'PUBLISHED'
          ? 'Published. Tickets are on sale.'
          : 'Sent for review. Tickets go on sale once it is approved.',
      )(),
    onError,
  });
  const pause = useMutation({
    mutationFn: () => api.events.pause(id),
    onSuccess: onSuccess('Sales paused. Nobody can buy until you resume.'),
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
        onSuccess('Sales resumed. Tickets are on sale again.')();
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

  const state = useMemo(() => {
    if (!event) return null;
    const now = Date.now();
    const check = sellability.data;
    const sale = saleStateOf({ answer: saleAnswer, failed: saleQ.isError });
    const issues = check ? [...check.blockers, ...check.warnings] : [];
    const setup = setupOf({
      eventId: event.id,
      description: event.description,
      hasImage: !!event.imagePath,
      issues,
    });
    const ownBlockers = (check?.blockers ?? []).filter((b) => b.owner !== 'PLATFORM').length;
    const next = nextStepOf({
      eventId: event.id,
      status: event.status,
      pausedByAdmin: event.pausedByAdmin,
      needsReviewOnResume: event.needsReviewOnResume,
      sessionToday: hasSessionToday(event.sessions, event.venue, now),
      sale,
      ownBlockers,
    });
    return { sale, setup, next, hasIssues: issues.length > 0 };
  }, [event, sellability.data, saleAnswer, saleQ.isError]);

  if (isError)
    return (
      <ErrorState message="We couldn't load this. Please try again." onRetry={() => refetch()} />
    );
  if (isLoading || !event || !state) return <OverviewSkeleton />;

  return (
    <div className="min-w-0 space-y-6">
      <OverviewLead
        event={event}
        sale={state.sale}
        setup={state.setup}
        next={state.next}
        onSubmit={() => submit.mutate()}
        onResume={() => resume.mutate()}
        onPause={() => pause.mutate()}
        onDelete={() => setConfirmDelete(true)}
        busy={{ submit: submit.isPending, resume: resume.isPending, pause: pause.isPending }}
      />

      {/* Images picked in the wizard that are not on the event yet, on the device that has them. */}
      <PendingImageUploads
        eventId={id}
        onUploaded={() => qc.invalidateQueries({ queryKey: ['event', id] })}
      />

      <ManageTiles event={event} />

      <div className="grid min-w-0 gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          {/*
            Only when there is something to say. With nothing wrong the panel used to say
            "Ready to sell" - for drafts too - which the stage and sales line above now answer
            correctly.
          */}
          {state.hasIssues ? (
            <section id="readiness" aria-label="What stops a sale" className="scroll-mt-24">
              <SellabilityPanel eventId={id} />
            </section>
          ) : null}

          <TicketsSection event={event} />
          <SalesSection event={event} />
          <SessionsSection event={event} />
        </div>

        <div className="min-w-0 space-y-6">
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
            <dl className="mt-5 grid grid-cols-1 gap-y-3 border-t border-border pt-4 text-[0.9375rem]">
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
                [
                  'Fee handling',
                  event.isFree
                    ? 'Free event'
                    : event.feeMode.charAt(0) +
                      event.feeMode.slice(1).toLowerCase().replaceAll('_', ' '),
                ],
                [
                  'Published',
                  event.publishedAt ? timeAtVenue(event.publishedAt, event.venue) : 'Not yet',
                ],
              ].map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-caption text-text-muted">{label}</dt>
                  <dd className="break-words text-text-primary [overflow-wrap:anywhere]">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
            {event.reviewNote && (
              <p className="mt-4 break-words rounded-md bg-tint-warning p-3 text-[0.9375rem] text-status-warning">
                Reviewer note: {event.reviewNote}
              </p>
            )}
          </Card>
          <QuickLinks eventId={id} />
        </div>
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
            The EVENT's own organization, not the switcher's: an organizer reaches this page by
            link as well as by browsing, so naming the active organization could state something
            false about what is being deleted.
          */}
          {owningOrg ? <> in {owningOrg}</> : null} will be deleted, with its sessions, ticket types
          and images. This cannot be undone.
        </p>
      </Dialog>
    </div>
  );
}

/**
 * The event page while it loads, in its own shape: the lead card, a row of manage tiles, then
 * the main column and the side column. The single grey block it had was 256px tall and the
 * page is several times that, so everything below jumped when the data arrived.
 */
function OverviewSkeleton() {
  return (
    <div className="min-w-0 space-y-6" role="status" aria-busy="true" aria-label="Loading event">
      <div className="space-y-4 rounded-lg border border-border bg-background-surface p-5">
        <div className="flex gap-2">
          <Skeleton className="h-6 w-24 rounded-full" />
          <Skeleton className="h-6 w-32 rounded-full" />
        </div>
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-10 w-40" />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} variant="stat" label="Loading" />
        ))}
      </div>
      <div className="grid min-w-0 gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Skeleton className="h-48 w-full rounded-lg" />
          <Skeleton className="h-56 w-full rounded-lg" />
        </div>
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    </div>
  );
}
