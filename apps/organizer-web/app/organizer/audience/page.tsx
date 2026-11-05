'use client';

import { useQuery } from '@tanstack/react-query';
import { api, PageHeader } from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import { AudienceBody } from '@/components/audience-overview';
import { isForbidden } from '@/lib/org-permissions';

/**
 * Audience & growth: who follows this organizer, as COUNTS.
 *
 * ── NO NAMES, BY DESIGN ────────────────────────────────────────────────────────────
 * A follow is a customer's choice to see an organizer. It is not permission for the
 * organizer to know who they are, so this page never lists a person. The API returns
 * aggregates only, and hides any city with fewer than five followers.
 *
 * ── NO FAKE NUMBERS ────────────────────────────────────────────────────────────────
 * Every figure comes from the summary endpoint. While it loads the page shows placeholders,
 * and if it fails the page says so. It never shows a zero it did not receive.
 *
 * Campaigns and deeper analytics are later work. They get a link here when they exist.
 */
export default function AudiencePage() {
  const { activeOrg } = useOrg();
  const summary = useQuery({
    queryKey: ['audience-summary', activeOrg.id],
    queryFn: () => api.audience.summary(activeOrg.id),
    retry: (count, error) => !isForbidden(error) && count < 2,
  });

  return (
    <div>
      <PageHeader
        title="Audience & growth"
        description="The people who follow you, as counts. We never show you who they are."
      />
      <AudienceBody
        state={summary.isLoading ? 'loading' : summary.isError ? 'error' : 'ready'}
        data={summary.data}
        forbidden={isForbidden(summary.error)}
        onRetry={() => summary.refetch()}
      />
    </div>
  );
}
