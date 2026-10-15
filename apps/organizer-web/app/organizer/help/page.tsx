'use client';

import { ChevronRight, Mail, Rocket } from 'lucide-react';
import {
  BUSINESS_DETAILS,
  ButtonLink,
  Card,
  PageHeader,
  publishedDetail,
} from '@eticketsgo/web-kit';
import { OrganizerFeedback } from '@/components/organizer-feedback';
import { OrganizerSupportForm } from '@/components/organizer-support';

/*
  Read from the one place the business details live. This was a hardcoded
  `organizers@eticketsgo.example` - a reserved domain that can never resolve - so "Contact
  support" opened a mail client addressed to nowhere. Organizers are the people whose money
  passes through us; a dead support address is the last thing they should find here.
*/
const SUPPORT_EMAIL = publishedDetail(BUSINESS_DETAILS.organizerEmail);

const GETTING_STARTED = [
  {
    title: 'Set up your organization',
    body: 'Add your legal and tax details in Settings. ETicketsGo approves your organization before your events can go on sale.',
    href: '/organizer/settings#legal',
    cta: 'Open settings',
  },
  {
    title: 'Add a venue',
    body: 'Add the place your events happen. You can also add one while creating an event.',
    href: '/organizer/venues?new=1',
    cta: 'Add a venue',
  },
  {
    title: 'Create your first event',
    body: 'Use the guided wizard to add sessions and ticket types, then submit for review to publish.',
    href: '/organizer/events/new',
    cta: 'Create event',
  },
];

const FAQS: { q: string; a: string }[] = [
  {
    q: 'How do I create an event?',
    a: 'Go to Events → Create event. The wizard has five steps: basic details, venue, sessions, ticket types, and a review. You can change anything on the review step before you send it. You can also start from a template on the Get started page, which fills in the wizard for you.',
  },
  {
    q: 'How do ticket types and pricing work?',
    a: 'Each session can have one or more ticket types (e.g. General, VIP). Set a price, total quantity, and a max-per-order limit. You can add more ticket types later from the event’s Tickets tab.',
  },
  {
    q: 'How do seat maps work for movies?',
    a: 'Movie experiences use screens with seat maps. Create a Cinema, add Screens, then generate a seat map per screen (rows, seats-per-row, and price categories). When you schedule a show on that screen, customers pick seats from the map.',
  },
  {
    q: 'How do I publish an event? What is the review process?',
    a: 'When your event is ready, submit it for review. A platform admin approves it, after which it becomes Published and visible to customers. You can pause and resume a published event any time.',
  },
  {
    q: 'When and how do I get paid out?',
    a: 'Add the bank account your money is sent to on the Payouts page; we check it before the first transfer. An event becomes payable once it has finished and its holding period has passed. What you are paid (net) is your ticket sales less discounts, your platform fee and refunds. Booking and payment fees are paid by the buyer on top of the ticket price and are not taken from you. Finance & payouts shows where each amount is: held, ready to pay out, in a payout, or paid.',
  },
  {
    q: 'How are refunds handled?',
    a: 'Customers request refunds against a booking based on your refund policy. Refund requests are reviewed and approved or rejected. Refunded amounts are deducted from the relevant payout.',
  },
  {
    q: 'What team roles are available?',
    a: 'Invite members from the Team page. Owners and Managers can manage events and settings; Check-in Staff can scan tickets at the door but cannot change event configuration.',
  },
  {
    q: 'How does check-in at the door work?',
    a: 'Open an event’s Check-in tool and scan each attendee’s QR ticket. The scanner reports success, duplicates, wrong-session, or invalid tickets, and you can reverse an accidental check-in.',
  },
];

export default function HelpPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Help & support"
        description="Guides and answers for running events on ETicketsGo."
      />

      {/* Getting started */}
      <Card
        title="Getting started"
        action={
          <span className="flex items-center gap-1.5 text-caption text-text-muted">
            <Rocket className="h-4 w-4" />
            New here?
          </span>
        }
      >
        <div className="grid gap-3 sm:grid-cols-3">
          {GETTING_STARTED.map((g, i) => (
            <div
              key={g.title}
              className="flex flex-col rounded-lg border border-border bg-background-surface p-4"
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-tint-primary text-caption font-semibold text-action-primary">
                {i + 1}
              </span>
              <p className="mt-3 font-semibold text-text-primary">{g.title}</p>
              <p className="mt-1 flex-1 text-caption text-text-muted">{g.body}</p>
              <ButtonLink href={g.href} variant="outline" size="sm" className="mt-3">
                {g.cta}
              </ButtonLink>
            </div>
          ))}
        </div>
      </Card>

      {/*
        Support. This used to say "use Send feedback below - it reaches us", and Send feedback is a
        satisfaction survey that will not send without a star rating. A question now goes to the
        admin support inbox as a message, filed under this organization.
      */}
      <OrganizerSupportForm />
      {SUPPORT_EMAIL && (
        <p className="flex flex-wrap items-center gap-2 text-caption text-text-muted">
          Prefer email?
          <ButtonLink href={`mailto:${SUPPORT_EMAIL}`} variant="outline" size="sm">
            <Mail className="h-4 w-4" />
            {SUPPORT_EMAIL}
          </ButtonLink>
        </p>
      )}

      {/* FAQ */}
      <Card title="Frequently asked questions">
        <div className="divide-y divide-border">
          {FAQS.map((f) => (
            <details key={f.q} className="group py-3">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 font-medium text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                {f.q}
                <ChevronRight className="h-4 w-4 shrink-0 text-text-muted transition-transform group-open:rotate-90" />
              </summary>
              <p className="mt-2 text-[0.9375rem] text-text-secondary">{f.a}</p>
            </details>
          ))}
        </div>
      </Card>

      {/* Organizer satisfaction survey: a rating, not a way to ask for help. */}
      <OrganizerFeedback />
    </div>
  );
}
