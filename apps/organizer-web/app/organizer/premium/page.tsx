'use client';

import { Lock, Sparkles } from 'lucide-react';
import { ENTERPRISE_FEATURES, isFeatureEnabled } from '@eticketsgo/shared-types';
import { Badge, Card, PageHeader } from '@eticketsgo/web-kit';

export default function PremiumPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Premium & enterprise"
        description="Advanced capabilities for scaling organizers. These are enabled per-account via feature flags — talk to us to turn them on."
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {ENTERPRISE_FEATURES.map((f) => {
          const enabled = isFeatureEnabled(f.flag);
          return (
            <Card key={f.flag}>
              <div className="flex items-start justify-between gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-action-primary/10 text-action-primary">
                  <Sparkles className="h-5 w-5" />
                </span>
                <Badge tone={enabled ? 'success' : 'neutral'}>
                  {enabled ? 'Enabled' : 'Coming soon'}
                </Badge>
              </div>
              <p className="mt-4 font-semibold text-text-primary">{f.title}</p>
              <p className="mt-1 text-[0.9375rem] text-text-muted">{f.description}</p>
              <button
                disabled
                className="mt-4 flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-caption font-medium text-text-muted"
              >
                <Lock className="h-3.5 w-3.5" />
                {enabled ? 'Available' : 'Request access'}
              </button>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
