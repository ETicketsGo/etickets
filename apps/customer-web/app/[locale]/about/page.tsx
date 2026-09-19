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
    'What ETicketsGo is for, how we build it, how we keep tickets and money safe, and what we plan to add next.',
  alternates: { canonical: '/about' },
};

export default function AboutPage() {
  return (
    <>
      <PageHero
        eyebrow="About ETicketsGo"
        title="We make ticketing software"
        lead="Organizers use it to sell tickets and check people in. Buyers use it to book a seat and get through the door."
      />

      <Section>
        <Container>
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="rounded-3xl border border-border bg-background-surface p-8 shadow-sm">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-tint-primary text-action-primary">
                <Target className="h-5 w-5" />
              </span>
              <h2 className="mt-4 text-xl font-bold tracking-tight text-text-primary">
                Our mission
              </h2>
              <p className="mt-3 text-[0.9375rem] leading-relaxed text-text-secondary">
                Make it easy to sell tickets and run an event. An organizer should be able to check
                every payment. A buyer should see the total before they pay.
              </p>
            </div>
            <div className="rounded-3xl border border-border bg-background-surface p-8 shadow-sm">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-tint-primary text-action-primary">
                <Eye className="h-5 w-5" />
              </span>
              <h2 className="mt-4 text-xl font-bold tracking-tight text-text-primary">
                Our vision
              </h2>
              <p className="mt-3 text-[0.9375rem] leading-relaxed text-text-secondary">
                One platform for every kind of event, in every market we support. A local meetup and
                a national tour use the same tools.
              </p>
            </div>
          </div>
        </Container>
      </Section>

      <Section className="border-t border-border bg-background-subtle/30">
        <Container>
          <SectionHeading
            eyebrow="Our approach"
            title="How we build"
            lead="Four rules we keep to."
          />
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <FeatureCard icon={Cpu} title="Technology">
              One codebase, split into modules. The rules about money and tickets are plain
              functions with tests.
            </FeatureCard>
            <FeatureCard icon={ShieldCheck} title="Security">
              We store no card numbers. Each ticket code works once, and we log every sensitive
              action.
            </FeatureCard>
            <FeatureCard icon={Sparkles} title="Offline gate">
              The gate keeps scanning with no network. The server still decides what counts.
            </FeatureCard>
            <FeatureCard icon={Map} title="Running it">
              We take a backup every night and test the restore. We can put a release back.
            </FeatureCard>
          </div>
        </Container>
      </Section>

      <Section className="border-t border-border">
        <Container>
          <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
            <Stat value="Seat maps" label="Reserved seating" />
            <Stat value="4 providers" label="Payment gateways" />
            <Stat value="Offline" label="Check-in at the gate" />
            <Stat value="2 languages" label="English and French" />
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
                'Run the first pilots',
                'Take on a few organizers, sell real tickets, and fix what we find.',
              ],
              [
                'More selling tools',
                'More ways to promote an event, and more that organizers can set up themselves.',
              ],
              [
                'Mobile and new markets',
                'Phone apps, better ways to find events, and more countries.',
              ],
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
          <SectionHeading eyebrow="Company" title="Founder, media and careers" />
          <NoticeBanner>
            Founder bios, press material and open roles are <strong>placeholders</strong> in this
            demo build. We will publish the real ones later.
          </NoticeBanner>
        </Container>
      </Section>

      <Section className="border-t border-border">
        <CtaBand
          title="Sell your next event here"
          lead="Create an account, or ask us a question first."
          primaryHref="/register"
          primaryLabel="Get started"
          secondaryHref="/contact"
          secondaryLabel="Contact us"
        />
      </Section>
    </>
  );
}
