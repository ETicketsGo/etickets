import type { Metadata } from 'next';
import { Check, Minus } from 'lucide-react';
import {
  Container,
  Section,
  SectionHeading,
  CheckItem,
  CtaBand,
  MK_PRIMARY,
  MK_SECONDARY,
} from '@/components/marketing/kit';
import { PageHero, NoticeBanner } from '@/components/marketing/blocks';
import { BrandPage } from '@/components/storefront-brand';

export const metadata: Metadata = {
  title: 'Pricing',
  description:
    'Starter, Professional and Enterprise plans for event organizers. The figures are placeholders while we set the real prices.',
  alternates: { canonical: '/pricing' },
};

const PLANS = [
  {
    name: 'Starter',
    price: 'Free',
    note: 'to get started',
    blurb: 'For your first events and small on-sales.',
    features: [
      'Unlimited events',
      'Core ticketing',
      'QR check-in',
      'Basic reports',
      'Email support',
    ],
    cta: { href: '/register?intent=organizer', label: 'Start free' },
  },
  {
    name: 'Professional',
    price: 'From 2%',
    note: 'per ticket',
    blurb: 'For organizers who sell regularly.',
    features: [
      'Everything in Starter',
      'Reserved seating',
      'Coupons and promotions',
      'Offline check-in',
      'Full analytics + CSV export',
      'Priority support',
    ],
    cta: { href: '/register?intent=organizer', label: 'Choose Professional' },
    featured: true,
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    note: 'talk to us',
    blurb: 'For venues, chains, and high-volume sellers.',
    features: [
      'Everything in Professional',
      'Multi-provider payment routing',
      'Dedicated onboarding',
      'SLA and priority support',
      'Advanced controls and audit log',
    ],
    cta: { href: '/contact', label: 'Contact sales' },
  },
];

const MATRIX: {
  label: string;
  starter: boolean | string;
  pro: boolean | string;
  ent: boolean | string;
}[] = [
  { label: 'Unlimited events', starter: true, pro: true, ent: true },
  { label: 'Tiered ticket types', starter: true, pro: true, ent: true },
  { label: 'QR check-in', starter: true, pro: true, ent: true },
  { label: 'Reserved seating', starter: false, pro: true, ent: true },
  { label: 'Coupons and promotions', starter: false, pro: true, ent: true },
  { label: 'Offline gate check-in', starter: false, pro: true, ent: true },
  { label: 'Analytics + CSV export', starter: 'Basic', pro: 'Full', ent: 'Full' },
  { label: 'Multi-provider payments', starter: false, pro: false, ent: true },
  { label: 'Dedicated onboarding', starter: false, pro: false, ent: true },
  { label: 'Support', starter: 'Email', pro: 'Priority', ent: 'SLA' },
];

function Cell({ v }: { v: boolean | string }) {
  if (v === true)
    return <Check className="mx-auto h-4 w-4 text-brand-positive" aria-label="Included" />;
  if (v === false)
    return <Minus className="mx-auto h-4 w-4 text-brand-ink-3" aria-label="Not included" />;
  return <span className="text-brand-meta font-medium text-brand-ink-2">{v}</span>;
}

export default function PricingPage() {
  return (
    <BrandPage>
      <PageHero
        eyebrow="Pricing"
        title="Plans and prices"
        lead="Start on the free plan. Move up when you need reserved seating or offline check-in."
      />

      <Section>
        <Container>
          <div className="mx-auto max-w-4xl">
            <NoticeBanner>
              The figures below are <strong>placeholders</strong>. We have not set the real plans or
              rates yet.
            </NoticeBanner>
          </div>
          <div className="mx-auto mt-12 grid max-w-5xl gap-6 lg:grid-cols-3">
            {PLANS.map((p) => (
              <div
                key={p.name}
                className={`relative flex flex-col rounded-brand-card border p-7 ${
                  p.featured
                    ? 'border-brand-ink bg-brand-surface ring-1 ring-brand-ink'
                    : 'border-brand-line bg-brand-surface'
                }`}
              >
                {p.featured && (
                  <span className="absolute -top-3 left-7 rounded-full bg-brand-action px-3 py-1 text-brand-meta font-semibold text-brand-on-action">
                    Most popular
                  </span>
                )}
                <h2 className="font-brand-display text-brand-d3 text-brand-ink">{p.name}</h2>
                <div className="mt-3 flex items-baseline gap-1.5">
                  <span className="font-brand-display text-brand-figure text-brand-ink">
                    {p.price}
                  </span>
                  <span className="text-brand-meta text-brand-ink-3">{p.note}</span>
                </div>
                <p className="mt-2 text-brand-ui text-brand-ink-2">{p.blurb}</p>
                <ul className="mt-6 flex-1 space-y-2.5">
                  {p.features.map((f) => (
                    <CheckItem key={f}>{f}</CheckItem>
                  ))}
                </ul>
                <a href={p.cta.href} className={`mt-7 ${p.featured ? MK_PRIMARY : MK_SECONDARY}`}>
                  {p.cta.label}
                </a>
              </div>
            ))}
          </div>
        </Container>
      </Section>

      <Section className="border-t border-brand-line bg-brand-sunken">
        <Container>
          <SectionHeading eyebrow="Compare" title="Compare plans" />
          {/*
            Focusable and named, because on a phone the table scrolls sideways inside this box
            and a keyboard user could not reach the columns past the edge (axe
            scrollable-region-focusable).
          */}
          <div
            className="mx-auto mt-10 max-w-4xl overflow-x-auto rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-focus"
            tabIndex={0}
            role="region"
            aria-label="Compare plans"
          >
            <table className="w-full min-w-[560px] border-collapse text-left">
              <thead>
                <tr className="border-b border-brand-line">
                  <th className="py-3 pr-4 text-brand-ui font-semibold text-brand-ink">Feature</th>
                  <th className="px-4 py-3 text-center text-brand-ui font-semibold text-brand-ink">
                    Starter
                  </th>
                  <th className="px-4 py-3 text-center text-brand-ui font-semibold text-brand-ink">
                    Professional
                  </th>
                  <th className="px-4 py-3 text-center text-brand-ui font-semibold text-brand-ink">
                    Enterprise
                  </th>
                </tr>
              </thead>
              <tbody>
                {MATRIX.map((row) => (
                  <tr key={row.label} className="border-b border-brand-line">
                    <td className="py-3 pr-4 text-brand-ui text-brand-ink-2">{row.label}</td>
                    <td className="px-4 py-3 text-center">
                      <Cell v={row.starter} />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Cell v={row.pro} />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Cell v={row.ent} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Container>
      </Section>

      <Section className="border-t border-brand-line">
        <Container className="max-w-3xl">
          <SectionHeading eyebrow="Pricing FAQ" title="Common questions" />
          <div className="mt-10 divide-y divide-brand-line rounded-brand-card border border-brand-line bg-brand-surface">
            {[
              [
                'How are fees charged?',
                'A booking fee and a payment-processing fee can apply. Which ones depends on your plan and the fee mode you chose for the event. The buyer always sees the full total before paying.',
              ],
              [
                'Who pays the fees?',
                'You choose per event. The customer pays them, you absorb them, or you split them.',
              ],
              [
                'When do I get paid?',
                'Your money settles to your verified merchant account on your payout schedule. Fees, refunds and chargebacks come off first.',
              ],
              [
                'Is there a contract?',
                'Starter and Professional are self-serve, with no long-term contract. Enterprise terms are agreed with our team.',
              ],
            ].map(([q, a]) => (
              <details
                key={q}
                className="group px-5 py-4 [&_summary::-webkit-details-marker]:hidden"
              >
                <summary className="flex cursor-pointer items-center justify-between gap-4 text-brand-ui font-semibold text-brand-ink">
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
        </Container>
      </Section>

      <Section className="border-t border-brand-line">
        <CtaBand
          title="Start free, upgrade when you're ready"
          lead="You do not need a card to look around."
          primaryHref="/register"
          primaryLabel="Create your account"
          secondaryHref="/contact"
          secondaryLabel="Talk to sales"
        />
      </Section>
    </BrandPage>
  );
}
