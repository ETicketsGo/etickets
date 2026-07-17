import type { Metadata } from 'next';
import { Container, Section } from '@/components/marketing/kit';
import { PageHero, NoticeBanner, Prose } from '@/components/marketing/blocks';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description:
    'How ETicketsGo collects, uses, and protects personal data (draft pending legal review).',
  alternates: { canonical: '/privacy' },
  robots: { index: false, follow: true },
};

export default function PrivacyPage() {
  return (
    <>
      <PageHero
        eyebrow="Legal"
        title="Privacy Policy"
        lead="How we collect, use, and protect your data."
      />
      <Section>
        <Container className="max-w-3xl space-y-8">
          <NoticeBanner>
            This is a <strong>draft for demonstration</strong>. Retention periods and data-subject
            rights mechanics require privacy/legal counsel before publication.
          </NoticeBanner>
          <Prose>
            <p>
              <strong>Controller:</strong> ETicketsGo (placeholder) ·{' '}
              <strong>Effective date:</strong> pending.
            </p>
            <h2>1. Data we collect</h2>
            <ul>
              <li>Account: name, email, password hash (bcrypt), roles.</li>
              <li>Orders: buyer and ticket-holder name and email.</li>
              <li>Payments: provider references only — no card numbers or CVV are stored.</li>
              <li>Security: refresh-token hashes, IP, and user-agent; an immutable audit log.</li>
              <li>Notifications: recipient email, phone, or push tokens.</li>
            </ul>
            <h2>2. How we use data</h2>
            <p>
              To provide the service (accounts, ticketing, payments, entry), for security and fraud
              prevention, support, legal compliance, and — where permitted — service communications.
            </p>
            <h2>3. Sharing</h2>
            <p>
              Organizers receive attendee data needed to run their events; payment providers process
              payments; sub-processors (email/SMS/push, hosting, monitoring) operate under contract.
              We disclose data where legally required.
            </p>
            <h2>4. Retention</h2>
            <p>
              Concrete retention periods per data category are to be defined with counsel. A
              self-serve data export/erasure workflow is a planned follow-up; until then, requests
              are handled operationally.
            </p>
            <h2>5. Your rights</h2>
            <p>
              Access, rectification, erasure, portability, and objection — scoped by your
              jurisdiction. Requests via the <a href="/contact">contact page</a>.
            </p>
            <h2>6. Security</h2>
            <p>
              Encryption in transit (TLS), hashed passwords, least-privilege authorization, audit
              logging, secret management, and fail-closed production configuration.
            </p>
            <h2>7. Children</h2>
            <p>The service is not directed to children; we do not knowingly collect their data.</p>
            <h2>8. Changes & contact</h2>
            <p>
              We may update this policy; material changes will be communicated. Contact details are
              placeholders in this demo.
            </p>
          </Prose>
        </Container>
      </Section>
    </>
  );
}
