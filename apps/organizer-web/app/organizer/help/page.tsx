'use client';

import { ChevronRight, PlayCircle, Mail, Rocket, BookOpen } from 'lucide-react';
import { ButtonLink, Card, PageHeader } from '@eticketsgo/web-kit';
import { OrganizerFeedback } from '@/components/organizer-feedback';

const SUPPORT_EMAIL = 'organizers@eticketsgo.example';

const GETTING_STARTED = [
  {
    title: 'Set up your organization',
    body: 'Confirm your organization details in Settings. Your organization must be approved before events can go live.',
    href: '/organizer/settings',
    cta: 'Open settings',
  },
  {
    title: 'Add a venue',
    body: 'Add the place your experiences happen — you can also create one inline while building an event.',
    href: '/organizer/onboarding',
    cta: 'Add a venue',
  },
  {
    title: 'Create your first experience',
    body: 'Use the guided wizard to add sessions and ticket types, then submit for review to publish.',
    href: '/organizer/events/new',
    cta: 'Create experience',
  },
];

const FAQS: { q: string; a: string }[] = [
  {
    q: 'How do I create an event?',
    a: 'Go to Events → Create event. The wizard walks you through basic details, venue, sessions, ticket types, and fee handling. You can start from a template on the Get started page to pre-fill the wizard.',
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
    a: 'Settlements are generated per organization (and optionally per event) from the Payouts page. A payout summarizes gross sales, booking and payment fees, and refunds to show your net revenue. Paid payouts show a Paid status.',
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
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        title="Help center"
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
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-action-primary/10 text-caption font-semibold text-action-primary">
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

      {/* Product walkthrough (video placeholder) */}
      <Card title="Product walkthrough">
        <div
          className="flex aspect-video w-full flex-col items-center justify-center rounded-lg border border-dashed border-border bg-background-subtle/50 text-center"
          role="img"
          aria-label="Product walkthrough video — coming soon"
        >
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-action-primary/10 text-action-primary">
            <PlayCircle className="h-7 w-7" />
          </span>
          <p className="mt-4 font-semibold text-text-primary">Product walkthrough — coming soon</p>
          <p className="mt-1 max-w-sm text-caption text-text-muted">
            A guided video tour of creating events, selling tickets, and checking in attendees is on
            the way.
          </p>
        </div>
      </Card>

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

      {/* Support */}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-action-primary/10 text-action-primary">
              <BookOpen className="h-5 w-5" />
            </span>
            <div>
              <p className="font-semibold text-text-primary">Still need help?</p>
              <p className="mt-1 text-[0.9375rem] text-text-muted">
                Our organizer support team is happy to help with anything not covered above.
              </p>
            </div>
          </div>
          <ButtonLink href={`mailto:${SUPPORT_EMAIL}`} variant="outline">
            <Mail className="h-4 w-4" />
            Contact support
          </ButtonLink>
        </div>
      </Card>

      {/* Organizer satisfaction survey + send feedback */}
      <OrganizerFeedback />
    </div>
  );
}
