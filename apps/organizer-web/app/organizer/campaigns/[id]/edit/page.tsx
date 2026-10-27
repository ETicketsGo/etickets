'use client';

import { Suspense } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { Skeleton } from '@eticketsgo/web-kit';
import { CampaignBuilder } from '@/components/campaigns/campaign-builder';

function Edit() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const step = Math.min(4, Math.max(0, Number(search.get('step') ?? '0') || 0));
  return <CampaignBuilder key={params.id} campaignId={params.id} initialStep={step} />;
}

// useSearchParams() requires a Suspense boundary during static generation.
export default function EditCampaignPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <Edit />
    </Suspense>
  );
}
