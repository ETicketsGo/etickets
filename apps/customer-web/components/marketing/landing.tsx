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
  CtaBand,
  PrimaryLink,
  SecondaryLink,
  CheckItem,
  MK_FOCUS,
  MK_LINK,
  MK_PRIMARY,
  MK_SECONDARY,
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
      <div className="relative overflow-hidden border-b border-brand-line">
        {/* Tighter above and below the fold on a phone; unchanged from `sm` up. */}
        <Container className="pb-10 pt-10 sm:pb-24 sm:pt-24">
          <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr]">
            <div>
              <Eyebrow>Ticketing platform</Eyebrow>
              <h1 className="mt-3 text-balance font-brand-display text-brand-hero text-brand-ink">
                Sell tickets. Check in guests. Grow every event.
              </h1>
              <p className="mt-6 max-w-xl text-pretty text-brand-lead text-brand-ink-2">
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
              {/*
                "The demo uses mock payments" used to be here, and it was written when this ran as
                a demo. On the production site it is both stale and untrue - production refuses to
                start on the simulated gateway at all - and it is the first thing a payment
                gateway's reviewer reads on the page they were given. What IS true about payments
                is said where it matters, on the payment step.
              */}
              <p className="mt-5 text-brand-meta text-brand-ink-3">No setup fee. Cancel anytime.</p>
            </div>
            <HeroPreview />
          </div>
          <div className="mt-10 grid grid-cols-2 gap-6 border-t border-brand-line pt-8 sm:mt-16 sm:grid-cols-4 sm:pt-10">
            <Stat value="Seat maps" label="Reserved seating" />
            <Stat value="4 providers" label="Payment gateways" />
            <Stat value="Offline" label="Check-in at the gate" />
            <Stat value="Live" label="Sales reports" />
          </div>
        </Container>
      </div>

      {/* ── Categories ── */}
      <Section className="border-b border-brand-line">
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
                className="inline-flex items-center gap-2 rounded-full border border-brand-line bg-brand-surface px-4 py-2 text-brand-ui font-medium text-brand-ink-2"
              >
                <c.icon aria-hidden className="h-4 w-4 text-brand-ink" />
                {c.label}
              </span>
            ))}
          </div>
        </Container>
      </Section>

      {/* ── Capabilities ── */}
      <Section id="capabilities" className="border-b border-brand-line bg-brand-sunken">
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
      <Section className="border-b border-brand-line">
        <Container>
          <div className="grid gap-12 lg:grid-cols-2">
            <div className="rounded-brand-card border border-brand-line bg-brand-surface p-8">
              <Eyebrow>For organizers</Eyebrow>
              <h3 className="mt-4 font-brand-display text-brand-d3 text-brand-ink">
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
            <div className="rounded-brand-card border border-brand-line bg-brand-surface p-8">
              <Eyebrow>For attendees</Eyebrow>
              <h3 className="mt-4 font-brand-display text-brand-d3 text-brand-ink">
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
      <Section className="border-b border-brand-line bg-brand-sunken">
        <Container>
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div>
              <Eyebrow>Never miss a scan</Eyebrow>
              <h2 className="mt-3 font-brand-display text-brand-d2 text-brand-ink">
                Check people in without a network
              </h2>
              <p className="mt-4 text-brand-lead text-brand-ink-2">
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
              <div className="relative w-full max-w-sm rounded-brand-card border border-brand-line bg-brand-surface p-6">
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-2 rounded-full bg-brand-caution-tint px-3 py-1 text-brand-meta font-semibold text-brand-caution">
                    <WifiOff className="h-3.5 w-3.5" /> Offline
                  </span>
                  <span className="text-brand-meta text-brand-ink-3">Gate A</span>
                </div>
                <div className="mt-5 flex items-center justify-center rounded-brand-card border border-brand-line bg-brand-sunken py-8">
                  <QrCode className="h-24 w-24 text-brand-ink" strokeWidth={1.2} />
                </div>
                <div className="mt-5 space-y-2">
                  <div className="flex items-center justify-between rounded-lg bg-brand-positive-tint px-3 py-2 text-brand-meta">
                    <span className="font-medium text-brand-positive">Accepted, queued</span>
                    <span className="text-brand-ink-3">A-101</span>
                  </div>
                  <div className="flex items-center justify-between rounded-lg bg-brand-sunken px-3 py-2 text-brand-meta">
                    <span className="text-brand-ink-2">12 queued, syncing on reconnect</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Container>
      </Section>

      {/* ── Trust / security ── */}
      <Section className="border-b border-brand-line">
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
      <Section id="pricing" className="border-b border-brand-line bg-brand-sunken">
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
          <p className="mt-6 text-center text-brand-meta text-brand-ink-3">
            These prices are placeholders. See the{' '}
            <Link href="/pricing" className={MK_LINK}>
              full pricing page
            </Link>
            .
          </p>
        </Container>
      </Section>

      {/* ── FAQ (zero-JS accordion) ── */}
      <Section className="border-b border-brand-line">
        <Container className="max-w-3xl">
          <SectionHeading eyebrow="Questions" title="Frequently asked" />
          <div className="mt-10 divide-y divide-brand-line rounded-brand-card border border-brand-line bg-brand-surface">
            {[
              [
                'Is ETicketsGo free to start?',
                'Yes. You can create events and look around. To take real payments you finish payment onboarding first.',
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
                <summary
                  className={`flex min-h-11 cursor-pointer items-center justify-between gap-4 rounded-sm text-brand-ui font-semibold text-brand-ink ${MK_FOCUS}`}
                >
                  {q}
                  <span
                    className="text-brand-ink-3 transition-transform group-open:rotate-45"
                    aria-hidden
                  >
                    +
                  </span>
                </summary>
                <p className="mt-3 text-brand-ui leading-relaxed text-brand-ink-2">{a}</p>
              </details>
            ))}
          </div>
          <p className="mt-6 text-center text-brand-meta text-brand-ink-3">
            More in the{' '}
            <Link href="/faq" className={MK_LINK}>
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
          lead="Create an organizer account and publish your first event."
          primaryHref="/register?intent=organizer"
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
      <div className="rounded-brand-card border border-brand-line bg-brand-surface p-5">
        <div className="flex items-center justify-between border-b border-brand-line pb-3">
          <span className="text-brand-meta font-semibold text-brand-ink">Sales dashboard</span>
          <span className="inline-flex items-center gap-1.5 text-brand-meta text-brand-positive">
            <span className="h-1.5 w-1.5 rounded-full bg-brand-positive" /> Live
          </span>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3">
          {[
            ['Revenue', '₹4.2L'],
            ['Tickets', '1,284'],
            ['Check-in', '92%'],
          ].map(([l, v]) => (
            <div
              key={l}
              className="rounded-brand-control border border-brand-line bg-brand-sunken p-3"
            >
              <div className="text-brand-meta text-brand-ink-3">{l}</div>
              <div className="mt-1 font-brand-display text-brand-d3 text-brand-ink">{v}</div>
            </div>
          ))}
        </div>
        <div className="mt-4 flex h-28 items-end gap-2 rounded-brand-control border border-brand-line bg-brand-sunken p-3">
          {[40, 65, 52, 78, 60, 88, 72, 95].map((h, i) => (
            <div
              key={i}
              className="flex-1 rounded-t-md bg-brand-marigold"
              style={{ height: `${h}%` }}
            />
          ))}
        </div>
        <div className="mt-4 space-y-2">
          {['General - ₹799', 'Gold - ₹1,499'].map((row) => (
            <div
              key={row}
              className="flex items-center justify-between rounded-lg border border-brand-line px-3 py-2 text-brand-meta"
            >
              <span className="font-medium text-brand-ink">{row}</span>
              <span className="text-brand-ink-3">On sale</span>
            </div>
          ))}
        </div>
      </div>
      <div className="absolute -bottom-5 -left-5 hidden rounded-brand-card border border-brand-line bg-brand-surface p-3 sm:block">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-positive-tint text-brand-positive">
            <QrCode className="h-5 w-5" />
          </span>
          <div className="text-brand-meta">
            <div className="font-semibold text-brand-ink">Checked in</div>
            <div className="text-brand-ink-3">Seat A-101</div>
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
      className={`relative flex flex-col rounded-brand-card border p-6 ${
        featured
          ? 'border-brand-ink bg-brand-surface ring-1 ring-brand-ink'
          : 'border-brand-line bg-brand-surface'
      }`}
    >
      {featured && (
        <span className="absolute -top-3 left-6 rounded-full bg-brand-action px-3 py-1 text-brand-meta font-semibold text-brand-on-action">
          Most popular
        </span>
      )}
      <h3 className="font-brand-display text-brand-d3 text-brand-ink">{name}</h3>
      <div className="mt-2 font-brand-display text-brand-figure text-brand-ink">{price}</div>
      <p className="mt-2 text-brand-ui text-brand-ink-2">{blurb}</p>
      <ul className="mt-5 flex-1 space-y-2.5">
        {features.map((f) => (
          <CheckItem key={f}>{f}</CheckItem>
        ))}
      </ul>
      <Link href={href} className={`mt-6 ${featured ? MK_PRIMARY : MK_SECONDARY}`}>
        {name === 'Enterprise' ? 'Contact sales' : 'Choose ' + name}
      </Link>
    </div>
  );
}
