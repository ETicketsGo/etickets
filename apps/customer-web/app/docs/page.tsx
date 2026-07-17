import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Rocket,
  CalendarPlus,
  UserCircle,
  ShieldCheck,
  Code2,
  WifiOff,
  CreditCard,
  BarChart3,
  Wrench,
  History,
  Blocks,
  ArrowRight,
} from 'lucide-react';
import { Container, Section, SectionHeading } from '@/components/marketing/kit';
import { PageHero } from '@/components/marketing/blocks';

export const metadata: Metadata = {
  title: 'Documentation',
  description:
    'The ETicketsGo documentation portal — getting started, organizer and customer guides, API, offline operations, payments, reports, troubleshooting, release notes, and architecture.',
  alternates: { canonical: '/docs' },
};

const SECTIONS = [
  {
    icon: Rocket,
    title: 'Getting started',
    body: 'Create your account, publish your first event, and take your first booking.',
    href: '/register',
  },
  {
    icon: CalendarPlus,
    title: 'Organizer guide',
    body: 'Events, inventory, pricing, coupons, check-in, finance, and reports.',
    href: '/organizers',
  },
  {
    icon: UserCircle,
    title: 'Customer guide',
    body: 'Discover events, book seats, manage tickets, and request refunds.',
    href: '/customers',
  },
  {
    icon: ShieldCheck,
    title: 'Administrator guide',
    body: 'Reports, ops console, audit trail, and payment configuration.',
    href: '/features',
  },
  {
    icon: Code2,
    title: 'API',
    body: 'REST conventions, auth, pagination, errors, and webhooks (OpenAPI/Swagger).',
    href: '/docs/api',
  },
  {
    icon: WifiOff,
    title: 'Offline operations',
    body: 'Device lifecycle, controlled activation, and reconciliation at the gate.',
    href: '/features',
  },
  {
    icon: CreditCard,
    title: 'Payments',
    body: 'Multi-provider routing, onboarding, reconciliation, and payouts.',
    href: '/pricing',
  },
  {
    icon: BarChart3,
    title: 'Reports',
    body: 'Revenue, settlement, refunds, growth, and payment-health reports.',
    href: '/features',
  },
  {
    icon: Wrench,
    title: 'Troubleshooting',
    body: 'Common issues across payments, offline, and infrastructure.',
    href: '/faq',
  },
  {
    icon: History,
    title: 'Release notes',
    body: 'What shipped across each phase and release.',
    href: '/changelog',
  },
  {
    icon: Blocks,
    title: 'Architecture',
    body: 'The modular-monolith design, data model, and cross-cutting concerns.',
    href: '/about',
  },
];

export default function DocsPage() {
  return (
    <>
      <PageHero
        eyebrow="Documentation"
        title="Everything you need to build with ETicketsGo"
        lead="Guides for organizers, attendees, and administrators — plus API and operations references."
        primary={{ href: '/register', label: 'Get started' }}
        secondary={{ href: '/docs/api', label: 'API reference' }}
      />
      <Section>
        <Container>
          <SectionHeading eyebrow="Browse the docs" title="Documentation by area" />
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {SECTIONS.map((s) => (
              <Link
                key={s.title}
                href={s.href}
                className="group flex flex-col rounded-2xl border border-border bg-background-surface p-6 shadow-sm transition-all hover:-translate-y-0.5 hover:border-action-primary/30 hover:shadow-md"
              >
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-action-primary/10 text-action-primary transition-colors group-hover:bg-action-primary group-hover:text-action-primary-foreground">
                  <s.icon className="h-5 w-5" />
                </span>
                <h3 className="mt-4 text-base font-semibold text-text-primary">{s.title}</h3>
                <p className="mt-2 flex-1 text-[0.9375rem] leading-relaxed text-text-secondary">
                  {s.body}
                </p>
                <span className="mt-4 inline-flex items-center gap-1.5 text-caption font-semibold text-action-primary">
                  Read more{' '}
                  <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </Link>
            ))}
          </div>
          <p className="mt-10 text-center text-caption text-text-muted">
            Full engineering guides, runbooks, and ADRs are maintained in the product repository’s{' '}
            <code className="rounded bg-background-subtle px-1.5 py-0.5 text-text-secondary">
              docs/
            </code>{' '}
            directory.
          </p>
        </Container>
      </Section>
    </>
  );
}
