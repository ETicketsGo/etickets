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
import { BrandPage } from '@/components/storefront-brand';

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
    body: 'A busy on-sale where two buyers never get the same seat.',
  },
  {
    icon: Trophy,
    title: 'Sports',
    body: 'Fixtures, seating blocks, and a queue that moves on match day.',
  },
  {
    icon: Mic2,
    title: 'Comedy',
    body: 'One room or a whole tour. Every date sits under the same show.',
  },
  {
    icon: Theater,
    title: 'Theatre',
    body: 'A season of dates, with a seat map for each one.',
  },
  {
    icon: PartyPopper,
    title: 'Festivals',
    body: 'Passes that cover several days, and more than one gate.',
  },
  {
    icon: Presentation,
    title: 'Conferences',
    body: 'Sessions, ticket tiers, and a list of who is coming.',
  },
  {
    icon: GraduationCap,
    title: 'College events',
    body: 'Campus shows and fests, with coupons and roles for your team.',
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
    <BrandPage>
      <PageHero
        eyebrow="Solutions"
        title="Event types we support"
        lead="The same tools work for one comedy night, a three-day festival, or a cinema chain."
        primary={{ href: '/register?intent=organizer', label: 'Get started' }}
        secondary={{ href: '/features', label: 'Explore features' }}
      />
      <Section>
        <Container>
          <SectionHeading eyebrow="Industries" title="Ten kinds of event" />
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {INDUSTRIES.map((i) => (
              <div
                key={i.title}
                className="group rounded-brand-card border border-brand-line bg-brand-surface p-6"
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-11 w-11 items-center justify-center rounded-brand-control bg-brand-sunken text-brand-ink">
                    <i.icon className="h-5 w-5" />
                  </span>
                  <h3 className="font-brand-display text-brand-card text-brand-ink">{i.title}</h3>
                </div>
                <p className="mt-3 text-brand-ui leading-relaxed text-brand-ink-2">{i.body}</p>
              </div>
            ))}
          </div>
        </Container>
      </Section>
      <Section className="border-t border-brand-line">
        <CtaBand
          title="Don't see your category?"
          lead="Tell us what you run and we will look at it."
          primaryHref="/contact"
          primaryLabel="Talk to us"
          secondaryHref="/register?intent=organizer"
          secondaryLabel="Get started"
        />
      </Section>
    </BrandPage>
  );
}
