import type { Metadata } from 'next';
import { Container, Section } from '@/components/marketing/kit';
import { PageHero } from '@/components/marketing/blocks';
import { FaqSearch, type FaqGroup } from '@/components/marketing/faq';

export const metadata: Metadata = {
  title: 'FAQ',
  description:
    'Answers about creating events, payments, refunds, offline check-in, security, pricing and accounts.',
  alternates: { canonical: '/faq' },
};

const GROUPS: FaqGroup[] = [
  {
    category: 'General',
    items: [
      {
        q: 'What is ETicketsGo?',
        a: 'Software for selling tickets, checking guests in at the door, and seeing how an event did. The door app works with or without a network.',
      },
      {
        q: 'Is it free to start?',
        a: 'Yes. You can create events and look around. To take real payments you finish payment onboarding first. The demo uses mock payments.',
      },
    ],
  },
  {
    category: 'For organizers',
    items: [
      {
        q: 'How do I create an event?',
        a: 'Use the wizard to add your sessions, ticket types, prices and fee mode. Then save a draft, or submit it to publish.',
      },
      {
        q: 'Can I edit ticket types after they go on sale?',
        a: 'Yes, within limits. The price locks once a ticket sells, and the quantity can only rise to cover what is already sold or held.',
      },
      {
        q: 'Can I run discount codes?',
        a: 'Yes. Create percentage or fixed-amount coupons on the Promotions page, each with a redemption limit and a date window.',
      },
      {
        q: 'How do I export my attendee list?',
        a: 'Open the Attendees tab and choose Export CSV. It downloads the whole filtered list, not just the page you can see.',
      },
    ],
  },
  {
    category: 'For attendees',
    items: [
      {
        q: 'Where are my tickets?',
        a: 'In your account, under Tickets. Each ticket has its own QR code, and it opens without a signal.',
      },
      {
        q: 'Can I share or transfer a ticket?',
        a: 'Yes. Use Share on a ticket to send a view, guest or transfer link. Each link has an expiry, and you can revoke it at any time.',
      },
    ],
  },
  {
    category: 'Payments',
    items: [
      {
        q: 'Which payment providers are supported?',
        a: 'We route each payment by country and currency, and try another provider if one is down. Stripe, Razorpay, PayPal and Square are supported.',
      },
      {
        q: 'Is my card data stored?',
        a: 'No. Card details go straight to a PCI-compliant provider. ETicketsGo never stores card numbers.',
      },
      {
        q: 'My payment was declined. Was I charged?',
        a: 'No. A declined payment issues no ticket and takes no money. Try another method.',
      },
    ],
  },
  {
    category: 'Refunds',
    items: [
      {
        q: 'Can I get a refund?',
        a: 'You can refund a confirmed booking up to the cut-off on the event. The default cut-off is 48 hours before the session, and the organizer can set their own.',
      },
      {
        q: 'How do I request one?',
        a: 'Ask from your booking or tickets page. We check the request against the refund rules and pass it on for processing.',
      },
    ],
  },
  {
    category: 'Offline check-in',
    items: [
      {
        q: 'Do I need internet to check people in?',
        a: 'No. The gate app scans from a signed list of tickets and stores each scan. The server checks them all when the device reconnects.',
      },
      {
        q: 'Is offline check-in safe?',
        a: 'Yes. The server has the last word. A scan the device rejected can never become an admission, and we check every scan afterwards.',
      },
    ],
  },
  {
    category: 'Security',
    items: [
      {
        q: 'How are tickets protected from copying?',
        a: 'Each QR code is signed and changes over time. The gate accepts a code once, so it cannot be used for a second entry.',
      },
      {
        q: 'Is there an audit trail?',
        a: 'Yes. We record sign-ins, payments, refunds, check-ins and config changes in a log that nobody can edit.',
      },
    ],
  },
  {
    category: 'Pricing',
    items: [
      {
        q: 'How much does it cost?',
        a: 'Starter is free. Professional and Enterprise add more tools. The figures on the pricing page are placeholders for now.',
      },
      {
        q: 'Who pays the fees?',
        a: 'You choose per event. The customer pays them, you absorb them, or you split them.',
      },
    ],
  },
  {
    category: 'Accounts and support',
    items: [
      {
        q: 'How do I get help?',
        a: 'Read this FAQ and the docs, or write to us from the contact page. Paid plans get a faster reply.',
      },
      {
        q: 'How do I manage my account?',
        a: 'Your bookings, tickets and shared links live in your account. Organizers manage events, team and payouts in the organizer console.',
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
        lead="Search the questions, or browse by topic."
      />
      <Section>
        <Container className="max-w-3xl">
          <FaqSearch groups={GROUPS} />
        </Container>
      </Section>
    </>
  );
}
