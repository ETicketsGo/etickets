import type { Metadata } from 'next';
import { Container, Section } from '@/components/marketing/kit';
import { PageHero, NoticeBanner, Prose } from '@/components/marketing/blocks';

export const metadata: Metadata = {
  title: 'Refund Policy',
  description: 'How refunds work on ETicketsGo (draft pending final commercial and legal review).',
  alternates: { canonical: '/refunds' },
  robots: { index: false, follow: true },
};

export default function RefundsPage() {
  return (
    <>
      <PageHero
        eyebrow="Legal"
        title="Refund Policy"
        lead="How refunds work for bookings on ETicketsGo."
      />
      <Section>
        <Container className="max-w-3xl space-y-8">
          <NoticeBanner>
            This is a <strong>draft for demonstration</strong>. Fee-refundability and cancellation
            handling are pending a commercial decision and legal review.
          </NoticeBanner>
          <Prose>
            <h2>How refunds work</h2>
            <p>Refund eligibility is enforced by a deterministic rule:</p>
            <ul>
              <li>
                <strong>Refundable state</strong> — a confirmed, un-cancelled booking. Already
                cancelled or refunded bookings are not eligible.
              </li>
              <li>
                <strong>Within the window</strong> — refunds are allowed up to a cut-off before the
                session, defaulting to <strong>48 hours</strong>. Organizers may set a different
                policy per event.
              </li>
              <li>
                After the window, or once entry has occurred, tickets are non-refundable unless the
                Organizer or law requires otherwise.
              </li>
            </ul>
            <h2>Requesting a refund</h2>
            <p>
              Customers request from their booking or tickets page; the request is validated against
              the rule above and routed to the Organizer for processing. Status moves from Requested
              → Processing → Completed or Rejected, and every step is auditable.
            </p>
            <h2>Event cancellation</h2>
            <p>
              If an Organizer cancels or materially changes an event, the platform’s handling (for
              example automatic full refunds) is to be finalized.
            </p>
            <h2>Disputes</h2>
            <p>
              Chargebacks and disputes are handled per the payment provider’s process and the
              platform’s reconciliation workflow.
            </p>
            <h2>Contact</h2>
            <p>
              Refund questions? See the <a href="/faq">FAQ</a> or <a href="/contact">contact us</a>.
            </p>
          </Prose>
        </Container>
      </Section>
    </>
  );
}
