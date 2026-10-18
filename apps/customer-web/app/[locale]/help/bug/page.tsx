'use client';

import { ChevronLeft, Bug } from 'lucide-react';
import { Panel } from '@/components/marketing/blocks';
import { BRAND_WRAP, BrandPage } from '@/components/storefront-brand';
import { FeedbackForm } from '@/components/feedback-form';
import { Link } from '@/i18n/navigation';

export default function ReportBugPage() {
  return (
    <BrandPage>
      <div className={`${BRAND_WRAP} pt-8 lg:pt-14`}>
        <div className="mx-auto max-w-xl space-y-5">
          <Link
            href="/help"
            className="inline-flex min-h-11 items-center gap-1 rounded-sm text-brand-meta font-medium text-brand-ink-2 transition-colors hover:text-brand-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-focus focus-visible:ring-offset-2 focus-visible:ring-offset-brand-canvas"
          >
            <ChevronLeft aria-hidden className="h-4 w-4" />
            Back to help center
          </Link>
          <div>
            <h1 className="flex items-center gap-2 font-brand-display text-brand-d2 text-brand-ink">
              <Bug className="h-6 w-6 text-brand-critical" />
              Report a bug
            </h1>
            <p className="mt-3 text-brand-ui text-brand-ink-2">
              Tell us what went wrong. We automatically include the page and browser details to help
              us reproduce it.
            </p>
          </div>
          <Panel>
            <FeedbackForm
              kind="BUG"
              showSubject
              submitLabel="Submit bug report"
              successMessage="Thanks — your bug report has been logged."
              messageLabel="What happened?"
              messagePlaceholder="Describe the problem and the steps to reproduce it…"
            />
          </Panel>
        </div>
      </div>
    </BrandPage>
  );
}
