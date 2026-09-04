'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { isSignedIn } from '@/lib/auth-flag';
import { MarketingLanding } from '@/components/marketing/landing';

// Load the signed-in discovery experience on demand so the marketing landing (the
// SEO/conversion page most / visitors see) keeps a light first-load bundle.
const DiscoverHome = dynamic(
  () => import('@/components/discover-home').then((m) => m.DiscoverHome),
  {
    ssr: false,
    loading: () => (
      <div className="mx-auto max-w-shell px-4 py-10 sm:px-6 lg:px-8">
        <div className="h-72 animate-pulse rounded-lg border border-border bg-background-subtle" />
      </div>
    ),
  },
);

/**
 * The single home page. Signed-out visitors get the marketing landing (server-rendered
 * for SEO by default); signed-in visitors get the in-app discovery experience — so there
 * is one home URL (/) with one hero per user. SiteChrome swaps to the app header for the
 * signed-in case using the same token check, so both stay in sync.
 */
export function HomeGate() {
  const [authed, setAuthed] = useState(false);
  useEffect(() => setAuthed(isSignedIn()), []);
  return authed ? <DiscoverHome /> : <MarketingLanding />;
}
