'use client';

import { usePathname } from '@/i18n/navigation';
import { useEffect } from 'react';
import { backfillSessionHint } from '@/lib/auth-flag';
import { CitySuggestionBar } from '@eticketsgo/web-kit';
import { Header } from '@/components/header';
import { BottomNav } from '@/components/bottom-nav';
import { InstallPrompt } from '@/components/install-prompt';
import { MarketingFooter } from '@/components/marketing/footer';
import { MarketingHeader } from '@/components/marketing/header';
import { useShellAuth } from '@/lib/use-shell-auth';
import { SiteFooter } from '@/components/site-footer';
import { useTranslations } from 'next-intl';
import { isTestEnvironment } from '@/lib/build-id';

/*
  The public marketing and legal routes: ONE visual design, TWO navigations (owner, N1).

  They used to get a shell of their own in the old blue system, so a visitor who clicked "Terms"
  in the home page's footer walked into a second product. PR #427 fixed the look by giving them
  the storefront header - and with it the ticket shop's navigation (city, search, Explore,
  Movies, Tickets, the bottom bar), which took Features, Pricing and the rest away from somebody
  reading the pitch.

  Now both audiences get the same paper bar, wordmark, type and stage-band footer, and only the
  destinations differ:
    - these routes: `MarketingHeader` (Features, Solutions, Pricing, For organizers, For
      attendees; Sign in / Get started, or Go to app and the account menu when signed in) and
      `MarketingFooter`. No city bar and no bottom bar: those are the shop's navigation.
    - the home page: the marketing shell for an anonymous visitor, the app chrome once signed in.
    - every other route: the storefront `Header`, the city bar, the bottom bar and `SiteFooter`.
  Both headers and the footer read the session from one hook (`useShellAuth`).
*/
const MARKETING_EXACT = new Set([
  /*
    `/` is not in this list because its shell depends on WHO is looking (see `marketing`
    below): an anonymous visitor gets the marketing navigation (owner, 2026-10-18: "Public
    visitor: Should see Features, Solutions, Pricing, For Organizers, For Attendees, and Sign
    in"); a signed-in customer gets the ticket shop's navigation.
  */
  '/sell',
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
  '/sms',
  '/cookies',
  '/legal',
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
  /**
    The short commit of the running server; null in local development. Drawn in the footer
    only on a test environment - see `isTestEnvironment`.
  */
  buildId = null,
}: {
  children: React.ReactNode;
  initialSignedIn?: boolean;
  buildId?: string | null;
}) {
  const f = useTranslations('common.footer');
  const pathname = usePathname();
  // Marketing routes get the marketing shell; everything else - including `/`, which is now
  // the ticket shop - gets the app chrome. The signed-in flag still drives the header's own
  // account affordances; it no longer decides which SHELL the home page gets.
  useEffect(() => {
    // Repairs a session that predates the cookie; only ever writes the true direction.
    // The shell no longer depends on the answer, but `Header` still reads the same flag.
    backfillSessionHint();
  }, [pathname]);

  const { authed } = useShellAuth(initialSignedIn);
  /*
    The home page is the one route whose navigation follows the audience, not the path: the
    public front door for a visitor, the ticket shop for a signed-in customer. Read from the
    same hook as both headers and the footer, so the four can never disagree.
  */
  const marketing = isMarketing(pathname) || (pathname === '/' && !authed);
  /*
    One answer for both footers and both environment markers. The literal
    `process.env.NEXT_PUBLIC_APP_ENV` is what Next inlines; read through a variable it would
    be undefined in the browser and every environment would look like production.
  */
  const testEnvironment = isTestEnvironment(process.env.NEXT_PUBLIC_APP_ENV);
  const footerBuildId = testEnvironment ? buildId : null;

  // No header, no footer, no city bar — just the sheet.
  if (isPrintRoute(pathname)) return <main id="main">{children}</main>;

  const environmentNotice = testEnvironment ? f('testEnvironment') : null;

  return (
    /*
      A column at least as tall as the window. Without it, `mt-auto` on the footer has
      nothing to push against and a listing with two results leaves the footer floating in
      the middle of the screen with grey below it.
    */
    <div className="flex min-h-screen flex-col">
      {marketing ? (
        <MarketingHeader initialSignedIn={initialSignedIn} />
      ) : (
        <>
          <Header initialSignedIn={initialSignedIn} />
          <CitySuggestionBar />
        </>
      )}
      {/* Bottom padding on mobile clears the fixed BottomNav (WS2). */}
      {/* 40px top and bottom is a desktop rhythm; a phone gets 24 and keeps the rest. */}
      {/*
        `id="main"` is what "Skip to content" jumps to.

        The marketing shell and the print sheet both had it; the app shell did not, so the skip
        link pointed at nothing on every in-app page and a keyboard user tabbed through the
        whole header to reach the content. axe reports it as `skip-link`. Found when the home
        page moved into this shell - the front door is the page where it matters most.
      */}
      {/*
        The home page draws edge to edge: its hero and its "Now showing" band are stage-tone
        bands the full width of the window (DESIGN-SYSTEM.md section 1), so it sets its own
        gutters inside. Every other page keeps the column it was laid out in.
      */}
      <main
        id="main"
        className={
          pathname === '/'
            ? 'w-full flex-1'
            : 'mx-auto w-full max-w-shell flex-1 px-4 py-6 pb-24 sm:px-6 sm:py-10 lg:px-8 lg:pb-10'
        }
      >
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
      <div className={marketing ? '' : 'pb-[calc(3.5rem+env(safe-area-inset-bottom))] lg:pb-0'}>
        {marketing ? (
          <MarketingFooter
            buildId={footerBuildId}
            environmentNotice={environmentNotice}
            initialSignedIn={initialSignedIn}
          />
        ) : (
          <SiteFooter
            buildId={footerBuildId}
            compact={isCheckoutRoute(pathname)}
            environmentNotice={environmentNotice}
          />
        )}
      </div>
      {!marketing && <BottomNav />}
      <InstallPrompt />
    </div>
  );
}
