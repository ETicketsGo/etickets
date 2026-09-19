import type { Metadata } from 'next';
import {
  CalendarDays,
  Ticket,
  Armchair,
  CreditCard,
  Tag,
  WifiOff,
  LayoutDashboard,
  BarChart3,
  Wallet,
  ShieldCheck,
  Gauge,
  Accessibility,
  Smartphone,
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
  title: 'Features',
  description:
    'Event setup, ticketing, reserved seating, payments, coupons, offline check-in, dashboards, reports, wallet passes, security, and accessibility.',
  alternates: { canonical: '/features' },
};

const FEATURES = [
  {
    icon: CalendarDays,
    title: 'Event setup',
    body: 'Add your sessions, save a draft, then publish. You can still edit after it goes live.',
  },
  {
    icon: Ticket,
    title: 'Ticketing',
    body: 'Set up ticket types and a limit per order. The price locks once a ticket sells.',
  },
  {
    icon: Armchair,
    title: 'Reserved seating',
    body: 'Buyers pick seats on a map. Two people cannot buy the same seat.',
  },
  {
    icon: CreditCard,
    title: 'Payments',
    body: 'Each payment goes to a provider that works in your country. If one is down, we try another.',
  },
  {
    icon: Tag,
    title: 'Coupons',
    body: 'Discount codes for a percentage or a fixed amount, with a limit and an end date.',
  },
  {
    icon: WifiOff,
    title: 'Offline check-in',
    body: 'The gate app scans from a signed list of tickets and stores each scan until it can sync.',
  },
  {
    icon: LayoutDashboard,
    title: 'Organizer dashboard',
    body: 'One page for sales, revenue, attendance and payouts.',
  },
  {
    icon: BarChart3,
    title: 'Reports',
    body: 'Daily revenue, settlement, refunds and fees. Download any of them as a CSV file.',
  },
  {
    icon: Gauge,
    title: 'Analytics',
    body: 'How many visits turn into bookings, how many people check in, how many payments succeed.',
  },
  {
    icon: Wallet,
    title: 'Wallet passes',
    body: 'Add a pass to a phone wallet. The QR ticket opens with no signal.',
  },
  {
    icon: ShieldCheck,
    title: 'Security',
    body: 'We store no card numbers. Ticket codes work once, and we log every sensitive action.',
  },
  {
    icon: Gauge,
    title: 'Speed',
    body: 'Background jobs run in batches, and the database queries use indexes.',
  },
  {
    icon: Accessibility,
    title: 'Accessibility',
    body: 'Every control has a label. You can use the site with a keyboard, and status never relies on color alone.',
  },
  {
    icon: Smartphone,
    title: 'Works on a phone',
    body: 'The buyer pages fit a phone screen. The gate app runs on a phone or a tablet.',
  },
];

export default function FeaturesPage() {
  return (
    <>
      <PageHero
        eyebrow="Features"
        title="What the platform does"
        lead="The tools you use to sell tickets, run the door, and read the numbers afterwards."
        primary={{ href: '/register', label: 'Get started free' }}
        secondary={{ href: '/pricing', label: 'See pricing' }}
      />
      <Section>
        <Container>
          <SectionHeading
            eyebrow="Features"
            title="Fourteen features"
            lead="Ticketing, seating, payments, check-in and reports all read the same data."
          />
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <FeatureCard key={f.title} icon={f.icon} title={f.title}>
                {f.body}
              </FeatureCard>
            ))}
          </div>
        </Container>
      </Section>
      <Section className="border-t border-border">
        <CtaBand
          title="Try it on your own event"
          lead="Create an account and publish your first event."
          primaryHref="/register"
          primaryLabel="Start free"
          secondaryHref="/docs"
          secondaryLabel="Read the docs"
        />
      </Section>
    </>
  );
}
