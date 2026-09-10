'use client';

import { useQuery } from '@tanstack/react-query';
import { api, Card, Skeleton, type SellabilityIssue } from '@eticketsgo/web-kit';
import Link from 'next/link';

/**
 * Whether anybody could actually buy a ticket for this event, said before they try.
 *
 * ── WHY THIS PANEL EXISTS ──────────────────────────────────────────────────────────
 * Every problem it lists was already detected — at CHECKOUT. A cinema went live with a seat
 * category that had never been mapped to a regulatory class, and because Andhra Pradesh caps
 * prices per class the sale was refused, correctly. The person who met that refusal was a
 * customer, after picking their seats, and the sentence shown to them was about our
 * configuration: "Seat category PR has no regulatory seat class."
 *
 * The organizer found out because a stranger failed to buy from them. Every fact needed to
 * know it was in the database before the event was published.
 *
 * ── WHY BLOCKERS AND WARNINGS LOOK DIFFERENT ───────────────────────────────────────
 * A blocker is a sale that will be refused, and publishing is prevented until it is gone. A
 * warning is a sale that will SUCCEED and is probably not what was meant — a dollar price on
 * an Indian venue takes money perfectly well, which is exactly why nothing else catches it.
 *
 * Showing them the same way would either block publishing over a judgement call, or bury a
 * refusal among advisories. They are different claims and they read differently.
 */
function Issue({ issue, tone }: { issue: SellabilityIssue; tone: 'blocker' | 'warning' }) {
  const accent =
    tone === 'blocker'
      ? 'border-status-error/40 bg-status-error/5'
      : 'border-status-warning/40 bg-status-warning/5';
  const platform = issue.owner === 'PLATFORM';
  return (
    <li className={`rounded-md border p-3 ${accent}`}>
      <div className="flex flex-wrap items-center gap-2">
        {/*
          Who owns it, said before the sentence itself.

          An organizer reading a list of faults is deciding what to do next, and the first
          thing worth knowing is whether any of it is theirs. Without this they read every
          card as a task.
        */}
        <span
          className={`rounded-full px-2 py-0.5 text-caption font-medium ${
            platform
              ? 'bg-surface-muted text-text-secondary'
              : 'bg-status-error/15 text-status-error'
          }`}
        >
          {platform ? 'We are fixing this' : 'You can fix this'}
        </span>
        {/*
          One fault, however many shows carry it. The count replaces what used to be one
          identical card per show — 148 of them on a season of a film, each naming a
          different date, with no way to see they were one problem.
        */}
        {issue.affectedSessions > 1 && (
          <span className="text-caption text-text-secondary">
            {issue.affectedSessions} shows affected
          </span>
        )}
      </div>
      <p className="mt-2 text-sm font-medium text-text-primary">{issue.message}</p>
      {/* The fix, always. A problem statement with no next action is a complaint. */}
      <p className="mt-1 text-caption text-text-secondary">{issue.fix}</p>
      {/*
        A link only where one leads somewhere. `fixPath` is null for everything the organizer
        cannot reach, and offering "Go and fix this" for those was the original defect: it
        sent people to hunt for a control that does not exist.
      */}
      {issue.fixPath && (
        <Link
          href={issue.fixPath}
          className="mt-2 inline-block rounded text-caption text-brand-primary underline underline-offset-2 hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary"
        >
          Go and fix this
        </Link>
      )}
    </li>
  );
}

export function SellabilityPanel({ eventId }: { eventId: string }) {
  const q = useQuery({
    queryKey: ['event-sellability', eventId],
    queryFn: () => api.events.sellability(eventId),
    /*
      Re-read whenever this screen is returned to. An organizer who has just gone off to map
      a seat class comes back here to check, and a cached "still broken" would tell them
      their fix did not work.
    */
    staleTime: 0,
  });

  if (q.isLoading) return <Skeleton className="h-32 w-full" />;
  /*
    Silent on failure. This panel is a second opinion about configuration; if it cannot load,
    saying so would add an error to a page about errors, and checkout still enforces every
    one of these rules regardless.
  */
  if (q.isError || !q.data) return null;

  const { blockers, warnings, sellable } = q.data;

  if (sellable && warnings.length === 0) {
    return (
      <Card title="Ready to sell">
        <p className="text-sm text-text-secondary">
          Nothing is standing between this event and a completed purchase.
        </p>
      </Card>
    );
  }

  return (
    <Card title={sellable ? 'Worth checking before you publish' : 'This event cannot be sold yet'}>
      {blockers.length > 0 && (
        <>
          <p className="mb-3 text-sm text-text-secondary">
            {/*
              What actually happens, not "there are validation errors". The listing going live
              while the checkout refuses is the specific outcome being prevented, and an
              organizer weighing whether to care deserves to know it.
            */}
            Customers would reach the seat map and be turned away at the last step. Publishing is
            blocked until these are fixed.{' '}
            {/*
              Whether any of it is theirs, in the first sentence they read.

              "Publishing is blocked until these are fixed" is true and, when every fault
              belongs to the platform, reads as an instruction to somebody who has no way to
              carry it out. That was the whole complaint.
            */}
            {blockers.every((b) => b.owner === 'PLATFORM')
              ? 'None of these are yours to fix — the platform team has been told, and this event can be published once they are resolved.'
              : blockers.some((b) => b.owner === 'PLATFORM')
                ? 'Some of these are ours, not yours; those are marked below.'
                : ''}
          </p>
          <ul className="space-y-2">
            {blockers.map((b, i) => (
              <Issue key={`${b.code}-${b.eventSessionId ?? ''}-${i}`} issue={b} tone="blocker" />
            ))}
          </ul>
        </>
      )}
      {warnings.length > 0 && (
        <>
          <p className={`mb-3 text-sm text-text-secondary ${blockers.length > 0 ? 'mt-5' : ''}`}>
            These will sell. They may not be what you meant.
          </p>
          <ul className="space-y-2">
            {warnings.map((w, i) => (
              <Issue key={`${w.code}-${w.eventSessionId ?? ''}-${i}`} issue={w} tone="warning" />
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
