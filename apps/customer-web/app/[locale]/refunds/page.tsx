import type { Metadata } from 'next';
import { Container, Section } from '@/components/marketing/kit';
import { PageHero, NoticeBanner, Prose } from '@/components/marketing/blocks';
import { Link } from '@/i18n/navigation';

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
            This is a <strong>draft for the demo</strong>. We have not decided whether fees are
            refundable, or how cancellations work. A lawyer has not reviewed it.
          </NoticeBanner>
          <Prose>
            <h2>How refunds work</h2>
            <p>Two things decide whether a booking can be refunded:</p>
            <ul>
              <li>
                <strong>The state of the booking.</strong> It must be confirmed. A booking that is
                already cancelled or refunded is not eligible.
              </li>
              <li>
                <strong>The refund window.</strong> You can refund up to a cut-off before the
                session, which defaults to <strong>48 hours</strong>. An Organizer can set a
                different window on each event.
              </li>
              <li>
                After the window closes, or once the ticket has been used at the gate, it cannot be
                refunded. The Organizer or the law can still require a refund.
              </li>
            </ul>
            <h2>Requesting a refund</h2>
            <p>
              Customers ask from their booking or tickets page. We check the request against the
              rules above and pass it to the Organizer. The status moves from Requested to
              Processing, and then to Completed or Rejected. We record every step.
            </p>
            <h2>Event cancellation</h2>
            <p>
              We have not settled what happens when an Organizer cancels an event, or changes it a
              lot. Automatic full refunds are one option.
            </p>
            <h2>Disputes</h2>
            <p>
              We handle chargebacks and disputes the way the payment provider requires. We then
              match the result against our own records.
            </p>
            <h2>Contact</h2>
            <p>
              Still have a question? See the <Link href="/faq">FAQ</Link> or{' '}
              <Link href="/contact">contact us</Link>.
            </p>
          </Prose>
        </Container>
      </Section>
    </>
  );
}
