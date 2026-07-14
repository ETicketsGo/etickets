'use client';

import Link from 'next/link';
import { ChevronLeft, Bug } from 'lucide-react';
import { Card } from '@/components/ui';
import { FeedbackForm } from '@/components/feedback-form';

export default function ReportBugPage() {
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
          <Bug className="h-6 w-6 text-status-error" />
          Report a bug
        </h1>
        <p className="mt-1 text-[0.9375rem] text-text-muted">
          Tell us what went wrong. We automatically include the page and browser details to help us
          reproduce it.
        </p>
      </div>
      <Card>
        <FeedbackForm
          kind="BUG"
          showSubject
          submitLabel="Submit bug report"
          successMessage="Thanks — your bug report has been logged."
          messageLabel="What happened?"
          messagePlaceholder="Describe the problem and the steps to reproduce it…"
        />
      </Card>
    </div>
  );
}
