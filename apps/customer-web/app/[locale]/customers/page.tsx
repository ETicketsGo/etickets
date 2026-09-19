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
    title: 'Find events',
    body: 'Search by name, city or category.',
  },
  {
    icon: Armchair,
    title: 'Seat selection',
    body: 'Pick your exact seats on a map. You get the seats you chose.',
  },
  {
    icon: Zap,
    title: 'Fast checkout',
    body: 'A short checkout that shows the full total before you pay.',
  },
  {
    icon: ShieldCheck,
    title: 'Secure payments',
    body: 'Your card details go to the payment provider. We never store them.',
  },
  {
    icon: Wallet,
    title: 'Wallet tickets',
    body: 'Keep a pass in your phone wallet. It opens without a signal.',
  },
  {
    icon: QrCode,
    title: 'QR tickets',
    body: 'Each code works once, so nobody can copy your ticket.',
  },
  {
    icon: DoorOpen,
    title: 'Fast entry',
    body: 'Event Day Mode keeps your screen bright at the gate.',
  },
  {
    icon: Smartphone,
    title: 'Works on a phone',
    body: 'Every page fits a phone screen.',
  },
  {
    icon: RotateCcw,
    title: 'Refunds',
    body: 'Ask for a refund inside the window shown on the event.',
  },
  {
    icon: UserCircle,
    title: 'Your account',
    body: 'Your bookings, tickets and shared links in one place.',
  },
];

export default function CustomersPage() {
  return (
    <>
      <PageHero
        eyebrow="For attendees"
        title="Book in seconds. Get in fast."
        lead="Find an event, pick your seats, and pay on your phone. Your ticket is a QR code."
        primary={{ href: '/events', label: 'Browse events' }}
        secondary={{ href: '/register', label: 'Create an account' }}
      />
      <Section>
        <Container>
          <SectionHeading eyebrow="What you get" title="Ten things you can do" />
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
          lead="See what is on near you."
          primaryHref="/events"
          primaryLabel="Browse live events"
          secondaryHref="/faq"
          secondaryLabel="Read the FAQ"
        />
      </Section>
    </>
  );
}
