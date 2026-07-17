import type { Metadata } from 'next';
import {
  Film,
  Music,
  Trophy,
  Mic2,
  Theater,
  PartyPopper,
  Presentation,
  GraduationCap,
  Users,
  Lock,
} from 'lucide-react';
import { Container, Section, SectionHeading, CtaBand } from '@/components/marketing/kit';
import { PageHero } from '@/components/marketing/blocks';

export const metadata: Metadata = {
  title: 'Solutions',
  description:
    'ETicketsGo powers movies, concerts, sports, comedy, theatre, festivals, conferences, college events, community events, and private events.',
  alternates: { canonical: '/solutions' },
};

const INDUSTRIES = [
  {
    icon: Film,
    title: 'Movies',
    body: 'Showtimes, screens, and reserved seating for cinemas and chains.',
  },
  {
    icon: Music,
    title: 'Concerts',
    body: 'High-demand on-sales with fair, race-safe seat and tier allocation.',
  },
  {
    icon: Trophy,
    title: 'Sports',
    body: 'Fixtures, sections, and fast gate entry for match days.',
  },
  {
    icon: Mic2,
    title: 'Comedy',
    body: 'Intimate rooms to touring shows, with easy multi-date management.',
  },
  {
    icon: Theater,
    title: 'Theatre',
    body: 'Seasons, seat maps, and subscriber-friendly bookings.',
  },
  {
    icon: PartyPopper,
    title: 'Festivals',
    body: 'Multi-day passes and multiple gates with offline-ready check-in.',
  },
  {
    icon: Presentation,
    title: 'Conferences',
    body: 'Sessions, tiers, and attendee management for professional events.',
  },
  {
    icon: GraduationCap,
    title: 'College events',
    body: 'Fests and campus shows with simple team roles and coupons.',
  },
  {
    icon: Users,
    title: 'Community events',
    body: 'Local meetups and fundraisers with free or paid tickets.',
  },
  { icon: Lock, title: 'Private events', body: 'Invite-only bookings, shares, and transfers.' },
];

export default function SolutionsPage() {
  return (
    <>
      <PageHero
        eyebrow="Solutions"
        title="Built for every kind of experience"
        lead="One flexible platform models everything from a single show to a multi-day festival or a cinema chain — and it's designed to expand into new categories."
        primary={{ href: '/register', label: 'Get started' }}
        secondary={{ href: '/features', label: 'Explore features' }}
      />
      <Section>
        <Container>
          <SectionHeading eyebrow="Industries" title="Ten categories, one platform" />
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {INDUSTRIES.map((i) => (
              <div
                key={i.title}
                className="group rounded-2xl border border-border bg-background-surface p-6 shadow-sm transition-all hover:-translate-y-0.5 hover:border-action-primary/30 hover:shadow-md"
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-action-primary/10 text-action-primary transition-colors group-hover:bg-action-primary group-hover:text-action-primary-foreground">
                    <i.icon className="h-5 w-5" />
                  </span>
                  <h3 className="text-base font-semibold text-text-primary">{i.title}</h3>
                </div>
                <p className="mt-3 text-[0.9375rem] leading-relaxed text-text-secondary">
                  {i.body}
                </p>
              </div>
            ))}
          </div>
        </Container>
      </Section>
      <Section className="border-t border-border">
        <CtaBand
          title="Don't see your category?"
          lead="ETicketsGo is designed to expand — tell us what you're running."
          primaryHref="/contact"
          primaryLabel="Talk to us"
          secondaryHref="/register"
          secondaryLabel="Get started"
        />
      </Section>
    </>
  );
}
