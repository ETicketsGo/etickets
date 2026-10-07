import type { Metadata } from 'next';
import { Link } from '@/i18n/navigation';
import { PageHero } from '@/components/marketing/blocks';
import { OperatorLine } from '@/components/legal/policy-chrome';

/**
 * One place that lists what ETicketsGo publishes, so the documents are a set rather than
 * five unrelated URLs a customer has to already know about.
 *
 * -- WHY THIS IS A LIST AND NOT A LANDING PAGE -------------------------------------------
 * Somebody arrives here because a payment went wrong, an event moved, or a text message
 * asked them to. They want the right document in one glance. So: a plain list, each entry
 * saying in a sentence what question it answers, and nothing competing with it. No hero
 * imagery, no marketing copy, no "trusted by" band.
 *
 * -- NO COUNTRY CONTROL HERE EITHER ------------------------------------------------------
 * Each link goes to the canonical document, which resolves the reader's market from the one
 * the product already resolved. The customer never picks a jurisdiction, here or anywhere.
 */
export const metadata: Metadata = {
  title: 'Legal & Policies',
  description: 'The terms, privacy, refund, messaging and cookie policies for ETicketsGo.',
  alternates: { canonical: '/legal' },
  robots: { index: true, follow: true },
};

/**
 * Only documents that genuinely exist and are ready to be read by the public.
 *
 * The organizer agreement is deliberately listed last and described as what it is - it is a
 * real published document, not an invented one. Nothing is listed here to make the page look
 * fuller.
 */
const DOCUMENTS = [
  {
    href: '/terms',
    title: 'Terms & Conditions',
    blurb: 'The rules for using ETicketsGo and buying tickets.',
  },
  {
    href: '/refunds',
    title: 'Ticket purchases, cancellations & refunds',
    blurb: 'What happens when you buy a ticket, an event changes, or a refund is issued.',
  },
  {
    href: '/privacy',
    title: 'Privacy Policy',
    blurb: 'What we collect, why we collect it, and how we protect it.',
  },
  {
    href: '/sms',
    title: 'Text messages',
    blurb: 'What we send, how often, and how to stop. Includes STOP and HELP.',
  },
  {
    href: '/cookies',
    title: 'Cookies',
    blurb: 'What we store on your device, and why there is no cookie banner.',
  },
  {
    href: '/organizer-agreement',
    title: 'Organizer agreement',
    blurb: 'The additional terms for organizers selling tickets on ETicketsGo.',
  },
];

export default function LegalCenterPage() {
  return (
    <>
      <PageHero
        eyebrow="Legal"
        title="Legal & Policies"
        lead="Everything that governs your use of ETicketsGo, in one place."
      />
      <section className="bg-background-canvas pb-20 pt-8 sm:pb-28 sm:pt-10">
        <div className="mx-auto w-full max-w-shell px-4 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-[46rem] space-y-8">
            <ul className="divide-y divide-border border-y border-border">
              {DOCUMENTS.map((doc) => (
                <li key={doc.href}>
                  <Link
                    href={doc.href}
                    className="group flex items-start justify-between gap-4 py-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                  >
                    <span>
                      <span className="block text-base font-semibold text-text-primary group-hover:text-action-primary">
                        {doc.title}
                      </span>
                      <span className="mt-1 block text-[0.9375rem] leading-relaxed text-text-secondary">
                        {doc.blurb}
                      </span>
                    </span>
                    <span
                      aria-hidden
                      className="mt-1 shrink-0 text-text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-action-primary"
                    >
                      &rarr;
                    </span>
                  </Link>
                </li>
              ))}
            </ul>

            <p className="text-[0.9375rem] leading-relaxed text-text-secondary">
              We publish a version of these documents for each country we operate in, and you are
              shown the one that applies to the market you are browsing. If you need another
              country&apos;s version, or have a question about any of this, write to us at{' '}
              <a
                className="font-medium text-action-primary hover:underline"
                href="mailto:support@eticketsgo.com"
              >
                support@eticketsgo.com
              </a>
              .
            </p>

            <OperatorLine />
          </div>
        </div>
      </section>
    </>
  );
}
