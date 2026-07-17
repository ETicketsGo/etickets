import type { Metadata } from 'next';
import { Container, Section } from '@/components/marketing/kit';
import { PageHero } from '@/components/marketing/blocks';

export const metadata: Metadata = {
  title: 'Changelog',
  description: 'What has shipped on ETicketsGo — from the Phase 1 platform through RC1 and beyond.',
  alternates: { canonical: '/changelog' },
};

const RELEASES = [
  {
    tag: 'Public Experience',
    date: 'v1.1',
    current: true,
    title: 'A premium public front door',
    items: [
      'Marketing site: landing, features, pricing, solutions, organizer & attendee pages',
      'Docs portal, blog framework, changelog, and formatted legal pages',
      'Production SEO (metadata, sitemap, robots, Open Graph) and accessibility polish',
    ],
  },
  {
    tag: 'Phase 3',
    date: 'Engineering completion',
    title: 'Commercial features & polish',
    items: [
      'Organizer coupon management and ticket-type editing',
      'Injection-safe CSV, payment-health analytics, and developer-experience tooling',
      'UX polish and expanded test coverage',
    ],
  },
  {
    tag: 'Phase 2',
    date: 'Launch preparation',
    title: 'Growth foundations',
    items: [
      'Payment-health and organizer-growth reporting',
      'Country-aware payment routing and bounded background jobs',
      'Commercial, launch, and guide documentation',
    ],
  },
  {
    tag: 'RC1',
    date: 'Release candidate',
    title: 'Production hardening',
    items: [
      'Fail-closed production config guard and security headers',
      'Payment error classification and Redis fail-open resilience',
      'Deployment, rollback, and operations checklists',
    ],
  },
  {
    tag: 'Phase 1',
    date: 'Platform',
    title: 'The core platform',
    items: [
      'Events, ticketing, reserved seating, and inventory',
      'Multi-provider payments, refunds, and payouts',
      'Offline gate check-in, wallet passes, and analytics',
    ],
  },
];

export default function ChangelogPage() {
  return (
    <>
      <PageHero
        eyebrow="Changelog"
        title="What we've shipped"
        lead="A summary of major milestones. New releases will be added here."
      />
      <Section>
        <Container className="max-w-3xl">
          <ol className="relative space-y-10 border-l border-border pl-8">
            {RELEASES.map((r) => (
              <li key={r.tag} className="relative">
                <span
                  className={`absolute -left-[41px] flex h-6 w-6 items-center justify-center rounded-full border-2 border-background-canvas ${
                    r.current ? 'bg-action-primary' : 'bg-border-strong'
                  }`}
                  aria-hidden
                >
                  <span className="h-2 w-2 rounded-full bg-background-canvas" />
                </span>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="inline-flex items-center rounded-full bg-action-primary/10 px-3 py-1 text-caption font-semibold text-action-primary">
                    {r.tag}
                  </span>
                  <span className="text-caption text-text-muted">{r.date}</span>
                  {r.current && (
                    <span className="rounded-full bg-status-success/15 px-2.5 py-0.5 text-caption font-medium text-status-success">
                      Latest
                    </span>
                  )}
                </div>
                <h2 className="mt-3 text-lg font-bold tracking-tight text-text-primary">
                  {r.title}
                </h2>
                <ul className="mt-3 space-y-1.5 text-[0.9375rem] text-text-secondary">
                  {r.items.map((i) => (
                    <li key={i} className="flex gap-2">
                      <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-action-primary" />
                      {i}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </Container>
      </Section>
    </>
  );
}
