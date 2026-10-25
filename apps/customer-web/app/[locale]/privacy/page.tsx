import type { Metadata } from 'next';
import { PageHero, Prose } from '@/components/marketing/blocks';
import { Link } from '@/i18n/navigation';
import {
  PolicyUpdated,
  OperatorLine,
  LegalDocument,
  BackToLegal,
} from '@/components/legal/policy-chrome';
import { resolveJurisdiction } from '@/lib/market';
import { INDIA_OPERATOR_SENTENCE } from '@/lib/legal-entity';
import { BrandPage } from '@/components/storefront-brand';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description:
    'How ETicketsGo collects, uses, and protects personal data, including mobile numbers.',
  alternates: { canonical: '/privacy' },
  robots: { index: false, follow: true },
};

export default async function PrivacyPage({
  searchParams,
}: {
  searchParams: Promise<{ country?: string | string[] }>;
}) {
  const country = await resolveJurisdiction((await searchParams).country);

  return (
    <BrandPage>
      <PageHero
        eyebrow="Legal"
        title="Privacy Policy"
        lead="How we collect, use, and protect your data."
      />
      <LegalDocument>
        <BackToLegal />
        <PolicyUpdated type="PRIVACY" country={country} />
        <Prose>
          <h2>1. Data we collect</h2>
          <ul>
            <li>Account: name, email, password hash (bcrypt), roles.</li>
            <li>Orders: buyer and ticket-holder name and email.</li>
            <li>Payments: provider references only - no card numbers or CVV are stored.</li>
            <li>Security: refresh-token hashes, IP, and user-agent; an immutable audit log.</li>
            <li>Notifications: recipient email, phone, or push tokens.</li>
            <li>
              Location: the city we estimate from your network address, to show what is on near you.
              We do not use GPS or your device&apos;s precise location.
            </li>
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
            copy of your data, write to us through the <Link href="/contact">contact page</Link>.
          </p>
          <p>
            You can delete your account yourself at any time: in the ETicketsGo app under Account,
            then Delete account. Without the app, follow the steps on{' '}
            <Link href="/delete-account">Delete your account</Link>. Deleting your account signs you
            out everywhere and removes your name, email address, phone number and preferences.
            Tickets you already bought stay valid. The record of each purchase is kept for tax and
            dispute purposes, with your name and email address removed.
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
            If you give us your mobile number, we use it to send you messages about your account and
            your tickets, and - only if you have separately agreed - messages about other events.
            You can withdraw agreement at any time by replying <strong>STOP</strong> to a message or
            from your notification settings. See the <Link href="/sms">text message programme</Link>
            .
          </p>
          <p>
            <strong>
              We do not sell your mobile number, and we do not share it with third parties or
              affiliates for their own marketing.
            </strong>{' '}
            It is shared only with the messaging providers that deliver messages for us, who may use
            it only for that purpose and under contract, and where the law requires disclosure.
            Agreeing to text messages is never a condition of buying a ticket.
          </p>
          <h2>8. Your country</h2>
          {country === 'IN' ? (
            <p>
              {INDIA_OPERATOR_SENTENCE} Payments for bookings in India are processed by Razorpay,
              which receives the details needed to take the payment. Prices and receipts show GST.
            </p>
          ) : null}
          {country === 'US' ? (
            <p>
              Our text message programme is described in the{' '}
              <Link href="/sms">text message programme</Link>.
            </p>
          ) : null}
          {country === 'CA' ? (
            <p>
              We send commercial messages only where you have agreed to them, and we keep a record
              of when and how you agreed so we can show it on request.
            </p>
          ) : null}
          {country === 'GLOBAL' ? (
            <p>
              Data may be processed in a country other than your own, including the United States
              and India, by us and by the service providers named above.
            </p>
          ) : null}
          <h2>9. The ETicketsGo app</h2>
          <p>
            The Android app uses the same account, booking and payment details as the website, and
            the city estimate described in section 1. It does not use GPS, your contacts, your
            photos or your files.
          </p>
          <p>
            <strong>Payments in the app</strong> are made on the payment provider&apos;s own
            screens: Razorpay for bookings in India and, where we take payment in other countries,
            Stripe. The provider collects your payment details, and some information about your
            device to prevent fraud and to find payment apps installed on your phone, under its own
            privacy policy. We never receive your card number or CVV.
          </p>
          <p>
            Three features are built into the app but are <strong>not switched on</strong> at the
            date of this policy. If we switch one on, the app&apos;s data safety information on
            Google Play will say so first:
          </p>
          <ul>
            <li>
              <strong>Notifications.</strong> If you allow notifications, we store a push token for
              your device so we can tell you about your bookings, for example a changed or cancelled
              show. Signing out or deleting your account removes it.
            </li>
            <li>
              <strong>Crash reports.</strong> If the app crashes, a report goes to our error
              monitoring provider. It identifies your account by its number only: never your name,
              email address, phone number or payment details.
            </li>
            <li>
              <strong>Abuse protection.</strong> To protect sign-in, sign-up and sign-in codes from
              automated abuse, the app may ask Google Play to confirm that it is the genuine
              ETicketsGo app on a genuine device. Google Play handles that check under its own
              terms; we receive only the result, and we do not keep it.
            </li>
          </ul>
          <h2>10. Children</h2>
          <p>The service is not directed to children; we do not knowingly collect their data.</p>
          <h2>11. Changes & contact</h2>
          <p>
            We may update this policy; material changes will be communicated. Reach us through the{' '}
            <Link href="/contact">contact page</Link>.
          </p>
        </Prose>
        <OperatorLine country={country} />
      </LegalDocument>
    </BrandPage>
  );
}
