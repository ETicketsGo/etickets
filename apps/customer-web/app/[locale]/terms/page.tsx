import type { Metadata } from 'next';
import { Container, Section } from '@/components/marketing/kit';
import { PageHero, Prose } from '@/components/marketing/blocks';
import { BUSINESS_DETAILS, publishedDetail } from '@eticketsgo/web-kit';
import { Link } from '@/i18n/navigation';

export const metadata: Metadata = {
  title: 'Terms & Conditions',
  description: 'The terms governing use of the ETicketsGo platform.',
  alternates: { canonical: '/terms' },
  robots: { index: false, follow: true },
};

export default function TermsPage() {
  const operator = publishedDetail(BUSINESS_DETAILS.legalName);

  return (
    <>
      <PageHero
        eyebrow="Legal"
        title="Terms & Conditions"
        lead="The terms that govern your use of ETicketsGo."
      />
      <Section>
        <Container className="max-w-3xl space-y-8">
          <Prose>
            {/*
              Derived, never invented. The operating legal entity is a commitment only the
              business can make, so this line appears when `legalName` is published and is
              simply absent until then - rather than announcing our own drafting status to
              customers. The footer's self-retiring notice already discloses the gap.
            */}
            {operator ? (
              <p>
                <strong>Operator:</strong> {operator}
              </p>
            ) : null}
            <h2>1. Overview</h2>
            <p>
              ETicketsGo is a ticketing platform connecting event <strong>Organizers</strong> with{' '}
              <strong>Customers</strong>. We provide the technology to list events, sell tickets,
              process payments, and manage entry. Organizers are responsible for their events;
              ETicketsGo is not the event provider unless expressly stated.
            </p>
            <h2>2. Accounts</h2>
            <ul>
              <li>Provide accurate information and keep your credentials secure.</li>
              <li>You are responsible for activity under your account.</li>
              <li>We may suspend accounts for violations, fraud, or security risk.</li>
            </ul>
            <h2>3. Buying tickets</h2>
            <p>
              Prices, fees, and the final total are shown before payment. A ticket is issued on
              successful payment and is subject to the Organizer&apos;s event terms. Tickets contain
              a secure, single-use entry credential; reproduction or resale outside permitted
              channels may void them.
            </p>
            <h2>4. Refunds & cancellations</h2>
            <p>
              Refunds follow the <Link href="/refunds">Refund Policy</Link> and the Organizer&apos;s
              stated policy. If an Organizer cancels an event, refund handling is described there.
            </p>
            <h2>5. Organizers</h2>
            <p>
              Organizers additionally agree to the{' '}
              <Link href="/organizer-agreement">Organizer Agreement</Link>, including accurate
              listings, honoring valid tickets, and lawful operation of their events.
            </p>
            <h2>6. Acceptable use</h2>
            <p>
              No fraud, unauthorized access, interference with the platform, unlawful content, or
              circumvention of security or entry controls.
            </p>
            <h2>7. Intellectual property</h2>
            <p>
              The platform, its software, and branding are owned by ETicketsGo. Organizer and
              Customer content remains theirs, with a license for us to operate the service.
            </p>
            <h2>8. Disclaimers & liability</h2>
            <p>
              The service is provided &quot;as is&quot; to the extent permitted by law. We are not
              liable for an Organizer&apos;s event, its cancellation, or its conduct; our
              responsibility is the ticketing platform itself.
            </p>
            <h2>9. Text messages</h2>
            <p>
              If you give us your mobile number and agree to text messages, we send you messages
              about your account and your tickets - confirmations, entry details, and changes to an
              event you booked. Message frequency depends on your activity. Message and data rates
              may apply. Reply <strong>STOP</strong> to any message to stop receiving them, or{' '}
              <strong>HELP</strong> for help. Agreeing to text messages is not a condition of buying
              a ticket. See the <Link href="/sms">text message programme</Link> for the full
              details.
            </p>
            <h2>10. Privacy</h2>
            <p>
              Personal data is handled per the <Link href="/privacy">Privacy Policy</Link>.
            </p>
            <h2>11. Changes</h2>
            <p>We may update these terms; material changes will be communicated.</p>
            <h2>12. Contact</h2>
            <p>
              Use the form on the <Link href="/contact">contact page</Link>. It reaches our support
              team. We have not published a postal address or phone number yet.
            </p>
          </Prose>
        </Container>
      </Section>
    </>
  );
}
