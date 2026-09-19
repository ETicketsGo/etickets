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
import { Link } from '@/i18n/navigation';

const CATEGORIES = [
  { icon: Film, label: 'Movies' },
  { icon: Music, label: 'Concerts' },
  { icon: Trophy, label: 'Sports' },
  { icon: Mic2, label: 'Comedy' },
  { icon: Theater, label: 'Theatre' },
  { icon: CalendarDays, label: 'Conferences' },
];

export function MarketingLanding() {
  return (
    <>
      {/* ── Hero ── */}
      <div className="relative overflow-hidden border-b border-border">
        <GradientBackdrop />
        <Container className="pb-16 pt-16 sm:pb-24 sm:pt-24">
          <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr]">
            <div>
              <Eyebrow>Ticketing platform</Eyebrow>
              <h1 className="mt-5 text-balance text-4xl font-bold leading-[1.08] tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                Sell tickets. Check in guests.{' '}
                <span className="text-action-primary">Grow every event.</span>
              </h1>
              <p className="mt-6 max-w-xl text-pretty text-lg leading-relaxed text-text-secondary">
                ETicketsGo runs your box office. Sell tickets, reserve seats, take payments, and
                scan people in at the gate. Buyers get a clear checkout and a QR ticket on their
                phone.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <PrimaryLink href="/register?intent=organizer">
                  Start selling tickets <ArrowRight className="h-4 w-4" />
                </PrimaryLink>
                <SecondaryLink href="/events">Browse live events</SecondaryLink>
              </div>
              <p className="mt-5 text-caption text-text-muted">
                No setup fee. The demo uses mock payments. Cancel anytime.
              </p>
            </div>
            <HeroPreview />
          </div>
          <div className="mt-16 grid grid-cols-2 gap-6 border-t border-border pt-10 sm:grid-cols-4">
            <Stat value="Seat maps" label="Reserved seating" />
            <Stat value="4 providers" label="Payment gateways" />
            <Stat value="Offline" label="Check-in at the gate" />
            <Stat value="Live" label="Sales reports" />
          </div>
        </Container>
      </div>

      {/* ── Categories ── */}
      <Section className="border-b border-border">
        <Container>
          <SectionHeading
            eyebrow="Event types"
            title="Sell tickets for any kind of event"
            lead="One comedy night, a three-day festival, or every screen in a cinema chain."
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
            eyebrow="What you get"
            title="Ticketing, seating, payments, check-in"
            lead="You set all of it up in one place, and the parts read the same data."
          />
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <FeatureCard icon={Ticket} title="Events and tickets">
              Publish an event with its sessions and ticket types. Change the inventory later, and
              watch sales as they come in.
            </FeatureCard>
            <FeatureCard icon={Armchair} title="Reserved seating">
              Buyers pick their seats on a map. We hold each seat, so two people cannot buy the same
              one.
            </FeatureCard>
            <FeatureCard icon={CreditCard} title="Payments and payouts">
              We send each payment to a provider that works in your country. You get a payout
              statement you can check.
            </FeatureCard>
            <FeatureCard icon={Tag} title="Coupons">
              Hand out discount codes for a percentage or a fixed amount. Set how many people can
              use each code, and until when.
            </FeatureCard>
            <FeatureCard icon={WifiOff} title="Offline gate check-in">
              The venue Wi-Fi can drop and the queue keeps moving. Each device holds a signed list
              of tickets and stores its scans until it can sync.
            </FeatureCard>
            <FeatureCard icon={BarChart3} title="Reports">
              See sales, revenue, refunds, and how many people checked in. Download any report as a
              CSV file.
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
                Run your box office
              </h3>
              <ul className="mt-6 space-y-3.5">
                <CheckItem>Build an event step by step, and save a draft first</CheckItem>
                <CheckItem>Watch sales live, and download the door list</CheckItem>
                <CheckItem>Set coupons, who pays the fees, and a refund window</CheckItem>
                <CheckItem>Approve the devices that scan at the gate</CheckItem>
                <CheckItem>Check every payment against your payout statement</CheckItem>
              </ul>
              <PrimaryLink href="/organizers" className="mt-8">
                See what organizers get <ArrowRight className="h-4 w-4" />
              </PrimaryLink>
            </div>
            <div className="rounded-3xl border border-border bg-background-surface p-8 shadow-sm">
              <Eyebrow>For attendees</Eyebrow>
              <h3 className="mt-4 text-2xl font-bold tracking-tight text-text-primary">
                Book on a phone, get in fast
              </h3>
              <ul className="mt-6 space-y-3.5">
                <CheckItem>Find an event and pick your seats on a map</CheckItem>
                <CheckItem>See the full total before you pay</CheckItem>
                <CheckItem>Your QR ticket opens without a signal</CheckItem>
                <CheckItem>Add the ticket to a wallet, or send it to a friend</CheckItem>
                <CheckItem>Ask for a refund inside the refund window</CheckItem>
              </ul>
              <SecondaryLink href="/customers" className="mt-8">
                See what buyers get <ArrowRight className="h-4 w-4" />
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
                Check people in without a network
              </h2>
              <p className="mt-4 text-lg leading-relaxed text-text-secondary">
                Venue networks fail at the worst moment. Each approved device carries a signed list
                of tickets and keeps its scans on the device. The server checks every scan when the
                device reconnects. A scan the device rejected can never become an admission.
              </p>
              <ul className="mt-6 space-y-3.5">
                <CheckItem>The device holds no signing key</CheckItem>
                <CheckItem>Someone has to approve each device before it scans</CheckItem>
                <CheckItem>A console shows you every scan once it syncs</CheckItem>
              </ul>
            </div>
            <div className="flex justify-center">
              <div className="relative w-full max-w-sm rounded-3xl border border-border bg-background-surface p-6 shadow-lg">
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-2 rounded-full bg-tint-warning px-3 py-1 text-caption font-semibold text-status-warning">
                    <WifiOff className="h-3.5 w-3.5" /> Offline
                  </span>
                  <span className="text-caption text-text-muted">Gate A</span>
                </div>
                <div className="mt-5 flex items-center justify-center rounded-2xl border border-border bg-background-subtle py-8">
                  <QrCode className="h-24 w-24 text-text-primary" strokeWidth={1.2} />
                </div>
                <div className="mt-5 space-y-2">
                  <div className="flex items-center justify-between rounded-lg bg-status-success/10 px-3 py-2 text-caption">
                    <span className="font-medium text-status-success">Accepted, queued</span>
                    <span className="text-text-muted">A-101</span>
                  </div>
                  <div className="flex items-center justify-between rounded-lg bg-background-subtle px-3 py-2 text-caption">
                    <span className="text-text-secondary">12 queued, syncing on reconnect</span>
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
            eyebrow="Security and money"
            title="How we protect tickets and money"
            lead="We store amounts as whole units, and every ticket code works once."
          />
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <FeatureCard icon={ShieldCheck} title="Secure by default">
              We do not store card numbers. The app refuses to start when a production setting is
              unsafe.
            </FeatureCard>
            <FeatureCard icon={QrCode} title="Tickets that work once">
              Each QR code is signed and changes over time. The gate accepts it once, so nobody gets
              in twice.
            </FeatureCard>
            <FeatureCard icon={Wallet} title="Money you can check">
              We store amounts as whole units, never as rounded decimals. Repeating a request does
              not charge twice.
            </FeatureCard>
            <FeatureCard icon={Users} title="Fair to buyers">
              Buyers see every fee before they pay. Refunds follow the window shown on the event.
            </FeatureCard>
          </div>
        </Container>
      </Section>

      {/* ── Pricing preview ── */}
      <Section id="pricing" className="border-b border-border bg-background-subtle/30">
        <Container>
          <SectionHeading
            eyebrow="Simple pricing"
            title="Three plans"
            lead="Start on the free plan. The prices below are placeholders while we set the real ones."
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
              blurb="For organizers who sell regularly."
              features={[
                'Reserved seating',
                'Coupons and promotions',
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
                'SLA and priority support',
                'Advanced controls',
                'Onboarding',
              ]}
              href="/contact"
            />
          </div>
          <p className="mt-6 text-center text-caption text-text-muted">
            These prices are placeholders. See the{' '}
            <Link href="/pricing" className="font-medium text-action-primary hover:underline">
              full pricing page
            </Link>
            .
          </p>
        </Container>
      </Section>

      {/* ── Testimonials (placeholder) ── */}
      <Section className="border-b border-border">
        <Container>
          <SectionHeading
            eyebrow="Testimonials"
            title="Sample quotes"
            lead="These quotes are placeholders. They are not from real customers."
          />
          <div className="mt-12 grid gap-6 lg:grid-cols-3">
            {[
              {
                q: 'We moved our whole on-sale to ETicketsGo and the gate stopped being a bottleneck.',
                a: 'Festival Director',
                c: 'Placeholder',
              },
              {
                q: 'Reserved seating and offline check-in in one platform saved us two vendors.',
                a: 'Venue Manager',
                c: 'Placeholder',
              },
              {
                q: 'The reports tell us what sells. Refunds and payouts add up.',
                a: 'Promoter',
                c: 'Placeholder',
              },
            ].map((t, i) => (
              <figure
                key={i}
                className="rounded-2xl border border-border bg-background-surface p-6 shadow-sm"
              >
                <blockquote className="text-[0.9375rem] leading-relaxed text-text-secondary">
                  &quot;{t.q}&quot;
                </blockquote>
                <figcaption className="mt-5 flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-tint-primary text-caption font-semibold text-action-primary">
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
                'Yes. You can create events and look around. To take real payments you finish payment onboarding first. The demo uses mock payments.',
              ],
              [
                'Do I need internet to check people in?',
                'No. The gate app scans from a signed list of tickets and stores each scan. The server checks them all when the device reconnects.',
              ],
              [
                'Which payment providers are supported?',
                'We route each payment by country and currency, and try another provider if one is down. Stripe, Razorpay, PayPal and Square are supported.',
              ],
              [
                'Can attendees get refunds?',
                'Yes, up to the cut-off on the event. The default cut-off is 48 hours before the session, and the organizer can set their own.',
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
            <Link href="/faq" className="font-medium text-action-primary hover:underline">
              full FAQ
            </Link>
            .
          </p>
        </Container>
      </Section>

      {/* ── Final CTA ── */}
      <Section>
        <CtaBand
          title="Put your next event on ETicketsGo"
          lead="Create an account and publish your first event."
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
          {['General - ₹799', 'Gold - ₹1,499'].map((row) => (
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
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-tint-success text-status-success">
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
      <Link
        href={href}
        className={`mt-6 inline-flex items-center justify-center rounded-xl px-4 py-2.5 text-[0.9375rem] font-semibold transition-all ${
          featured
            ? 'bg-action-primary text-action-primary-foreground hover:bg-action-primary-hover'
            : 'border border-border bg-background-surface text-text-primary hover:bg-background-subtle'
        }`}
      >
        {name === 'Enterprise' ? 'Contact sales' : 'Choose ' + name}
      </Link>
    </div>
  );
}
