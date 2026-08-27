'use client';

import { ChevronLeft, Lightbulb } from 'lucide-react';
import { Card } from '@/components/ui';
import { FeedbackForm } from '@/components/feedback-form';
import { Link } from '@/i18n/navigation';

export default function FeatureRequestPage() {
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
          <Lightbulb className="h-6 w-6 text-action-primary" />
          Request a feature
        </h1>
        <p className="mt-1 text-[0.9375rem] text-text-muted">
          Have an idea that would make ETicketsGo better? We’d love to hear it.
        </p>
      </div>
      <Card>
        <FeedbackForm
          kind="FEATURE"
          showSubject
          submitLabel="Submit idea"
          successMessage="Thanks — your idea has been shared with the team."
          messageLabel="Your idea"
          messagePlaceholder="Describe the feature and how it would help you…"
        />
      </Card>
    </div>
  );
}
