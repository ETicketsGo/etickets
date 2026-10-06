import type { Metadata } from 'next';
import { Container, Section } from '@/components/marketing/kit';
import { PageHero, Prose } from '@/components/marketing/blocks';
import {
  PolicyJurisdictionPicker,
  PolicyMeta,
  jurisdictionFromSearch,
} from '@/components/legal/policy-chrome';
import { legalEntityFor } from '@eticketsgo/shared-types';
import { Link } from '@/i18n/navigation';

export const metadata: Metadata = {
  title: 'Terms & Conditions',
  description: 'The terms governing use of the ETicketsGo platform.',
  alternates: { canonical: '/terms' },
  robots: { index: false, follow: true },
};

export default async function TermsPage({
  searchParams,
}: {
  searchParams: Promise<{ country?: string | string[] }>;
}) {
  const country = jurisdictionFromSearch((await searchParams).country);
  const operator = legalEntityFor(country).legalName;

  return (
    <>
      <PageHero
        eyebrow="Legal"
        title="Terms & Conditions"
        lead="The terms that govern your use of ETicketsGo."
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
          <PolicyJurisdictionPicker type="TERMS" country={country} path="/terms" />
          <PolicyMeta type="TERMS" country={country} />
          <Prose>
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
            {/*
              The country supplement. Every clause here describes behaviour the product
              actually has - inclusive GST and regulated ticket ceilings in India, a
              French-language storefront and a recorded consent trail in Canada, the
              registered messaging programme in the US. Nothing is asserted that the platform
              does not do, and the contracting entity is resolved, never typed.
            */}
            <h2>11. Your country</h2>
            <p>
              You are reading the version for{' '}
              <strong>
                {country === 'GLOBAL'
                  ? 'countries where we have no local entity'
                  : country === 'US'
                    ? 'the United States'
                    : country === 'IN'
                      ? 'India'
                      : 'Canada'}
              </strong>
              . Your contract for a ticket is with <strong>{operator}</strong>, and the market of
              the event you book decides which version applies to that booking.
            </p>
            {country === 'IN' ? (
              <ul>
                <li>
                  Prices are shown inclusive of GST. Your receipt itemises the tax charged on the
                  ticket and on each fee.
                </li>
                <li>
                  Where a state regulates cinema ticket prices, we apply the ceiling that applies at
                  that venue.
                </li>
                <li>Tickets are sold in Indian rupees.</li>
              </ul>
            ) : null}
            {country === 'CA' ? (
              <ul>
                <li>This storefront, your receipt and our emails are available in French.</li>
                <li>
                  We send commercial messages only where you have agreed to them, and we keep a
                  record of when and how you agreed, which you can withdraw at any time.
                </li>
                <li>Tickets are sold in Canadian dollars.</li>
              </ul>
            ) : null}
            {country === 'US' ? (
              <ul>
                <li>Tickets are sold in US dollars.</li>
                <li>
                  Our text message programme and how to leave it are described in the{' '}
                  <Link href="/sms">text message programme</Link>.
                </li>
              </ul>
            ) : null}
            {country === 'GLOBAL' ? (
              <p>
                We have not published a local entity or local supplement for your country yet. These
                terms apply, and the currency and tax shown at checkout follow the country the event
                is in.
              </p>
            ) : null}
            <h2>12. Changes</h2>
            <p>We may update these terms; material changes will be communicated.</p>
            <h2>13. Contact</h2>
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
