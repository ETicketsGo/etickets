'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { isSignedIn } from '@/lib/auth-flag';
import { CitySuggestionBar } from '@eticketsgo/web-kit';
import { Header } from '@/components/header';
import { FeedbackWidget } from '@/components/feedback-widget';
import { BottomNav } from '@/components/bottom-nav';
import { InstallPrompt } from '@/components/install-prompt';
import { MarketingNav } from '@/components/marketing/nav';
import { MarketingFooter } from '@/components/marketing/footer';

// Public marketing routes get the full-bleed marketing shell; everything else keeps
// the existing app chrome (header + constrained main + feedback widget). Kept as a
// pathname switch so no existing app route had to move.
const MARKETING_EXACT = new Set([
  '/',
  '/features',
  '/pricing',
  '/organizers',
  '/customers',
  '/solutions',
  '/about',
  '/contact',
  '/faq',
  '/changelog',
  '/privacy',
  '/terms',
  '/refunds',
  '/organizer-agreement',
]);
const MARKETING_PREFIX = ['/docs', '/blog'];

function isMarketing(path: string): boolean {
  if (MARKETING_EXACT.has(path)) return true;
  // /organizers/[id] (a public organizer profile) stays in the app shell.
  return MARKETING_PREFIX.some((p) => path === p || path.startsWith(`${p}/`));
}

export function SiteChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // The home page (/) is adaptive: signed-in visitors see the app (discovery) there,
  // so it needs the app chrome; signed-out visitors get the marketing shell. Every
  // other marketing route always uses the marketing shell. Defaults to signed-out on
  // the server so crawlers + first paint get the marketing landing.
  const [authed, setAuthed] = useState(false);
  useEffect(() => setAuthed(isSignedIn()), [pathname]);

  const useMarketingShell = isMarketing(pathname) && !(pathname === '/' && authed);

  if (useMarketingShell) {
    return (
      <>
        <MarketingNav />
        <main id="main">{children}</main>
        <MarketingFooter />
      </>
    );
  }

  return (
    <>
      <Header />
      <CitySuggestionBar />
      {/* Bottom padding on mobile clears the fixed BottomNav (WS2). */}
      <main className="mx-auto max-w-6xl px-4 py-10 pb-24 sm:px-6 lg:pb-10">{children}</main>
      <footer className="mt-16 border-t border-border py-8 text-center text-caption text-text-muted">
        ETicketsGo — demo MVP. Mock payments only.
      </footer>
      <FeedbackWidget />
      <BottomNav />
      <InstallPrompt />
    </>
  );
}
