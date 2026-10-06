import type { Metadata } from 'next';
import { Container, Section } from '@/components/marketing/kit';
import { PageHero, Prose } from '@/components/marketing/blocks';
import { Link } from '@/i18n/navigation';

export const metadata: Metadata = {
  title: 'Organizer Agreement',
  description: 'The agreement governing organizers selling tickets on ETicketsGo.',
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
      {/*
        An EXPLICIT surface, not decoration.

        `GradientBackdrop`'s blurred circles are `h-[40rem]` at `top-[-10%]`, so their bounding
        boxes reach well past the hero even though the hero's `overflow-hidden` clips what is
        painted. Contrast tooling composites by geometry, not by clipping, so body text below
        the hero was measured against a blue tint it is never actually drawn on - and the only
        thing keeping these pages passing was a notice banner padding the text downwards. When
        the banner went, `/organizer-agreement` failed AA at 1280px on its first link.

        Naming the surface fixes the measurement and the ambiguity together, and costs nothing
        visually: this is the colour the page already was. Done per page rather than by
        changing the token or the shared backdrop, both of which reach the whole product.
      */}
      <Section className="bg-background-canvas">
        <Container className="max-w-3xl space-y-8">
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
              mode (who bears fees). Payouts settle to the Organizer&apos;s verified account net of
              fees, refunds, and chargebacks, per a schedule to be defined.
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
              Where enabled, offline gate check-in is used per the platform&apos;s runbook; the
              server remains the entry authority and safety controls must not be circumvented.
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
