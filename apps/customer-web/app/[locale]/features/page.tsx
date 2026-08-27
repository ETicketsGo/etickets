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
    'Event management, ticketing, reserved seating, payments, coupons, offline check-in, dashboards, reports, analytics, wallet support, security, scalability, accessibility, and responsive design.',
  alternates: { canonical: '/features' },
};

const FEATURES = [
  {
    icon: CalendarDays,
    title: 'Event management',
    body: 'Guided event wizard, sessions, drafts, review and publish. Edit safely once live.',
  },
  {
    icon: Ticket,
    title: 'Ticketing',
    body: 'Tiered ticket types with per-order limits, inventory tracking, and sales-safe edits.',
  },
  {
    icon: Armchair,
    title: 'Reserved seating',
    body: 'Interactive seat maps with atomic holds — no two buyers get the same seat.',
  },
  {
    icon: CreditCard,
    title: 'Payments',
    body: 'Multi-country, multi-provider routing with circuit-breaker failover and reconciliation.',
  },
  {
    icon: Tag,
    title: 'Coupons',
    body: 'Percentage or fixed discount codes with redemption limits and date windows.',
  },
  {
    icon: WifiOff,
    title: 'Offline check-in',
    body: 'Signed device manifests + durable queue keep the gate moving without connectivity.',
  },
  {
    icon: LayoutDashboard,
    title: 'Organizer dashboard',
    body: 'A single, fast view of sales, revenue, attendance, and payouts.',
  },
  {
    icon: BarChart3,
    title: 'Reports',
    body: 'Daily revenue, organizer revenue, settlement, refunds, fees — exportable to CSV.',
  },
  {
    icon: Gauge,
    title: 'Analytics',
    body: 'Conversion funnel, check-in rate, refund trends, growth, and payment success rate.',
  },
  {
    icon: Wallet,
    title: 'Wallet support',
    body: 'Wallet passes and QR tickets that stay accessible offline at the gate.',
  },
  {
    icon: ShieldCheck,
    title: 'Security',
    body: 'Fail-closed config, no card data stored, replay-safe tickets, and a full audit trail.',
  },
  {
    icon: Gauge,
    title: 'Scalability',
    body: 'Bounded background jobs, indexed queries, and horizontal-ready services.',
  },
  {
    icon: Accessibility,
    title: 'Accessibility',
    body: 'Labelled controls, non-color status, keyboard support, and focus management.',
  },
  {
    icon: Smartphone,
    title: 'Responsive design',
    body: 'Mobile-first experiences for buyers and an operator-ready gate on any device.',
  },
];

export default function FeaturesPage() {
  return (
    <>
      <PageHero
        eyebrow="Features"
        title="A complete toolkit for modern events"
        lead="Every capability an organizer needs to sell, operate, and understand events — designed to work together."
        primary={{ href: '/register', label: 'Get started free' }}
        secondary={{ href: '/pricing', label: 'See pricing' }}
      />
      <Section>
        <Container>
          <SectionHeading
            eyebrow="Platform capabilities"
            title="Fourteen capabilities, one platform"
            lead="No stitching vendors together — ticketing, seating, payments, check-in, and analytics share one source of truth."
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
          title="See it on your own events"
          lead="Create an account and publish your first event in minutes."
          primaryHref="/register"
          primaryLabel="Start free"
          secondaryHref="/docs"
          secondaryLabel="Read the docs"
        />
      </Section>
    </>
  );
}
