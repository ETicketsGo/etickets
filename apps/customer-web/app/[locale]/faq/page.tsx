import type { Metadata } from 'next';
import { Container, Section } from '@/components/marketing/kit';
import { PageHero } from '@/components/marketing/blocks';
import { FaqSearch, type FaqGroup } from '@/components/marketing/faq';

export const metadata: Metadata = {
  title: 'FAQ',
  description:
    'Answers for organizers and attendees — general, payments, refunds, offline check-in, security, pricing, accounts, and support.',
  alternates: { canonical: '/faq' },
};

const GROUPS: FaqGroup[] = [
  {
    category: 'General',
    items: [
      {
        q: 'What is ETicketsGo?',
        a: 'An experience-commerce platform for selling tickets, checking in guests (online and offline), and understanding your events with built-in analytics.',
      },
      {
        q: 'Is it free to start?',
        a: 'Yes — you can create events and explore the platform. Live payments require completing payment onboarding; the demo uses mock payments.',
      },
    ],
  },
  {
    category: 'For organizers',
    items: [
      {
        q: 'How do I create an event?',
        a: 'Use the guided wizard to add sessions, ticket types, pricing, and a fee mode, then save as a draft or submit to publish.',
      },
      {
        q: 'Can I edit ticket types after they go on sale?',
        a: 'Yes, safely: the price is locked once a ticket sells, and quantity can only rise to cover what is already sold or held.',
      },
      {
        q: 'Can I run discount codes?',
        a: 'Yes — create percentage or fixed-amount coupons with redemption limits and date windows from the Promotions page.',
      },
      {
        q: 'How do I export my attendee list?',
        a: 'From the Attendees tab, Export CSV downloads the full filtered list — your door list, not just one page.',
      },
    ],
  },
  {
    category: 'For attendees',
    items: [
      {
        q: 'Where are my tickets?',
        a: 'In your account under Tickets. Each ticket has a secure QR code and stays accessible offline.',
      },
      {
        q: 'Can I share or transfer a ticket?',
        a: 'Yes — use Share on a ticket to send a view, guest, or transfer link with an expiry, and revoke it anytime.',
      },
    ],
  },
  {
    category: 'Payments',
    items: [
      {
        q: 'Which payment providers are supported?',
        a: 'The platform routes across multiple providers (e.g. Stripe, Razorpay, PayPal, Square) by country and currency, with failover.',
      },
      {
        q: 'Is my card data stored?',
        a: 'No. Card handling is delegated to PCI-compliant providers; ETicketsGo never stores card numbers.',
      },
      {
        q: 'My payment was declined — was I charged?',
        a: 'No. A declined payment issues no ticket and no charge — just try another method.',
      },
    ],
  },
  {
    category: 'Refunds',
    items: [
      {
        q: 'Can I get a refund?',
        a: 'Refunds are available for confirmed bookings up to the event’s cut-off (a default of 48 hours before the session), subject to the organizer’s policy.',
      },
      {
        q: 'How do I request one?',
        a: 'Request from your booking or tickets page; the request is validated and routed for processing.',
      },
    ],
  },
  {
    category: 'Offline check-in',
    items: [
      {
        q: 'Do I need internet to check people in?',
        a: 'No. Offline gate check-in keeps scanning with a signed manifest and durable queue, then reconciles with the server on reconnect.',
      },
      {
        q: 'Is offline check-in safe?',
        a: 'Yes — the server stays authoritative. A rejected scan can never be turned into an admission, and every scan is reconciled.',
      },
    ],
  },
  {
    category: 'Security',
    items: [
      {
        q: 'How are tickets protected from copying?',
        a: 'Tickets use rotating, signed QR codes with single-use, atomic check-in — a code cannot be replayed for double entry.',
      },
      {
        q: 'Is there an audit trail?',
        a: 'Yes — sensitive actions (auth, payments, refunds, check-in, config changes) are recorded in an immutable audit log.',
      },
    ],
  },
  {
    category: 'Pricing',
    items: [
      {
        q: 'How much does it cost?',
        a: 'Starter is free to begin; Professional and Enterprise add advanced tooling. Figures on the pricing page are illustrative pending final decisions.',
      },
      {
        q: 'Who pays the fees?',
        a: 'You choose per event — the customer pays, you absorb them, or you split them.',
      },
    ],
  },
  {
    category: 'Accounts & support',
    items: [
      {
        q: 'How do I get help?',
        a: 'Check this FAQ and the documentation, or reach out via the contact page. Organizers get priority channels on paid plans.',
      },
      {
        q: 'How do I manage my account?',
        a: 'Your bookings, tickets, and shares live in your account; organizers manage events, team, and payouts in the organizer console.',
      },
    ],
  },
];

export default function FaqPage() {
  return (
    <>
      <PageHero
        eyebrow="Help center"
        title="Frequently asked questions"
        lead="Search across organizer and attendee questions, or browse by topic."
      />
      <Section>
        <Container className="max-w-3xl">
          <FaqSearch groups={GROUPS} />
        </Container>
      </Section>
    </>
  );
}
