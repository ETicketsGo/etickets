import type { Metadata } from 'next';
import {
  CalendarPlus,
  Boxes,
  Tag,
  Megaphone,
  BarChart3,
  FileText,
  WifiOff,
  Users,
  CreditCard,
  Banknote,
  LifeBuoy,
} from 'lucide-react';
import {
  Container,
  Section,
  SectionHeading,
  FeatureCard,
  CheckItem,
  CtaBand,
} from '@/components/marketing/kit';
import { PageHero } from '@/components/marketing/blocks';

export const metadata: Metadata = {
  title: 'For organizers',
  description:
    'Create events, manage inventory, run coupons and promotions, view analytics and reports, operate offline check-in, manage your team, take payments, and receive payouts.',
  alternates: { canonical: '/organizers' },
};

const STEPS = [
  {
    n: '1',
    title: 'Create your event',
    body: 'Use the guided wizard to add sessions, ticket types, pricing, and a fee mode. Save as a draft or submit to publish.',
  },
  {
    n: '2',
    title: 'Sell & promote',
    body: 'Share your event, run coupon codes, and watch sales update live on your dashboard.',
  },
  {
    n: '3',
    title: 'Check people in',
    body: 'Scan at the gate online, or switch to offline mode when the venue network drops.',
  },
  {
    n: '4',
    title: 'Settle & learn',
    body: 'Reconcile payments, receive payouts, and review analytics to plan your next event.',
  },
];

const CAPS = [
  {
    icon: CalendarPlus,
    title: 'Create events',
    body: 'A guided wizard with drafts, review, and publish.',
  },
  {
    icon: Boxes,
    title: 'Manage inventory',
    body: 'Edit ticket types safely — price locked after sale, quantity only rises.',
  },
  { icon: Tag, title: 'Coupons', body: 'Percentage or fixed codes with limits and windows.' },
  { icon: Megaphone, title: 'Promotions', body: 'Activate, deactivate, and track redemptions.' },
  {
    icon: BarChart3,
    title: 'Analytics',
    body: 'Sales, conversion, check-in rate, and payment health.',
  },
  {
    icon: FileText,
    title: 'Reports',
    body: 'Revenue, settlement, refunds, and fees — export to CSV.',
  },
  {
    icon: WifiOff,
    title: 'Offline operations',
    body: 'Device lifecycle, activation, and reconciliation.',
  },
  {
    icon: Users,
    title: 'Team management',
    body: 'Invite managers and check-in staff with scoped roles.',
  },
  {
    icon: CreditCard,
    title: 'Payments',
    body: 'Multi-provider routing with failover and reconciliation.',
  },
  {
    icon: Banknote,
    title: 'Payouts',
    body: 'Settlement statements net of fees, refunds, and chargebacks.',
  },
  {
    icon: LifeBuoy,
    title: 'Support',
    body: 'Docs, runbooks, and responsive help when you need it.',
  },
];

export default function OrganizersPage() {
  return (
    <>
      <PageHero
        eyebrow="For organizers"
        title="Run a professional box office"
        lead="From your first event to your busiest on-sale, ETicketsGo gives you the tools to sell, operate, and understand every event."
        primary={{ href: '/register', label: 'Start selling tickets' }}
        secondary={{ href: '/pricing', label: 'See pricing' }}
      />

      <Section>
        <Container>
          <SectionHeading eyebrow="How it works" title="From idea to sold-out in four steps" />
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s) => (
              <div
                key={s.n}
                className="rounded-2xl border border-border bg-background-surface p-6 shadow-sm"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-action-primary text-action-primary-foreground font-bold shadow-sm">
                  {s.n}
                </span>
                <h3 className="mt-4 text-base font-semibold text-text-primary">{s.title}</h3>
                <p className="mt-2 text-[0.9375rem] leading-relaxed text-text-secondary">
                  {s.body}
                </p>
              </div>
            ))}
          </div>
        </Container>
      </Section>

      <Section className="border-t border-border bg-background-subtle/30">
        <Container>
          <SectionHeading eyebrow="Everything you need" title="A full organizer toolkit" />
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {CAPS.map((c) => (
              <FeatureCard key={c.title} icon={c.icon} title={c.title}>
                {c.body}
              </FeatureCard>
            ))}
          </div>
        </Container>
      </Section>

      <Section className="border-t border-border">
        <Container>
          <div className="mx-auto max-w-2xl rounded-3xl border border-border bg-background-surface p-8 shadow-sm">
            <h3 className="text-xl font-bold tracking-tight text-text-primary">
              Why organizers choose ETicketsGo
            </h3>
            <ul className="mt-6 space-y-3.5">
              <CheckItem>One platform instead of stitching vendors together</CheckItem>
              <CheckItem>The gate keeps moving even when the network drops</CheckItem>
              <CheckItem>Money you can reconcile — integer-precise and idempotent</CheckItem>
              <CheckItem>Analytics that tell you what actually sells</CheckItem>
            </ul>
          </div>
        </Container>
      </Section>

      <Section className="border-t border-border">
        <CtaBand
          title="Ready to sell your next event?"
          lead="Create your organizer account and publish in minutes."
          primaryHref="/register"
          primaryLabel="Get started free"
          secondaryHref="/contact"
          secondaryLabel="Book a demo"
        />
      </Section>
    </>
  );
}
