'use client';

import { usePathname } from '@/i18n/navigation';
import { useEffect, useState } from 'react';
import { backfillSessionHint, isSignedIn } from '@/lib/auth-flag';
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

/**
 * The step where somebody is about to pay.
 *
 * ── WHY THIS ROUTE IS SINGLED OUT ──────────────────────────────────────────────────
 * Measured on a phone: the Review & pay screen was about 1900px tall, and a little under half
 * of it was the site footer - three columns of links whose whole purpose is to send the reader
 * somewhere else. A buyer who has entered their details and is looking for the Pay button
 * instead scrolls past "Browse events" and "Movies". The footer's own comment already makes the
 * argument: "a footer that repeats a sales menu under a checkout is noise at the exact moment
 * attention matters most" - it was written about the marketing footer and is just as true here.
 *
 * Only the columns go, and only on a phone. Help, the terms, the privacy notice and the refund
 * policy stay, in one line: somebody deciding whether to pay is exactly who needs the refund
 * policy to hand, and hiding it at the till would be the wrong kind of tidy.
 */
function isCheckoutRoute(path: string): boolean {
  return /\/booking\/[^/]+\/payment$/.test(path);
}

export function SiteChrome({
  children,
  /*
    What the SERVER believed when it drew this, from the session-hint cookie.

    The state starts here instead of at `false`, so the first paint already matches the person
    looking at it. The effect below still runs and still wins - the hint can be stale, and
    localStorage is the truth - but being right to begin with is what removes the flash.
  */
  initialSignedIn = false,
}: {
  children: React.ReactNode;
  initialSignedIn?: boolean;
}) {
  const f = useTranslations('common.footer');
  const pathname = usePathname();
  // The home page (/) is adaptive: signed-in visitors see the app (discovery) there,
  // so it needs the app chrome; signed-out visitors get the marketing shell. Every
  // other marketing route always uses the marketing shell. Defaults to signed-out on
  // the server so crawlers + first paint get the marketing landing.
  const [authed, setAuthed] = useState(initialSignedIn);
  useEffect(() => {
    setAuthed(isSignedIn());
    // Repairs a session that predates the cookie; only ever writes the true direction.
    backfillSessionHint();
  }, [pathname]);

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
      <Header initialSignedIn={initialSignedIn} />
      <CitySuggestionBar />
      {/* Bottom padding on mobile clears the fixed BottomNav (WS2). */}
      {/* 40px top and bottom is a desktop rhythm; a phone gets 24 and keeps the rest. */}
      <main className="mx-auto w-full max-w-shell flex-1 px-4 py-6 pb-24 sm:px-6 sm:py-10 lg:px-8 lg:pb-10">
        {children}
      </main>
      {/*
        The notice is shown where it is TRUE. `NEXT_PUBLIC_APP_ENV` is unset in production,
        so nothing appears there; QA and UAT set it and testers keep being told the payments
        are simulated. The old footer said so unconditionally, which would have been a lie
        on the first real sale.
      */}
      {/*
        The footer clears the bottom bar too.

        `main` reserved room for it and the footer did not, so on every screen the last line of
        the footer sat underneath the fixed navigation - measured on the device, the bar covered
        the environment notice and the feedback button entirely. A fixed bar has to be paid for
        by everything in the column, not by the one element that remembered.
      */}
      <div className="pb-[calc(3.5rem+env(safe-area-inset-bottom))] lg:pb-0">
        <SiteFooter
          compact={isCheckoutRoute(pathname)}
          environmentNotice={
            (process.env.NEXT_PUBLIC_APP_ENV ?? '').toUpperCase() === 'PRODUCTION' ||
            !process.env.NEXT_PUBLIC_APP_ENV
              ? null
              : f('testEnvironment')
          }
        />
      </div>
      <FeedbackWidget />
      <BottomNav />
      <InstallPrompt />
    </div>
  );
}
