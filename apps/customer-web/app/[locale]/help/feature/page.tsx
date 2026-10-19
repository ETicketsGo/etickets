'use client';

import { ChevronLeft, Lightbulb } from 'lucide-react';
import { Panel } from '@/components/marketing/blocks';
import { BRAND_WRAP, BrandPage } from '@/components/storefront-brand';
import { FeedbackForm } from '@/components/feedback-form';
import { Link } from '@/i18n/navigation';

export default function FeatureRequestPage() {
  return (
    <BrandPage>
      <div className={`${BRAND_WRAP} pt-8 lg:pt-14`}>
        <div className="mx-auto max-w-xl space-y-5">
          <Link
            href="/help"
            className="inline-flex min-h-11 items-center gap-1 rounded-sm text-brand-meta font-medium text-brand-ink-2 transition-colors hover:text-brand-gold-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-focus focus-visible:ring-offset-2 focus-visible:ring-offset-brand-canvas"
          >
            <ChevronLeft aria-hidden className="h-4 w-4" />
            Back to help center
          </Link>
          <div>
            <h1 className="flex items-center gap-2 font-brand-display text-brand-d2 text-brand-ink">
              <Lightbulb className="h-6 w-6 text-brand-ink" />
              Request a feature
            </h1>
            <p className="mt-3 text-brand-ui text-brand-ink-2">
              Have an idea that would make ETicketsGo better? We would love to hear it.
            </p>
          </div>
          <Panel>
            <FeedbackForm
              kind="FEATURE"
              showSubject
              submitLabel="Submit idea"
              successMessage="Thanks - your idea has been shared with the team."
              messageLabel="Your idea"
              messagePlaceholder="Describe the feature and how it would help you..."
            />
          </Panel>
        </div>
      </div>
    </BrandPage>
  );
}
