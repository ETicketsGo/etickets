import type { Metadata } from 'next';
import {
  Search,
  Armchair,
  Zap,
  ShieldCheck,
  Wallet,
  QrCode,
  DoorOpen,
  Smartphone,
  RotateCcw,
  UserCircle,
} from 'lucide-react';
import {
  Container,
  Section,
  SectionHeading,
  FeatureCard,
  CtaBand,
} from '@/components/marketing/kit';
import { PageHero } from '@/components/marketing/blocks';

export const metadata: Metadata = {
  title: 'For attendees',
  description:
    'Discover events, pick your seats, check out fast, pay securely, keep tickets in your wallet, and get in quickly with QR passes that work offline.',
  alternates: { canonical: '/customers' },
};

const ITEMS = [
  {
    icon: Search,
    title: 'Discover events',
    body: 'Browse and search by title, city, or category with a fast, clean experience.',
  },
  {
    icon: Armchair,
    title: 'Seat selection',
    body: 'Pick your exact seats on a clear map — what you choose is what you get.',
  },
  {
    icon: Zap,
    title: 'Fast checkout',
    body: 'A short, transparent flow with the full total shown before you pay.',
  },
  {
    icon: ShieldCheck,
    title: 'Secure payments',
    body: 'Card details go straight to the payment provider — never stored by us.',
  },
  {
    icon: Wallet,
    title: 'Wallet tickets',
    body: 'Keep passes handy and accessible, even without a signal.',
  },
  { icon: QrCode, title: 'QR tickets', body: 'Secure, single-use codes that can’t be replayed.' },
  {
    icon: DoorOpen,
    title: 'Fast entry',
    body: 'Event Day Mode keeps your screen bright and ready at the gate.',
  },
  {
    icon: Smartphone,
    title: 'Mobile experience',
    body: 'Built mobile-first for how you actually buy and attend.',
  },
  { icon: RotateCcw, title: 'Refunds', body: 'Simple refund requests within the event’s window.' },
  {
    icon: UserCircle,
    title: 'Account management',
    body: 'Your bookings, tickets, and shares in one place.',
  },
];

export default function CustomersPage() {
  return (
    <>
      <PageHero
        eyebrow="For attendees"
        title="Book in seconds. Get in fast."
        lead="A fast, secure, mobile-first way to discover events, pick your seats, and walk through the gate."
        primary={{ href: '/events', label: 'Browse events' }}
        secondary={{ href: '/register', label: 'Create an account' }}
      />
      <Section>
        <Container>
          <SectionHeading
            eyebrow="The attendee experience"
            title="Everything about going out, made easy"
          />
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {ITEMS.map((i) => (
              <FeatureCard key={i.title} icon={i.icon} title={i.title}>
                {i.body}
              </FeatureCard>
            ))}
          </div>
        </Container>
      </Section>
      <Section className="border-t border-border">
        <CtaBand
          title="Find something to do this weekend"
          lead="Discover events near you and book in a few taps."
          primaryHref="/events"
          primaryLabel="Browse live events"
          secondaryHref="/faq"
          secondaryLabel="Read the FAQ"
        />
      </Section>
    </>
  );
}
