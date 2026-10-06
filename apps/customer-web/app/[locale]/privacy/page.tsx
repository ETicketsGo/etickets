import type { Metadata } from 'next';
import { Container, Section } from '@/components/marketing/kit';
import { PageHero, Prose } from '@/components/marketing/blocks';
import { BUSINESS_DETAILS, publishedDetail } from '@eticketsgo/web-kit';
import { Link } from '@/i18n/navigation';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description:
    'How ETicketsGo collects, uses, and protects personal data, including mobile numbers.',
  alternates: { canonical: '/privacy' },
  robots: { index: false, follow: true },
};

export default function PrivacyPage() {
  const controller = publishedDetail(BUSINESS_DETAILS.legalName);

  return (
    <>
      <PageHero
        eyebrow="Legal"
        title="Privacy Policy"
        lead="How we collect, use, and protect your data."
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
            {/* Derived, never invented - see the note on the terms page. */}
            <p>
              <strong>Controller:</strong> {controller ?? 'ETicketsGo'}
            </p>
            <h2>1. Data we collect</h2>
            <ul>
              <li>Account: name, email, password hash (bcrypt), roles.</li>
              <li>Orders: buyer and ticket-holder name and email.</li>
              <li>Payments: provider references only - no card numbers or CVV are stored.</li>
              <li>Security: refresh-token hashes, IP, and user-agent; an immutable audit log.</li>
              <li>Notifications: recipient email, phone, or push tokens.</li>
            </ul>
            <h2>2. How we use data</h2>
            <p>
              To provide the service (accounts, ticketing, payments, entry), for security and fraud
              prevention, support, legal compliance, and - where permitted - service communications.
            </p>
            <h2>3. Sharing</h2>
            <p>
              Organizers receive attendee data needed to run their events; payment providers process
              payments; sub-processors (email/SMS/push, hosting, monitoring) operate under contract.
              We disclose data where legally required.
            </p>
            <h2>4. Retention</h2>
            <p>
              We keep personal data for as long as we need it to provide the service and to meet our
              legal, tax and accounting obligations, and then delete or anonymise it. To ask for a
              copy of your data or its deletion, write to us through the{' '}
              <Link href="/contact">contact page</Link> and we will action it.
            </p>
            <h2>5. Your rights</h2>
            <p>
              Access, rectification, erasure, portability, and objection - scoped by your
              jurisdiction. Requests via the <Link href="/contact">contact page</Link>.
            </p>
            <h2>6. Security</h2>
            <p>
              Encryption in transit (TLS), hashed passwords, least-privilege authorization, audit
              logging, secret management, and fail-closed production configuration.
            </p>
            <h2>7. Mobile numbers and text messages</h2>
            <p>
              If you give us your mobile number, we use it to send you messages about your account
              and your tickets, and - only if you have separately agreed - messages about other
              events. You can withdraw agreement at any time by replying <strong>STOP</strong> to a
              message or from your notification settings. See the{' '}
              <Link href="/sms">text message programme</Link>.
            </p>
            <p>
              <strong>
                We do not sell your mobile number, and we do not share it with third parties or
                affiliates for their own marketing.
              </strong>{' '}
              It is shared only with the messaging providers that deliver messages for us, who may
              use it only for that purpose and under contract, and where the law requires
              disclosure. Agreeing to text messages is never a condition of buying a ticket.
            </p>
            <h2>8. Children</h2>
            <p>The service is not directed to children; we do not knowingly collect their data.</p>
            <h2>9. Changes & contact</h2>
            <p>
              We may update this policy; material changes will be communicated. Reach us through the{' '}
              <Link href="/contact">contact page</Link>.
            </p>
          </Prose>
        </Container>
      </Section>
    </>
  );
}
