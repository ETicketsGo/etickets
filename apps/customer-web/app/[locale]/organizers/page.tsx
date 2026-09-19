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
    body: 'Add your sessions, ticket types and prices, and choose who pays the fees. Save a draft, or send it for review.',
  },
  {
    n: '2',
    title: 'Sell and promote',
    body: 'Share the link, hand out coupon codes, and watch sales on your dashboard.',
  },
  {
    n: '3',
    title: 'Check people in',
    body: 'Scan tickets at the gate. Switch to offline mode if the venue network drops.',
  },
  {
    n: '4',
    title: 'Get paid',
    body: 'Check your payments, take your payout, and read the report before the next event.',
  },
];

const CAPS = [
  {
    icon: CalendarPlus,
    title: 'Create events',
    body: 'Build the event step by step, and save a draft first.',
  },
  {
    icon: Boxes,
    title: 'Manage inventory',
    body: 'Change a ticket type after it sells. The price is locked, and the quantity can only go up.',
  },
  {
    icon: Tag,
    title: 'Coupons',
    body: 'Percentage or fixed codes, with a limit and an end date.',
  },
  {
    icon: Megaphone,
    title: 'Promotions',
    body: 'Turn a code on or off, and see how often it was used.',
  },
  {
    icon: BarChart3,
    title: 'Analytics',
    body: 'Sales, bookings per visit, check-in rate, and failed payments.',
  },
  {
    icon: FileText,
    title: 'Reports',
    body: 'Revenue, settlement, refunds and fees. Download as CSV.',
  },
  {
    icon: WifiOff,
    title: 'Offline operations',
    body: 'Approve the gate devices, activate them, and check their scans.',
  },
  {
    icon: Users,
    title: 'Team management',
    body: 'Invite managers and check-in staff, each with their own role.',
  },
  {
    icon: CreditCard,
    title: 'Payments',
    body: 'We pick a provider by country, and try another if one is down.',
  },
  {
    icon: Banknote,
    title: 'Payouts',
    body: 'A statement that shows your fees, refunds and chargebacks.',
  },
  {
    icon: LifeBuoy,
    title: 'Support',
    body: 'Docs you can read, and a team you can write to.',
  },
];

export default function OrganizersPage() {
  return (
    <>
      <PageHero
        eyebrow="For organizers"
        title="Run a professional box office"
        lead="Sell tickets, scan people in at the door, and see what the event made."
        primary={{ href: '/register?intent=organizer', label: 'Start selling tickets' }}
        secondary={{ href: '/pricing', label: 'See pricing' }}
      />

      <Section>
        <Container>
          <SectionHeading eyebrow="How it works" title="Four steps" />
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
          <SectionHeading eyebrow="Your tools" title="What you can do" />
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
              Why use ETicketsGo
            </h3>
            <ul className="mt-6 space-y-3.5">
              <CheckItem>One place for tickets, seating, payments and the door</CheckItem>
              <CheckItem>The gate keeps scanning when the network drops</CheckItem>
              <CheckItem>Every payment lines up with your payout statement</CheckItem>
              <CheckItem>Reports that show which tickets sell</CheckItem>
            </ul>
          </div>
        </Container>
      </Section>

      <Section className="border-t border-border">
        <CtaBand
          title="Ready to sell your next event?"
          lead="Create an organizer account and publish your first event."
          primaryHref="/register"
          primaryLabel="Get started free"
          secondaryHref="/contact"
          secondaryLabel="Book a demo"
        />
      </Section>
    </>
  );
}
