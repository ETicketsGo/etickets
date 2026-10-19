'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { ChevronLeft, MessageSquareWarning } from 'lucide-react';
import { Panel } from '@/components/marketing/blocks';
import { BRAND_WRAP, BrandPage } from '@/components/storefront-brand';
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
    <BrandPage>
      <div className={`${BRAND_WRAP} pt-8 lg:pt-14`}>
        <div className="mx-auto max-w-xl space-y-5">
          <Link
            href="/help"
            className="inline-flex min-h-11 items-center gap-1 rounded-sm text-brand-meta font-medium text-brand-ink-2 transition-colors hover:text-brand-gold-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-focus focus-visible:ring-offset-2 focus-visible:ring-offset-brand-canvas"
          >
            <ChevronLeft aria-hidden className="h-4 w-4" />
            Back to help center
          </Link>
          <div>
            <h1 className="flex items-center gap-2 font-brand-display text-brand-d2 text-brand-ink">
              <MessageSquareWarning className="h-6 w-6 text-brand-caution" />
              Make a complaint
            </h1>
            <p className="mt-3 text-brand-ui text-brand-ink-2">
              Tell us what went wrong with an event you booked. We record it against the organizer,
              pass it to the person they have named to answer complaints, and follow it up
              ourselves.
            </p>
          </div>
          {/*
        The query string is read inside a boundary, not at the top of the page.

        `useSearchParams` opts a page out of being rendered ahead of time, and Next refuses to
        build one that reads it with nothing to show meanwhile. Everything above is the same for
        every visitor and is still prerendered; only the form waits for the URL.
      */}
          <Suspense fallback={<Panel>Loading the form...</Panel>}>
            <ComplaintFormCard />
          </Suspense>
          <p className="text-brand-meta text-brand-ink-2">
            If your complaint is about money you are owed, ask for a refund from the booking instead
            - that reaches the organizer straight away. A complaint is for when something was wrong
            with the event itself, or when a refund has not been dealt with.
          </p>
        </div>
      </div>
    </BrandPage>
  );
}

function ComplaintFormCard() {
  const params = useSearchParams();
  const bookingId = params.get('booking') ?? undefined;

  return (
    <Panel>
      {bookingId && (
        <p className="mb-4 text-brand-meta text-brand-ink-2">
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
    </Panel>
  );
}
