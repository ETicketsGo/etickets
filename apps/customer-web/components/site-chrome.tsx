'use client';

import { usePathname } from '@/i18n/navigation';
import { useEffect, useState } from 'react';
import { isSignedIn } from '@/lib/auth-flag';
import { CitySuggestionBar } from '@eticketsgo/web-kit';
import { Header } from '@/components/header';
import { FeedbackWidget } from '@/components/feedback-widget';
import { BottomNav } from '@/components/bottom-nav';
import { InstallPrompt } from '@/components/install-prompt';
import { MarketingNav } from '@/components/marketing/nav';
import { MarketingFooter } from '@/components/marketing/footer';
import { SiteFooter } from '@/components/site-footer';
import { useTranslations } from 'next-intl';

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

/**
 * A page whose entire job is to become paper.
 *
 * ── WHY THE SHELL IS REMOVED RATHER THAN HIDDEN ────────────────────────────────────
 * The first version fought the chrome with print CSS: hide everything, un-hide the sheet,
 * pull it out of flow with `position: absolute` so the hidden header did not leave a blank
 * page above it. That works for exactly one page. `visibility: hidden` still occupies space,
 * and absolutely positioned content is taken out of the flow the printer paginates — so a
 * two-ticket booking printed the first ticket and silently lost the rest.
 *
 * Not rendering the header and footer at all leaves the sheet in normal flow, where page
 * breaks work the way the browser already knows how to do them. Nothing to fight.
 */
function isPrintRoute(path: string): boolean {
  return path.endsWith('/print') || path.includes('/print/');
}

export function SiteChrome({ children }: { children: React.ReactNode }) {
  const f = useTranslations('common.footer');
  const pathname = usePathname();
  // The home page (/) is adaptive: signed-in visitors see the app (discovery) there,
  // so it needs the app chrome; signed-out visitors get the marketing shell. Every
  // other marketing route always uses the marketing shell. Defaults to signed-out on
  // the server so crawlers + first paint get the marketing landing.
  const [authed, setAuthed] = useState(false);
  useEffect(() => setAuthed(isSignedIn()), [pathname]);

  const useMarketingShell = isMarketing(pathname) && !(pathname === '/' && authed);

  // No header, no footer, no city bar — just the sheet.
  if (isPrintRoute(pathname)) return <main id="main">{children}</main>;

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
    /*
      A column at least as tall as the window. Without it, `mt-auto` on the footer has
      nothing to push against and a listing with two results leaves the footer floating in
      the middle of the screen with grey below it.
    */
    <div className="flex min-h-screen flex-col">
      <Header />
      <CitySuggestionBar />
      {/* Bottom padding on mobile clears the fixed BottomNav (WS2). */}
      <main className="mx-auto w-full max-w-shell flex-1 px-4 py-10 pb-24 sm:px-6 lg:px-8 lg:pb-10">
        {children}
      </main>
      {/*
        The notice is shown where it is TRUE. `NEXT_PUBLIC_APP_ENV` is unset in production,
        so nothing appears there; QA and UAT set it and testers keep being told the payments
        are simulated. The old footer said so unconditionally, which would have been a lie
        on the first real sale.
      */}
      <SiteFooter
        environmentNotice={
          (process.env.NEXT_PUBLIC_APP_ENV ?? '').toUpperCase() === 'PRODUCTION' ||
          !process.env.NEXT_PUBLIC_APP_ENV
            ? null
            : f('testEnvironment')
        }
      />
      <FeedbackWidget />
      <BottomNav />
      <InstallPrompt />
    </div>
  );
}
