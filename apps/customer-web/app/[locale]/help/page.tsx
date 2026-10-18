'use client';

import { ChevronRight, Mail, Bug, Lightbulb, MessageSquareWarning, Star } from 'lucide-react';
import { RatingStars } from '@/components/ui';
import { Panel } from '@/components/marketing/blocks';
import { MK_SECONDARY } from '@/components/marketing/kit';
import { BRAND_WRAP, BrandPage } from '@/components/storefront-brand';
import { FeedbackForm } from '@/components/feedback-form';
import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';

const FAQ_SECTIONS: { heading: string; items: { q: string; a: string }[] }[] = [
  {
    heading: 'Booking',
    items: [
      {
        q: 'How do I book tickets?',
        a: 'Open an event or film, choose a session, pick your seats or ticket types, and check out. We hold your tickets for a few minutes while you pay.',
      },
      {
        q: 'What does a held booking mean?',
        a: 'When you start a booking we reserve your tickets so nobody else can take them. Pay before the timer runs out, or we release them.',
      },
    ],
  },
  {
    heading: 'Payment',
    items: [
      {
        q: 'What payment methods are accepted?',
        /*
          This used to read "This demo uses a mock payment step, so no money is charged."
          The same sentence was taken off the landing page a while ago because it is stale
          and untrue - production refuses to start on the simulated gateway at all - and
          this copy of it was missed. On a live site it tells somebody no money is charged
          while their card is charged, which is the worst thing a help page can say.

          The replacement names no method on purpose. Which ones work is a property of the
          payment account for that country, not of this page, and a help page that promises
          UPI to somebody whose account does not have it enabled is wrong again in a new way.
        */
        a: 'You will see the methods available in your country at the payment step. The amount shown there is the full amount, including fees.',
      },
      {
        q: 'My payment failed. What now?',
        a: 'Nothing is charged on a failed payment. Your hold may have run out, so start the booking again from the event page.',
      },
    ],
  },
  {
    heading: 'Tickets and QR codes',
    items: [
      {
        q: 'Where are my tickets?',
        a: 'Your QR tickets appear under My tickets as soon as you pay. Each ticket has its own code, and we scan it at the door.',
      },
      {
        q: 'Can I transfer a ticket?',
        a: 'The organizer handles transfers. Contact them from the event page.',
      },
    ],
  },
  {
    heading: 'Refunds',
    items: [
      {
        q: 'How do I request a refund?',
        a: 'Open the booking under My bookings and request a refund. The organizer decides, and their refund policy is shown on the event.',
      },
    ],
  },
  {
    heading: 'Films and seats',
    items: [
      {
        q: 'How does seat selection work?',
        a: 'On films and seated shows you pick your seats from the seat map. We hold them while you check out.',
      },
    ],
  },
  {
    heading: 'Account',
    items: [
      {
        q: 'How do I update my profile?',
        a: 'Go to your account to change your name. We use your email for booking confirmations and support replies.',
      },
    ],
  },
];

export default function HelpCenterPage() {
  const m = useTranslations('common.marketing');
  return (
    <BrandPage>
      <div className={`${BRAND_WRAP} space-y-6 pt-8 lg:pt-14`}>
        <div className="mx-auto max-w-4xl space-y-6">
          <div>
            <h1 className="font-brand-display text-brand-d1 text-brand-ink">Help center</h1>
            <p className="mt-3 text-brand-lead text-brand-ink-2">
              Common questions, and how to reach us.
            </p>
          </div>

          {/* Quick actions */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Link
              href="/help/contact"
              className="flex flex-col rounded-brand-card border border-brand-line bg-brand-surface p-5 transition-colors hover:border-brand-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-focus focus-visible:ring-offset-2 focus-visible:ring-offset-brand-canvas"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-sunken text-brand-ink">
                <Mail className="h-4 w-4" />
              </span>
              <p className="mt-3 font-brand-display text-brand-card text-brand-ink">Contact us</p>
              <p className="mt-1 text-brand-meta text-brand-ink-2">
                Get help from our support team.
              </p>
            </Link>
            <Link
              href="/help/bug"
              className="flex flex-col rounded-brand-card border border-brand-line bg-brand-surface p-5 transition-colors hover:border-brand-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-focus focus-visible:ring-offset-2 focus-visible:ring-offset-brand-canvas"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-critical-tint text-brand-critical">
                <Bug className="h-4 w-4" />
              </span>
              <p className="mt-3 font-brand-display text-brand-card text-brand-ink">Report a bug</p>
              <p className="mt-1 text-brand-meta text-brand-ink-2">
                Something not working? Let us know.
              </p>
            </Link>
            <Link
              href="/help/feature"
              className="flex flex-col rounded-brand-card border border-brand-line bg-brand-surface p-5 transition-colors hover:border-brand-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-focus focus-visible:ring-offset-2 focus-visible:ring-offset-brand-canvas"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-sunken text-brand-ink">
                <Lightbulb className="h-4 w-4" />
              </span>
              <p className="mt-3 font-brand-display text-brand-card text-brand-ink">
                Request a feature
              </p>
              <p className="mt-1 text-brand-meta text-brand-ink-2">
                Tell us what you would like us to add.
              </p>
            </Link>
            {/*
          A complaint is not a contact message, and it needs its own door.

          Every grievance used to arrive as "Contact us", with nothing attaching it to the
          organizer it was about - so nobody could answer how many were open against a seller,
          which is the question that decides whether that seller keeps selling.
        */}
            <Link
              href="/help/complaint"
              className="flex flex-col rounded-brand-card border border-brand-line bg-brand-surface p-5 transition-colors hover:border-brand-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-focus focus-visible:ring-offset-2 focus-visible:ring-offset-brand-canvas"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-caution-tint text-brand-caution">
                <MessageSquareWarning className="h-4 w-4" />
              </span>
              <p className="mt-3 font-brand-display text-brand-card text-brand-ink">
                Make a complaint
              </p>
              <p className="mt-1 text-brand-meta text-brand-ink-2">
                Something was wrong with an event you booked.
              </p>
            </Link>
          </div>

          {/* FAQ */}
          <Panel title="Frequently asked questions">
            <div className="space-y-6">
              {FAQ_SECTIONS.map((section) => (
                <div key={section.heading}>
                  <h3 className="mb-1 text-brand-eyebrow uppercase text-brand-ink-3">
                    {section.heading}
                  </h3>
                  <div className="divide-y divide-brand-line">
                    {section.items.map((f) => (
                      <details key={f.q} className="group py-3">
                        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-sm text-brand-ui font-semibold text-brand-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-focus focus-visible:ring-offset-2 focus-visible:ring-offset-brand-canvas">
                          {f.q}
                          <ChevronRight className="h-4 w-4 shrink-0 text-brand-ink-3 transition-transform group-open:rotate-90" />
                        </summary>
                        <p className="mt-2 text-brand-ui text-brand-ink-2">{f.a}</p>
                      </details>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Panel>

          {/* Contact section */}
          <Panel
            title="Contact us"
            action={
              <span className="flex items-center gap-1.5 text-brand-meta text-brand-ink-2">
                <Mail className="h-4 w-4" />
                We usually reply within a day
              </span>
            }
          >
            <p className="mb-4 text-brand-ui text-brand-ink-2">
              Not here? Send us a message and we will reply.
            </p>
            <FeedbackForm
              kind="CONTACT"
              showSubject
              submitLabel="Send message"
              successMessage="Thanks. We will get back to you soon."
              messageLabel="How can we help?"
              messagePlaceholder="Describe your question or issue"
            />
          </Panel>

          {/* CSAT survey */}
          <Panel
            title="How are we doing?"
            action={
              <span className="flex items-center gap-1.5 text-brand-meta text-brand-ink-2">
                <Star className="h-4 w-4" />
                Satisfaction survey
              </span>
            }
          >
            <p className="mb-4 text-brand-ui text-brand-ink-2">
              Tell us how ETicketsGo is working for you. We read every rating.
            </p>
            <FeedbackForm
              kind="CSAT"
              showRating
              submitLabel="Submit rating"
              successMessage="Thanks for rating your experience!"
              messageLabel="Anything you'd like to add? (optional)"
              messagePlaceholder="Tell us more"
            />
          </Panel>

          <Panel>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <RatingStars value={5} size="sm" label="ETicketsGo" />
                <p className="text-brand-ui text-brand-ink-2">
                  Prefer to browse? Have a look at the events and films.
                </p>
              </div>
              <div className="flex gap-2">
                <Link href="/events" className={MK_SECONDARY}>
                  {m('browseEvents')}
                </Link>
                <Link href="/movies" className={MK_SECONDARY}>
                  Browse movies
                </Link>
              </div>
            </div>
          </Panel>
        </div>
      </div>
    </BrandPage>
  );
}
