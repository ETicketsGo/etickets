import type { Metadata } from 'next';
import { Target, Eye, Cpu, ShieldCheck, Sparkles, Map } from 'lucide-react';
import {
  Container,
  Section,
  SectionHeading,
  FeatureCard,
  Stat,
  CtaBand,
} from '@/components/marketing/kit';
import { PageHero, NoticeBanner } from '@/components/marketing/blocks';

export const metadata: Metadata = {
  title: 'About',
  description:
    'ETicketsGo is an experience-commerce platform built with operational maturity — mission, vision, technology, security, and roadmap.',
  alternates: { canonical: '/about' },
};

export default function AboutPage() {
  return (
    <>
      <PageHero
        eyebrow="About ETicketsGo"
        title="Experience commerce, engineered to be trusted"
        lead="We build the platform that lets organizers sell with confidence and lets attendees show up without friction."
      />

      <Section>
        <Container>
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="rounded-3xl border border-border bg-background-surface p-8 shadow-sm">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-action-primary/10 text-action-primary">
                <Target className="h-5 w-5" />
              </span>
              <h2 className="mt-4 text-xl font-bold tracking-tight text-text-primary">
                Our mission
              </h2>
              <p className="mt-3 text-[0.9375rem] leading-relaxed text-text-secondary">
                Make it effortless for anyone to sell tickets and run a great event — with the
                financial integrity, reliability, and fairness that both organizers and attendees
                deserve.
              </p>
            </div>
            <div className="rounded-3xl border border-border bg-background-surface p-8 shadow-sm">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-action-primary/10 text-action-primary">
                <Eye className="h-5 w-5" />
              </span>
              <h2 className="mt-4 text-xl font-bold tracking-tight text-text-primary">
                Our vision
              </h2>
              <p className="mt-3 text-[0.9375rem] leading-relaxed text-text-secondary">
                A single experience-commerce platform for every kind of event, in every market —
                built to scale from a community meetup to a national tour.
              </p>
            </div>
          </div>
        </Container>
      </Section>

      <Section className="border-t border-border bg-background-subtle/30">
        <Container>
          <SectionHeading
            eyebrow="Philosophy"
            title="How we build"
            lead="The principles that shaped the platform."
          />
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <FeatureCard icon={Cpu} title="Technology">
              A modular monolith with pure, tested domain rules — reliable and easy to evolve.
            </FeatureCard>
            <FeatureCard icon={ShieldCheck} title="Security">
              Fail-closed defaults, no card data stored, replay-safe tickets, and full audit.
            </FeatureCard>
            <FeatureCard icon={Sparkles} title="Innovation">
              Server-authoritative offline check-in that keeps the gate honest without a network.
            </FeatureCard>
            <FeatureCard icon={Map} title="Operational maturity">
              Backups, rollback, monitoring, and runbooks — treated as first-class, not
              afterthoughts.
            </FeatureCard>
          </div>
        </Container>
      </Section>

      <Section className="border-t border-border">
        <Container>
          <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
            <Stat value="Phase 3" label="Engineering complete" />
            <Stat value="RC1" label="Production candidate" />
            <Stat value="Offline" label="Gate check-in shipped" />
            <Stat value="Multi-market" label="Payments ready" />
          </div>
        </Container>
      </Section>

      <Section className="border-t border-border">
        <Container>
          <SectionHeading
            eyebrow="What's next"
            title="Roadmap"
            lead="Where we're heading after launch."
            align="center"
          />
          <ol className="mx-auto mt-10 max-w-2xl space-y-4">
            {[
              [
                'First controlled pilots',
                'Onboard early organizers, run live events, and learn from real usage.',
              ],
              [
                'Organizer growth tooling',
                'Deeper promotions, marketing, and self-service capabilities.',
              ],
              ['Platform evolution', 'Mobile apps, richer discovery, and international expansion.'],
            ].map(([t, b], i) => (
              <li
                key={t}
                className="flex gap-4 rounded-2xl border border-border bg-background-surface p-5 shadow-sm"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-action-primary text-action-primary-foreground text-caption font-bold">
                  {i + 1}
                </span>
                <div>
                  <div className="font-semibold text-text-primary">{t}</div>
                  <p className="mt-1 text-[0.9375rem] text-text-secondary">{b}</p>
                </div>
              </li>
            ))}
          </ol>
        </Container>
      </Section>

      <Section className="border-t border-border">
        <Container className="max-w-3xl space-y-6">
          <SectionHeading eyebrow="Company" title="Founder · Media · Careers" />
          <NoticeBanner>
            Founder bios, media resources, and open roles are <strong>placeholders</strong> for this
            demo build and will be published as the company formalizes them.
          </NoticeBanner>
        </Container>
      </Section>

      <Section className="border-t border-border">
        <CtaBand
          title="Build your events on a platform that takes them seriously"
          lead="Get started today, or reach out to learn more."
          primaryHref="/register"
          primaryLabel="Get started"
          secondaryHref="/contact"
          secondaryLabel="Contact us"
        />
      </Section>
    </>
  );
}
