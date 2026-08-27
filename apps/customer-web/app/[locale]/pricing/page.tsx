import type { Metadata } from 'next';
import { Check, Minus } from 'lucide-react';
import { Container, Section, SectionHeading, CheckItem, CtaBand } from '@/components/marketing/kit';
import { PageHero, NoticeBanner } from '@/components/marketing/blocks';

export const metadata: Metadata = {
  title: 'Pricing',
  description:
    'Simple, scalable pricing for event organizers — Starter, Professional, and Enterprise. Illustrative placeholder pricing pending final business decisions.',
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
    cta: { href: '/register', label: 'Start free' },
  },
  {
    name: 'Professional',
    price: 'From 2%',
    note: 'per ticket',
    blurb: 'For growing organizers who sell regularly.',
    features: [
      'Everything in Starter',
      'Reserved seating',
      'Coupons & promotions',
      'Offline check-in',
      'Full analytics + CSV export',
      'Priority support',
    ],
    cta: { href: '/register', label: 'Choose Professional' },
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
      'SLA & priority support',
      'Advanced controls & audit',
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
  { label: 'Coupons & promotions', starter: false, pro: true, ent: true },
  { label: 'Offline gate check-in', starter: false, pro: true, ent: true },
  { label: 'Analytics + CSV export', starter: 'Basic', pro: 'Full', ent: 'Full' },
  { label: 'Multi-provider payments', starter: false, pro: false, ent: true },
  { label: 'Dedicated onboarding', starter: false, pro: false, ent: true },
  { label: 'Support', starter: 'Email', pro: 'Priority', ent: 'SLA' },
];

function Cell({ v }: { v: boolean | string }) {
  if (v === true)
    return <Check className="mx-auto h-4 w-4 text-status-success" aria-label="Included" />;
  if (v === false)
    return <Minus className="mx-auto h-4 w-4 text-text-muted" aria-label="Not included" />;
  return <span className="text-caption font-medium text-text-secondary">{v}</span>;
}

export default function PricingPage() {
  return (
    <>
      <PageHero
        eyebrow="Pricing"
        title="Pricing that scales with your events"
        lead="Start free and grow into advanced tooling. You only pay more as you sell more."
      />

      <Section>
        <Container>
          <div className="mx-auto max-w-4xl">
            <NoticeBanner>
              Pricing figures below are <strong>illustrative placeholders</strong> shown for
              demonstration; final plans and rates are a pending business decision.
            </NoticeBanner>
          </div>
          <div className="mx-auto mt-12 grid max-w-5xl gap-6 lg:grid-cols-3">
            {PLANS.map((p) => (
              <div
                key={p.name}
                className={`relative flex flex-col rounded-2xl border p-7 shadow-sm ${
                  p.featured
                    ? 'border-action-primary/40 bg-background-surface ring-1 ring-action-primary/20'
                    : 'border-border bg-background-surface'
                }`}
              >
                {p.featured && (
                  <span className="absolute -top-3 left-7 rounded-full bg-action-primary px-3 py-1 text-caption font-semibold text-action-primary-foreground">
                    Most popular
                  </span>
                )}
                <h2 className="text-lg font-bold text-text-primary">{p.name}</h2>
                <div className="mt-3 flex items-baseline gap-1.5">
                  <span className="text-4xl font-bold tracking-tight text-text-primary">
                    {p.price}
                  </span>
                  <span className="text-caption text-text-muted">{p.note}</span>
                </div>
                <p className="mt-2 text-[0.9375rem] text-text-secondary">{p.blurb}</p>
                <ul className="mt-6 flex-1 space-y-2.5">
                  {p.features.map((f) => (
                    <CheckItem key={f}>{f}</CheckItem>
                  ))}
                </ul>
                <a
                  href={p.cta.href}
                  className={`mt-7 inline-flex items-center justify-center rounded-xl px-4 py-2.5 text-[0.9375rem] font-semibold transition-all ${
                    p.featured
                      ? 'bg-action-primary text-action-primary-foreground hover:bg-action-primary-hover'
                      : 'border border-border bg-background-surface text-text-primary hover:bg-background-subtle'
                  }`}
                >
                  {p.cta.label}
                </a>
              </div>
            ))}
          </div>
        </Container>
      </Section>

      <Section className="border-t border-border bg-background-subtle/30">
        <Container>
          <SectionHeading eyebrow="Compare" title="Compare plans" />
          <div className="mx-auto mt-10 max-w-4xl overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-left">
              <thead>
                <tr className="border-b border-border">
                  <th className="py-3 pr-4 text-[0.9375rem] font-semibold text-text-primary">
                    Feature
                  </th>
                  <th className="px-4 py-3 text-center text-[0.9375rem] font-semibold text-text-primary">
                    Starter
                  </th>
                  <th className="px-4 py-3 text-center text-[0.9375rem] font-semibold text-action-primary">
                    Professional
                  </th>
                  <th className="px-4 py-3 text-center text-[0.9375rem] font-semibold text-text-primary">
                    Enterprise
                  </th>
                </tr>
              </thead>
              <tbody>
                {MATRIX.map((row) => (
                  <tr key={row.label} className="border-b border-border">
                    <td className="py-3 pr-4 text-[0.9375rem] text-text-secondary">{row.label}</td>
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

      <Section className="border-t border-border">
        <Container className="max-w-3xl">
          <SectionHeading eyebrow="Pricing FAQ" title="Common questions" />
          <div className="mt-10 divide-y divide-border rounded-2xl border border-border bg-background-surface">
            {[
              [
                'How are fees charged?',
                'Depending on your plan and the event’s fee mode, a booking fee and payment-processing fee may apply. The buyer always sees the full total before paying.',
              ],
              [
                'Who pays the fees?',
                'You choose per event — the customer pays, you absorb them, or you split them.',
              ],
              [
                'When do I get paid?',
                'Proceeds settle to your verified merchant account net of fees, refunds, and chargebacks, per your payout schedule.',
              ],
              [
                'Is there a contract?',
                'Starter and Professional are self-serve with no long-term contract. Enterprise terms are agreed with our team.',
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
        </Container>
      </Section>

      <Section className="border-t border-border">
        <CtaBand
          title="Start free, upgrade when you're ready"
          lead="No card required to explore the platform."
          primaryHref="/register"
          primaryLabel="Create your account"
          secondaryHref="/contact"
          secondaryLabel="Talk to sales"
        />
      </Section>
    </>
  );
}
