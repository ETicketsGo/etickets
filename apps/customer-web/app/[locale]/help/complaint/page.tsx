'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { ChevronLeft, MessageSquareWarning } from 'lucide-react';
import { Card } from '@/components/ui';
import { FeedbackForm } from '@/components/feedback-form';
import { Link } from '@/i18n/navigation';

/**
 * Raising a complaint about an organizer.
 *
 * ── WHY THIS IS NOT THE CONTACT FORM ───────────────────────────────────────────────
 * A complaint and a question are different things and the platform has to treat them
 * differently. Until now every grievance arrived as a general CONTACT message with nothing
 * attaching it to the organizer it was about, so nobody could answer "how many complaints are
 * open against this seller" - which is the question that decides whether a seller keeps selling,
 * and which a marketplace selling to the public is expected to be able to answer.
 *
 * ── WHY THE BOOKING TRAVELS AND THE ORGANIZER DOES NOT ─────────────────────────────
 * The form sends the booking id. The API looks up who sold that booking and records the
 * complaint against them. If the organizer came from the page, anybody could file complaints
 * against a seller they never bought from, and the count an admin acts on would be worthless.
 *
 * A complaint with no booking is still accepted - somebody who cannot find their booking still
 * has a grievance - it is simply not attributed to a seller.
 */
export default function ComplaintPage() {
  return (
    <div className="mx-auto max-w-xl space-y-5">
      <Link
        href="/help"
        className="inline-flex items-center gap-1 text-caption text-text-muted transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <ChevronLeft className="h-4 w-4" />
        Back to help center
      </Link>
      <div>
        <h1 className="flex items-center gap-2 text-h2 font-bold tracking-tight text-text-primary">
          <MessageSquareWarning className="h-6 w-6 text-status-warning" />
          Make a complaint
        </h1>
        <p className="mt-1 text-[0.9375rem] text-text-muted">
          Tell us what went wrong with an event you booked. We record it against the organizer,
          pass it to the person they have named to answer complaints, and follow it up ourselves.
        </p>
      </div>
      {/*
        The query string is read inside a boundary, not at the top of the page.

        `useSearchParams` opts a page out of being rendered ahead of time, and Next refuses to
        build one that reads it with nothing to show meanwhile. Everything above is the same for
        every visitor and is still prerendered; only the form waits for the URL.
      */}
      <Suspense fallback={<Card>Loading the form...</Card>}>
        <ComplaintFormCard />
      </Suspense>
      <p className="text-caption text-text-muted">
        If your complaint is about money you are owed, ask for a refund from the booking instead -
        that reaches the organizer straight away. A complaint is for when something was wrong with
        the event itself, or when a refund has not been dealt with.
      </p>
    </div>
  );
}

function ComplaintFormCard() {
  const params = useSearchParams();
  const bookingId = params.get('booking') ?? undefined;

  return (
    <Card>
      {bookingId && (
        <p className="mb-4 text-caption text-text-muted">
          This complaint is about the booking you came from, so you do not have to find its
          reference.
        </p>
      )}
      <FeedbackForm
        kind="COMPLAINT"
        showSubject
        bookingId={bookingId}
        submitLabel="Send complaint"
        successMessage="Your complaint has been recorded."
        messageLabel="What went wrong?"
        messagePlaceholder="Say what happened, when, and what you would like done about it."
      />
    </Card>
  );
}
