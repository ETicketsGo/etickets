'use client';

import Link from 'next/link';
import { ChevronLeft, Mail } from 'lucide-react';
import { Card } from '@/components/ui';
import { FeedbackForm } from '@/components/feedback-form';

export default function ContactPage() {
  return (
    <div className="mx-auto max-w-xl space-y-5">
      <Link
        href="/help"
        className="inline-flex items-center gap-1 text-caption text-text-muted transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <ChevronLeft className="h-4 w-4" />
        Back to help center
      </Link>
      <div>
        <h1 className="flex items-center gap-2 text-h2 font-bold tracking-tight text-text-primary">
          <Mail className="h-6 w-6 text-action-primary" />
          Contact us
        </h1>
        <p className="mt-1 text-[0.9375rem] text-text-muted">
          Send us a message and our support team will reply by email.
        </p>
      </div>
      <Card>
        <FeedbackForm
          kind="CONTACT"
          showSubject
          submitLabel="Send message"
          successMessage="Thanks — we’ll get back to you soon."
          messageLabel="How can we help?"
          messagePlaceholder="Describe your question or issue…"
        />
      </Card>
    </div>
  );
}
