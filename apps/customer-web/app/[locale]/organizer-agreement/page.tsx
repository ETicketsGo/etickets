import type { Metadata } from 'next';
import { Container, Section } from '@/components/marketing/kit';
import { PageHero, NoticeBanner, Prose } from '@/components/marketing/blocks';
import { Link } from '@/i18n/navigation';

export const metadata: Metadata = {
  title: 'Organizer Agreement',
  description:
    'The agreement governing organizers selling tickets on ETicketsGo (draft pending legal review).',
  alternates: { canonical: '/organizer-agreement' },
  robots: { index: false, follow: true },
};

export default function OrganizerAgreementPage() {
  return (
    <>
      <PageHero
        eyebrow="Legal"
        title="Organizer Agreement"
        lead="The terms for organizers selling tickets and operating events on ETicketsGo."
      />
      <Section>
        <Container className="max-w-3xl space-y-8">
          <NoticeBanner>
            This is a <strong>draft for demonstration</strong>. Payout schedule, tax
            responsibilities, liability, and termination mechanics require business and legal input
            before publication.
          </NoticeBanner>
          <Prose>
            <p>
              By onboarding, the Organizer accepts these terms in addition to the{' '}
              <Link href="/terms">Terms &amp; Conditions</Link>.
            </p>
            <h2>1. Eligibility & onboarding</h2>
            <p>
              The Organizer is authorized to sell tickets for their events and completes payment
              onboarding (merchant account and, where applicable, certification) before receiving
              live payouts.
            </p>
            <h2>2. Listings & honoring tickets</h2>
            <ul>
              <li>Listings must be accurate (event, date, venue, price, terms).</li>
              <li>
                The Organizer will honor all validly issued tickets and operate lawful, safe events.
              </li>
              <li>The Organizer sets and honors its per-event refund policy.</li>
            </ul>
            <h2>3. Fees & payouts</h2>
            <p>
              ETicketsGo charges booking and payment-processing fees; the Organizer selects the fee
              mode (who bears fees). Payouts settle to the Organizer’s verified account net of fees,
              refunds, and chargebacks, per a schedule to be defined.
            </p>
            <h2>4. Data & privacy</h2>
            <p>
              The Organizer receives attendee data solely to operate its events and must comply with
              applicable privacy law, consistent with the{' '}
              <Link href="/privacy">Privacy Policy</Link>.
            </p>
            <h2>5. Compliance</h2>
            <p>
              No illegal events, fraud, misrepresentation, or circumvention of platform controls.
              The Organizer is responsible for taxes and permits for its events.
            </p>
            <h2>6. Offline check-in</h2>
            <p>
              Where enabled, offline gate check-in is used per the platform’s runbook; the server
              remains the entry authority and safety controls must not be circumvented.
            </p>
            <h2>7. Suspension & termination</h2>
            <p>
              We may suspend or terminate for breach, fraud, risk, or legal requirement. Notice,
              cure periods, and effect on pending payouts are to be defined.
            </p>
          </Prose>
        </Container>
      </Section>
    </>
  );
}
