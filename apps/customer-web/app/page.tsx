import type { Metadata } from 'next';
import {
  Ticket,
  Armchair,
  CreditCard,
  WifiOff,
  BarChart3,
  ShieldCheck,
  Tag,
  QrCode,
  Users,
  Wallet,
  Film,
  Music,
  Trophy,
  Mic2,
  Theater,
  CalendarDays,
  ArrowRight,
} from 'lucide-react';
import {
  Container,
  Section,
  SectionHeading,
  Eyebrow,
  FeatureCard,
  Stat,
  GradientBackdrop,
  CtaBand,
  PrimaryLink,
  SecondaryLink,
  CheckItem,
} from '@/components/marketing/kit';

export const metadata: Metadata = {
  title: 'ETicketsGo — Sell tickets, check in guests, understand your events',
  description:
    'The all-in-one platform to sell tickets, manage reserved seating, take payments, check in attendees online or offline, and understand every event with built-in analytics.',
  alternates: { canonical: '/' },
};

const CATEGORIES = [
  { icon: Film, label: 'Movies' },
  { icon: Music, label: 'Concerts' },
  { icon: Trophy, label: 'Sports' },
  { icon: Mic2, label: 'Comedy' },
  { icon: Theater, label: 'Theatre' },
  { icon: CalendarDays, label: 'Conferences' },
];

export default function LandingPage() {
  return (
    <>
      {/* ── Hero ── */}
      <div className="relative overflow-hidden border-b border-border">
        <GradientBackdrop />
        <Container className="pb-16 pt-16 sm:pb-24 sm:pt-24">
          <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr]">
            <div>
              <Eyebrow>Experience commerce platform</Eyebrow>
              <h1 className="mt-5 text-balance text-4xl font-bold leading-[1.08] tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                Sell tickets. Check in guests.{' '}
                <span className="text-action-primary">Grow every event.</span>
              </h1>
              <p className="mt-6 max-w-xl text-pretty text-lg leading-relaxed text-text-secondary">
                ETicketsGo gives organizers everything to run a great event — ticketing, reserved
                seating, payments, coupons, offline gate check-in, and analytics — while attendees
                get a fast, secure, mobile-first booking experience.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <PrimaryLink href="/register">
                  Start selling tickets <ArrowRight className="h-4 w-4" />
                </PrimaryLink>
                <SecondaryLink href="/events">Browse live events</SecondaryLink>
              </div>
              <p className="mt-5 text-caption text-text-muted">
                No setup fees to start · Mock payments in demo · Cancel anytime
              </p>
            </div>
            <HeroPreview />
          </div>
          <div className="mt-16 grid grid-cols-2 gap-6 border-t border-border pt-10 sm:grid-cols-4">
            <Stat value="15 states" label="Ticket states modelled" />
            <Stat value="4 gateways" label="Payment providers" />
            <Stat value="Offline" label="Gate check-in ready" />
            <Stat value="Real-time" label="Sales analytics" />
          </div>
        </Container>
      </div>

      {/* ── Categories ── */}
      <Section className="border-b border-border">
        <Container>
          <SectionHeading
            eyebrow="Built for every experience"
            title="One platform for every kind of event"
            lead="From a single comedy night to a multi-day festival or a cinema chain — model it, sell it, and check it in."
          />
          <div className="mt-10 flex flex-wrap justify-center gap-3">
            {CATEGORIES.map((c) => (
              <span
                key={c.label}
                className="inline-flex items-center gap-2 rounded-full border border-border bg-background-surface px-4 py-2 text-[0.9375rem] font-medium text-text-secondary shadow-xs transition-colors hover:border-action-primary/30 hover:text-text-primary"
              >
                <c.icon className="h-4 w-4 text-action-primary" />
                {c.label}
              </span>
            ))}
          </div>
        </Container>
      </Section>

      {/* ── Capabilities ── */}
      <Section id="capabilities" className="border-b border-border bg-background-subtle/30">
        <Container>
          <SectionHeading
            eyebrow="Platform capabilities"
            title="Everything you need, nothing you don't"
            lead="A complete toolset that scales from your first event to your busiest on-sale."
          />
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <FeatureCard icon={Ticket} title="Event & ticket management">
              Publish events with sessions and tiered ticket types, edit inventory safely, and track
              sales in real time.
            </FeatureCard>
            <FeatureCard icon={Armchair} title="Reserved seating">
              Interactive seat maps with atomic, race-safe holds so two buyers never land the same
              seat.
            </FeatureCard>
            <FeatureCard icon={CreditCard} title="Payments & payouts">
              Multi-country, multi-provider routing with failover, reconciliation, and organizer
              payouts.
            </FeatureCard>
            <FeatureCard icon={Tag} title="Coupons & promotions">
              Percentage or fixed-amount discount codes with limits and date windows, applied at
              checkout.
            </FeatureCard>
            <FeatureCard icon={WifiOff} title="Offline gate check-in">
              Keep scanning when the venue Wi-Fi drops — signed device manifests, durable queue, and
              a server-authoritative reconcile.
            </FeatureCard>
            <FeatureCard icon={BarChart3} title="Analytics & reports">
              Sales, revenue, conversion, refunds, check-in rate, and payment health — exportable to
              CSV.
            </FeatureCard>
          </div>
        </Container>
      </Section>

      {/* ── Organizer + Customer benefits ── */}
      <Section className="border-b border-border">
        <Container>
          <div className="grid gap-12 lg:grid-cols-2">
            <div className="rounded-3xl border border-border bg-background-surface p-8 shadow-sm">
              <Eyebrow>For organizers</Eyebrow>
              <h3 className="mt-4 text-2xl font-bold tracking-tight text-text-primary">
                Run a professional box office
              </h3>
              <ul className="mt-6 space-y-3.5">
                <CheckItem>Create events in a guided wizard with drafts and review</CheckItem>
                <CheckItem>Live sales dashboard and full attendee export for the door</CheckItem>
                <CheckItem>Coupons, fee modes, and per-event refund policies</CheckItem>
                <CheckItem>Offline check-in with device lifecycle controls</CheckItem>
                <CheckItem>Finance reconciliation and payout statements</CheckItem>
              </ul>
              <PrimaryLink href="/organizers" className="mt-8">
                Explore the organizer platform <ArrowRight className="h-4 w-4" />
              </PrimaryLink>
            </div>
            <div className="rounded-3xl border border-border bg-background-surface p-8 shadow-sm">
              <Eyebrow>For attendees</Eyebrow>
              <h3 className="mt-4 text-2xl font-bold tracking-tight text-text-primary">
                Book in seconds, get in fast
              </h3>
              <ul className="mt-6 space-y-3.5">
                <CheckItem>Discover events and pick seats on a clear, fast map</CheckItem>
                <CheckItem>Transparent pricing — see the total before you pay</CheckItem>
                <CheckItem>Secure QR tickets that work offline at the gate</CheckItem>
                <CheckItem>Wallet passes and easy sharing or transfer</CheckItem>
                <CheckItem>Simple refunds within the event&rsquo;s window</CheckItem>
              </ul>
              <SecondaryLink href="/customers" className="mt-8">
                See the attendee experience <ArrowRight className="h-4 w-4" />
              </SecondaryLink>
            </div>
          </div>
        </Container>
      </Section>

      {/* ── Offline highlight ── */}
      <Section className="border-b border-border bg-background-subtle/30">
        <Container>
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div>
              <Eyebrow>Never miss a scan</Eyebrow>
              <h2 className="mt-4 text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">
                Offline check-in that stays honest
              </h2>
              <p className="mt-4 text-lg leading-relaxed text-text-secondary">
                Venue networks fail at the worst moment. ETicketsGo keeps the gate moving with
                cryptographically-signed device manifests and a durable local queue — then the
                server reconciles every scan when you reconnect. A rejected scan can never be turned
                into an admission.
              </p>
              <ul className="mt-6 space-y-3.5">
                <CheckItem>Signed, device-scoped manifests — no secrets on the device</CheckItem>
                <CheckItem>Controlled activation with audited go / no-go gates</CheckItem>
                <CheckItem>Reconciliation console and live command center</CheckItem>
              </ul>
            </div>
            <div className="flex justify-center">
              <div className="relative w-full max-w-sm rounded-3xl border border-border bg-background-surface p-6 shadow-lg">
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-2 rounded-full bg-status-warning/15 px-3 py-1 text-caption font-semibold text-status-warning">
                    <WifiOff className="h-3.5 w-3.5" /> Offline
                  </span>
                  <span className="text-caption text-text-muted">Gate A</span>
                </div>
                <div className="mt-5 flex items-center justify-center rounded-2xl border border-border bg-background-subtle py-8">
                  <QrCode className="h-24 w-24 text-text-primary" strokeWidth={1.2} />
                </div>
                <div className="mt-5 space-y-2">
                  <div className="flex items-center justify-between rounded-lg bg-status-success/10 px-3 py-2 text-caption">
                    <span className="font-medium text-status-success">Accepted · queued</span>
                    <span className="text-text-muted">A-101</span>
                  </div>
                  <div className="flex items-center justify-between rounded-lg bg-background-subtle px-3 py-2 text-caption">
                    <span className="text-text-secondary">12 queued · syncing on reconnect</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Container>
      </Section>

      {/* ── Trust / security ── */}
      <Section className="border-b border-border">
        <Container>
          <SectionHeading
            eyebrow="Built to be trusted"
            title="Secure, reliable, and fair by design"
            lead="Financial integrity and attendee trust are engineered in — not bolted on."
          />
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <FeatureCard icon={ShieldCheck} title="Secure by default">
              Fail-closed production config, no card data stored, and a full immutable audit trail.
            </FeatureCard>
            <FeatureCard icon={QrCode} title="Replay-safe tickets">
              Rotating signed QR codes with single-use, atomic check-in — no double entry.
            </FeatureCard>
            <FeatureCard icon={Wallet} title="Money you can reconcile">
              Integer-precise amounts, idempotent transitions, and finance reconciliation.
            </FeatureCard>
            <FeatureCard icon={Users} title="Fair to buyers">
              Transparent fees, honest refunds, and a server that&rsquo;s always the source of
              truth.
            </FeatureCard>
          </div>
        </Container>
      </Section>

      {/* ── Pricing preview ── */}
      <Section id="pricing" className="border-b border-border bg-background-subtle/30">
        <Container>
          <SectionHeading
            eyebrow="Simple pricing"
            title="Plans that scale with your events"
            lead="Start free, grow into advanced tooling. Final pricing is being finalized — figures below are illustrative."
          />
          <div className="mx-auto mt-12 grid max-w-5xl gap-6 lg:grid-cols-3">
            <PlanCard
              name="Starter"
              price="Free"
              blurb="For your first events and small on-sales."
              features={['Unlimited events', 'Core ticketing', 'QR check-in', 'Basic reports']}
              href="/pricing"
            />
            <PlanCard
              name="Professional"
              price="From 2%"
              blurb="For growing organizers who sell regularly."
              features={[
                'Reserved seating',
                'Coupons & promotions',
                'Offline check-in',
                'Full analytics + CSV',
              ]}
              href="/pricing"
              featured
            />
            <PlanCard
              name="Enterprise"
              price="Custom"
              blurb="For venues, chains, and high-volume sellers."
              features={[
                'Multi-provider payments',
                'SLA & priority support',
                'Advanced controls',
                'Onboarding',
              ]}
              href="/contact"
            />
          </div>
          <p className="mt-6 text-center text-caption text-text-muted">
            Illustrative placeholder pricing — see the{' '}
            <a href="/pricing" className="font-medium text-action-primary hover:underline">
              full pricing page
            </a>
            .
          </p>
        </Container>
      </Section>

      {/* ── Testimonials (placeholder) ── */}
      <Section className="border-b border-border">
        <Container>
          <SectionHeading
            eyebrow="Loved by organizers"
            title="What teams say"
            lead="Placeholder testimonials for demonstration."
          />
          <div className="mt-12 grid gap-6 lg:grid-cols-3">
            {[
              {
                q: 'We moved our whole on-sale to ETicketsGo and the gate finally stopped being a bottleneck.',
                a: 'Festival Director',
                c: 'Placeholder',
              },
              {
                q: 'Reserved seating and offline check-in in one platform saved us two vendors.',
                a: 'Venue Manager',
                c: 'Placeholder',
              },
              {
                q: 'The analytics tell us what actually sells. Refunds and payouts just reconcile.',
                a: 'Promoter',
                c: 'Placeholder',
              },
            ].map((t, i) => (
              <figure
                key={i}
                className="rounded-2xl border border-border bg-background-surface p-6 shadow-sm"
              >
                <blockquote className="text-[0.9375rem] leading-relaxed text-text-secondary">
                  “{t.q}”
                </blockquote>
                <figcaption className="mt-5 flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-action-primary/10 text-caption font-semibold text-action-primary">
                    {t.a[0]}
                  </span>
                  <span className="text-caption">
                    <span className="block font-semibold text-text-primary">{t.a}</span>
                    <span className="text-text-muted">{t.c}</span>
                  </span>
                </figcaption>
              </figure>
            ))}
          </div>
        </Container>
      </Section>

      {/* ── FAQ (zero-JS accordion) ── */}
      <Section className="border-b border-border">
        <Container className="max-w-3xl">
          <SectionHeading eyebrow="Questions" title="Frequently asked" />
          <div className="mt-10 divide-y divide-border rounded-2xl border border-border bg-background-surface">
            {[
              [
                'Is ETicketsGo free to start?',
                'Yes — you can create events and explore the platform. Live payments require completing payment onboarding; the demo uses mock payments.',
              ],
              [
                'Do I need internet to check people in?',
                'No. Offline gate check-in keeps scanning with a signed manifest and a durable queue, then reconciles with the server on reconnect.',
              ],
              [
                'Which payment providers are supported?',
                'The platform routes across multiple providers (e.g. Stripe, Razorpay, PayPal, Square) by country and currency, with failover.',
              ],
              [
                'Can attendees get refunds?',
                'Yes, within each event’s refund window (a default cut-off before the session), subject to the organizer’s policy.',
              ],
            ].map(([q, a]) => (
              <details
                key={q}
                className="group px-5 py-4 [&_summary::-webkit-details-marker]:hidden"
              >
                <summary className="flex cursor-pointer items-center justify-between gap-4 text-[0.9375rem] font-semibold text-text-primary">
                  {q}
                  <span
                    className="text-text-muted transition-transform group-open:rotate-45"
                    aria-hidden
                  >
                    +
                  </span>
                </summary>
                <p className="mt-3 text-[0.9375rem] leading-relaxed text-text-secondary">{a}</p>
              </details>
            ))}
          </div>
          <p className="mt-6 text-center text-caption text-text-muted">
            More in the{' '}
            <a href="/faq" className="font-medium text-action-primary hover:underline">
              full FAQ
            </a>
            .
          </p>
        </Container>
      </Section>

      {/* ── Final CTA ── */}
      <Section>
        <CtaBand
          title="Ready to run your next event on ETicketsGo?"
          lead="Create your account and publish your first event in minutes."
          primaryHref="/register"
          primaryLabel="Get started free"
          secondaryHref="/contact"
          secondaryLabel="Talk to us"
        />
      </Section>
    </>
  );
}

/* ── Local presentational pieces ── */

function HeroPreview() {
  return (
    <div className="relative">
      <div className="rounded-3xl border border-border bg-background-surface p-5 shadow-lg">
        <div className="flex items-center justify-between border-b border-border pb-3">
          <span className="text-caption font-semibold text-text-primary">Sales dashboard</span>
          <span className="inline-flex items-center gap-1.5 text-caption text-status-success">
            <span className="h-1.5 w-1.5 rounded-full bg-status-success" /> Live
          </span>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3">
          {[
            ['Revenue', '₹4.2L'],
            ['Tickets', '1,284'],
            ['Check-in', '92%'],
          ].map(([l, v]) => (
            <div key={l} className="rounded-xl border border-border bg-background-subtle/60 p-3">
              <div className="text-caption text-text-muted">{l}</div>
              <div className="mt-1 text-lg font-bold text-text-primary">{v}</div>
            </div>
          ))}
        </div>
        <div className="mt-4 flex h-28 items-end gap-2 rounded-xl border border-border bg-background-subtle/40 p-3">
          {[40, 65, 52, 78, 60, 88, 72, 95].map((h, i) => (
            <div
              key={i}
              className="flex-1 rounded-t-md bg-action-primary/70"
              style={{ height: `${h}%` }}
            />
          ))}
        </div>
        <div className="mt-4 space-y-2">
          {['General · ₹799', 'Gold · ₹1,499'].map((row) => (
            <div
              key={row}
              className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-caption"
            >
              <span className="font-medium text-text-primary">{row}</span>
              <span className="text-text-muted">On sale</span>
            </div>
          ))}
        </div>
      </div>
      <div className="absolute -bottom-5 -left-5 hidden rounded-2xl border border-border bg-background-surface p-3 shadow-md sm:block">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-status-success/15 text-status-success">
            <QrCode className="h-5 w-5" />
          </span>
          <div className="text-caption">
            <div className="font-semibold text-text-primary">Checked in</div>
            <div className="text-text-muted">Seat A-101</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PlanCard({
  name,
  price,
  blurb,
  features,
  href,
  featured,
}: {
  name: string;
  price: string;
  blurb: string;
  features: string[];
  href: string;
  featured?: boolean;
}) {
  return (
    <div
      className={`relative flex flex-col rounded-2xl border p-6 shadow-sm ${
        featured
          ? 'border-action-primary/40 bg-background-surface ring-1 ring-action-primary/20'
          : 'border-border bg-background-surface'
      }`}
    >
      {featured && (
        <span className="absolute -top-3 left-6 rounded-full bg-action-primary px-3 py-1 text-caption font-semibold text-action-primary-foreground">
          Most popular
        </span>
      )}
      <h3 className="text-lg font-bold text-text-primary">{name}</h3>
      <div className="mt-2 text-3xl font-bold tracking-tight text-text-primary">{price}</div>
      <p className="mt-2 text-[0.9375rem] text-text-secondary">{blurb}</p>
      <ul className="mt-5 flex-1 space-y-2.5">
        {features.map((f) => (
          <CheckItem key={f}>{f}</CheckItem>
        ))}
      </ul>
      <a
        href={href}
        className={`mt-6 inline-flex items-center justify-center rounded-xl px-4 py-2.5 text-[0.9375rem] font-semibold transition-all ${
          featured
            ? 'bg-action-primary text-action-primary-foreground hover:bg-action-primary-hover'
            : 'border border-border bg-background-surface text-text-primary hover:bg-background-subtle'
        }`}
      >
        {name === 'Enterprise' ? 'Contact sales' : 'Choose ' + name}
      </a>
    </div>
  );
}
