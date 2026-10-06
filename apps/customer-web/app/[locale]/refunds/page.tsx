import type { Metadata } from 'next';
import { Container, Section } from '@/components/marketing/kit';
import { PageHero, NoticeBanner, Prose } from '@/components/marketing/blocks';
import { Link } from '@/i18n/navigation';

export const metadata: Metadata = {
  title: 'Refund Policy',
  description:
    'When you can get a refund on ETicketsGo, what comes back, and what happens if an event is cancelled.',
  alternates: { canonical: '/refunds' },
  robots: { index: false, follow: true },
};

/*
  ── WHY THIS PAGE CHANGED ──────────────────────────────────────────────────────────
  It used to say: "We have not decided whether fees are refundable, or how cancellations
  work." Both are now decided, and the second one is decided in CODE, not only on paper:

    - Fees, when the BUYER asks. The refund returns the ticket price and the tax charged on
      it; fees stay. That was already the behaviour and the business has ratified it.
    - Fees, when WE cancel. The buyer gets back everything they paid, fees included. They did
      not cancel, so they do not absorb our fee for it. Same refund machinery, one different
      figure - see `sessionCancelled` in `refunds.service.ts`.
    - Cancellation. A cancelled show opens a refund for every paid booking automatically,
      through the ordinary refund queue. See `cancellation-refunds.service.ts`.

  Every sentence below describes behaviour the platform performs. Nothing here is a promise
  the product cannot keep - which is the only reason the draft notice could be narrowed.

  What is NOT claimed: a refund right when a show is MOVED rather than cancelled. That rule
  is not implemented, so the page does not offer it.

  Written to ASD-STE100: short sentences, one idea each, active voice, no legal throat-clearing.
*/
export default function RefundsPage() {
  return (
    <>
      <PageHero
        eyebrow="Legal"
        title="Refund Policy"
        lead="When you can get a refund, what comes back, and what happens if an event is cancelled."
      />
      <Section>
        <Container className="max-w-3xl space-y-8">
          <NoticeBanner>
            A lawyer has not yet reviewed this page. The rules below are the rules the platform
            applies today.
          </NoticeBanner>
          <Prose>
            <h2>The event sets the refund window</h2>
            <p>
              Each organizer decides two things for their own event: whether they offer refunds, and
              how long before the start the window closes. Most events close the window 48 hours
              before the start.
            </p>
            <p>
              <strong>The event page tells you before you buy.</strong> If you are not sure, look at
              the event page again before you pay.
            </p>

            <h2>How to ask for a refund</h2>
            <p>
              Ask from your booking or your tickets. If you bought as a guest, use the link in your
              confirmation email.
            </p>
            <p>
              We check your request against the rules on this page and send it to the organizer. You
              can see the status change from Requested to Completed or Rejected. We keep a record of
              each step.
            </p>

            <h2>What comes back</h2>
            <p>What you get back depends on who cancelled.</p>
            <p>
              <strong>If you ask for the refund:</strong> you get the price of the tickets you
              return, and the tax charged on those tickets. Booking fees and payment fees are not
              returned. These pay for the service you have already used.
            </p>
            <p>
              <strong>If the organizer or ETicketsGo cancels:</strong> you get back the full amount
              you paid for that booking. That includes the tickets, the tax, and our fees. You did
              not cancel, so you do not pay our fee for it.
            </p>
            <p>
              You can return some of your tickets and keep the rest. We never refund more than you
              paid.
            </p>

            <h2>If the organizer cancels the event</h2>
            <p>
              <strong>You do not need to ask.</strong> When an organizer cancels a show, we open a
              refund for every paid booking on it.
            </p>
            <p>
              The refund window does not apply. If the organizer has turned refunds off for that
              event, that does not apply either. The show is not happening, so the money comes back.
            </p>
            <p>
              <strong>You get back the full amount you paid</strong> for that booking - the tickets,
              the tax, and the booking and payment fees. This is the one case where our fees come
              back, because you are not the one who cancelled.
            </p>
            <p>
              We tell you that the show is cancelled, and you can see the refund on your booking. A
              person at the organizer or at ETicketsGo then approves the payment.
            </p>

            <h2>If the organizer changes the event</h2>
            <p>
              An organizer can move a show to a new time or a new place. If this happens, we tell
              you. Contact the organizer or <Link href="/contact">contact us</Link> if the new time
              or place does not work for you.
            </p>

            <h2>Tickets you have used</h2>
            <p>A ticket that has been scanned at the gate has been used. You cannot refund it.</p>

            <h2>Free events</h2>
            <p>You paid nothing, so there is nothing to refund. Cancel your booking instead.</p>

            <h2>Cash payments</h2>
            <p>
              If you paid cash at the venue, the venue gives the cash back. We cannot refund cash
              online.
            </p>

            <h2>Card disputes</h2>
            <p>
              If you dispute a payment with your bank, we follow the process your bank and our
              payment provider require. We then check the result against our own records.
            </p>

            <h2>Questions</h2>
            <p>
              Use the form on our <Link href="/contact">contact page</Link>. It reaches our support
              team. Also read our <Link href="/terms">Terms</Link>.
            </p>
          </Prose>
        </Container>
      </Section>
    </>
  );
}
