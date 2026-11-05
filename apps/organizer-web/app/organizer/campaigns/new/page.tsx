'use client';

import { CampaignBuilder } from '@/components/campaigns/campaign-builder';

/** A new campaign: the Setup step creates the draft, then the builder continues on its page. */
export default function NewCampaignPage() {
  return <CampaignBuilder />;
}
