'use client';

import Link from 'next/link';
import { ChevronRight, Mail, Bug, Lightbulb, Star } from 'lucide-react';
import { Card, ButtonLink, RatingStars } from '@/components/ui';
import { FeedbackForm } from '@/components/feedback-form';

const FAQ_SECTIONS: { heading: string; items: { q: string; a: string }[] }[] = [
  {
    heading: 'Booking',
    items: [
      {
        q: 'How do I book tickets?',
        a: 'Open an event or movie, choose a session, pick your ticket types or seats, and check out. Your booking is held for a few minutes while you pay.',
      },
      {
        q: 'My booking is held — what does that mean?',
        a: 'When you start a booking we reserve your tickets for a short window so no one else can take them. Complete payment before the timer runs out or the hold is released.',
      },
    ],
  },
  {
    heading: 'Payment',
    items: [
      {
        q: 'What payment methods are accepted?',
        a: 'This demo uses a mock payment step — no real money is charged. In production, standard cards and popular wallets are supported.',
      },
      {
        q: 'My payment failed. What now?',
        a: 'Nothing is charged on a failed payment. Your hold may have expired — start the booking again from the event page.',
      },
    ],
  },
  {
    heading: 'Tickets & QR',
    items: [
      {
        q: 'Where are my tickets?',
        a: 'Right after payment your QR tickets appear under “My tickets”. Each ticket has a unique QR code scanned at the door.',
      },
      {
        q: 'Can I transfer a ticket?',
        a: 'Ticket transfers are handled by the organizer. Contact them via the event page for details.',
      },
    ],
  },
  {
    heading: 'Refunds',
    items: [
      {
        q: 'How do I request a refund?',
        a: 'Open the booking under “My bookings” and request a refund. Approval depends on the organizer’s refund policy shown on the event.',
      },
    ],
  },
  {
    heading: 'Movies & seats',
    items: [
      {
        q: 'How does seat selection work?',
        a: 'For movies and seated shows you pick specific seats from the seat map. Selected seats are held while you complete checkout.',
      },
    ],
  },
  {
    heading: 'Account',
    items: [
      {
        q: 'How do I update my profile?',
        a: 'Go to your account area to update your name. Your email is used for booking confirmations and support replies.',
      },
    ],
  },
];

export default function HelpCenterPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-h2 font-bold tracking-tight text-text-primary">Help center</h1>
        <p className="mt-1 text-[0.9375rem] text-text-muted">
          Answers to common questions, plus ways to reach us.
        </p>
      </div>

      {/* Quick actions */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Link
          href="/help/contact"
          className="flex flex-col rounded-lg border border-border bg-background-surface p-5 shadow-sm transition-all duration-200 ease-premium hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-tint-primary text-action-primary">
            <Mail className="h-4 w-4" />
          </span>
          <p className="mt-3 font-semibold text-text-primary">Contact us</p>
          <p className="mt-1 text-caption text-text-muted">Get help from our support team.</p>
        </Link>
        <Link
          href="/help/bug"
          className="flex flex-col rounded-lg border border-border bg-background-surface p-5 shadow-sm transition-all duration-200 ease-premium hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-status-error/10 text-status-error">
            <Bug className="h-4 w-4" />
          </span>
          <p className="mt-3 font-semibold text-text-primary">Report a bug</p>
          <p className="mt-1 text-caption text-text-muted">Something not working? Let us know.</p>
        </Link>
        <Link
          href="/help/feature"
          className="flex flex-col rounded-lg border border-border bg-background-surface p-5 shadow-sm transition-all duration-200 ease-premium hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-tint-primary text-action-primary">
            <Lightbulb className="h-4 w-4" />
          </span>
          <p className="mt-3 font-semibold text-text-primary">Request a feature</p>
          <p className="mt-1 text-caption text-text-muted">Share an idea to make us better.</p>
        </Link>
      </div>

      {/* FAQ */}
      <Card title="Frequently asked questions">
        <div className="space-y-6">
          {FAQ_SECTIONS.map((section) => (
            <div key={section.heading}>
              <h3 className="mb-1 text-caption font-semibold uppercase tracking-wide text-text-muted">
                {section.heading}
              </h3>
              <div className="divide-y divide-border">
                {section.items.map((f) => (
                  <details key={f.q} className="group py-3">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 font-medium text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                      {f.q}
                      <ChevronRight className="h-4 w-4 shrink-0 text-text-muted transition-transform group-open:rotate-90" />
                    </summary>
                    <p className="mt-2 text-[0.9375rem] text-text-secondary">{f.a}</p>
                  </details>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Contact section */}
      <Card
        title="Contact us"
        action={
          <span className="flex items-center gap-1.5 text-caption text-text-muted">
            <Mail className="h-4 w-4" />
            We usually reply within a day
          </span>
        }
      >
        <p className="mb-4 text-[0.9375rem] text-text-muted">
          Can’t find what you need above? Send us a message and we’ll get back to you.
        </p>
        <FeedbackForm
          kind="CONTACT"
          showSubject
          submitLabel="Send message"
          successMessage="Thanks — we’ll get back to you soon."
          messageLabel="How can we help?"
          messagePlaceholder="Describe your question or issue…"
        />
      </Card>

      {/* CSAT survey */}
      <Card
        title="How are we doing?"
        action={
          <span className="flex items-center gap-1.5 text-caption text-text-muted">
            <Star className="h-4 w-4" />
            Satisfaction survey
          </span>
        }
      >
        <p className="mb-4 text-[0.9375rem] text-text-muted">
          Rate your overall experience with ETicketsGo — your feedback shapes what we build next.
        </p>
        <FeedbackForm
          kind="CSAT"
          showRating
          submitLabel="Submit rating"
          successMessage="Thanks for rating your experience!"
          messageLabel="Anything you'd like to add? (optional)"
          messagePlaceholder="Tell us more about your experience…"
        />
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <RatingStars value={5} size="sm" label="ETicketsGo" />
            <p className="text-[0.9375rem] text-text-muted">
              Prefer to browse? Explore events and movies while you’re here.
            </p>
          </div>
          <div className="flex gap-2">
            <ButtonLink href="/events" variant="outline" size="sm">
              Browse events
            </ButtonLink>
            <ButtonLink href="/movies" variant="outline" size="sm">
              Browse movies
            </ButtonLink>
          </div>
        </div>
      </Card>
    </div>
  );
}
