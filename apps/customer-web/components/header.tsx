'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from '@/i18n/navigation';
import { useQuery } from '@tanstack/react-query';
import { Bell, Search } from 'lucide-react';
import { api } from '@/lib/api';
import {
  BRAND_FOCUS,
  CityPicker,
  Wordmark,
  brandButtonClasses,
  useCity,
} from '@eticketsgo/web-kit';
import { AccountMenu } from '@/components/account-menu';
import { useShellAuth, useSignOut } from '@/lib/use-shell-auth';
import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { useSignInHref } from '@/lib/use-sign-in-href';
import {
  PlatformLinks,
  PlatformMenu,
  PlatformMenuButton,
  VisitorActions,
} from '@/components/marketing/header';

/*
  ── THE STOREFRONT TOP BAR (docs/design/DESIGN-SYSTEM.md, section 5) ───────────────────
  Paper, a hairline, and four things: the wordmark, WHERE (the city button, always visible),
  WHAT (one wide search field), and three destinations. It replaced a bar of seven icon links,
  a language select and a register button, which at 1440 read as a toolbar and on a phone
  spent the first row on "English" while the city was cut to "United Sta...".

  - The city is a pill with words at every width. A buyer filtered to Delhi who cannot see
    that they are will report the Mumbai show as missing.
  - On a phone the search field takes its own full-width row under the bar, so the
    placeholder is readable instead of "Search events, a".
  - Language moved to the footer, where every page still has it (the French suite switches
    language from there). Bookings moved to the account menu; the bell stays on desktop; the
    bottom bar carries the rest on a phone.
  - No blur. The bar is opaque paper, which also keeps `position: fixed` inside it meaning the
    screen (see the portal comment in CityPicker).

  ── THE SIGNED-OUT SHOP (owner, 2026-10-18 "Combined"; 2026-10-19 every shop page) ─────────
  A visitor who is not signed in may be somebody buying a ticket or somebody deciding whether
  to sell with us. So for a visitor who is signed out this bar keeps every shop control (city,
  search, Explore, Movies, Tickets; the city bar and the bottom bar below) AND offers the
  platform pages (Features, Solutions, Pricing, For organizers, For attendees) with "Sign in"
  and "Get started", the same five links and buttons as the marketing header.
    - desktop: a slim second row under the shop bar, so the first row is exactly the shop's
      and nothing overflows at 1024;
    - phone: a menu button beside the city, opening the marketing header's own phone menu.
  It started on `/` alone (#435). The owner then found Explore signed out "unable to see other
  options", so it is now every shop page: Explore, Movies, Browse, an event, a film, an
  organizer's page and the rest.

  EXCEPT the purchase steps (`isPurchaseRoute`): the seat page, the booking and payment pages
  and checkout keep the plain shop bar with "Sign in". Somebody choosing seats or paying is
  not offered a tour of the platform.

  A signed-in customer gets the pure shop bar everywhere. Until the session is known nothing on
  the right is drawn, so a signed-in customer never sees "Sign in" or the platform links flash.
*/

const navLink = `inline-flex h-11 items-center rounded-brand-control px-3 text-brand-ui font-semibold transition-colors hover:text-brand-gold-text ${BRAND_FOCUS}`;

/** The three destinations. Help lives in the footer, beside the legal pages. */
const LINKS = [
  { href: '/explore', key: 'explore', match: (p: string) => p.startsWith('/explore') },
  { href: '/movies', key: 'movies', match: (p: string) => p.startsWith('/movies') },
  {
    href: '/account/tickets',
    key: 'tickets',
    match: (p: string) => p.startsWith('/account/tickets'),
  },
] as const;

/*
  Pages that ARE a search. Browse and Movies carry their own search box with filters beside it;
  a second box in the bar above would be two ways to ask one question, and the one in the page
  is the one that remembers the filters.
*/
function hasOwnSearch(path: string): boolean {
  return path === '/events' || path === '/movies';
}

/*
  The steps where somebody is choosing seats or paying: the seat page (`/shows/...`), every
  booking page (`/booking/...`, its payment step included - `isCheckoutRoute` in site-chrome)
  and checkout. These keep the plain shop bar with "Sign in" for a visitor.
*/
export function isPurchaseRoute(path: string): boolean {
  return /^\/(shows|booking|checkout)(\/|$)/.test(path);
}

export function Header({
  /*
    What the server believed, from the session-hint cookie.

    `useIsAuthenticated` reads the token, which lives in `localStorage` and therefore does not
    exist during a server render - its server snapshot is `false`, always. So a signed-in
    customer was served "Sign in" in the header of every page and watched it become their
    account menu a moment later.
  */
  initialSignedIn = false,
}: {
  initialSignedIn?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  // Back to this page after signing in, not to "My tickets" (lib/sign-in-return).
  const signInHref = useSignInHref();
  /*
    The hint is used ONLY until this component has mounted, and the token decides for ever
    after. The same hook drives the marketing header and footer, so every bar agrees.
  */
  const { authed, known } = useShellAuth(initialSignedIn);
  // Every shop page but the purchase steps offers a visitor the platform pages too.
  const combinedRoute = !isPurchaseRoute(pathname);
  // The combined bar: shop controls plus the platform pages, for a visitor only.
  const visitor = combinedRoute && known && !authed;
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [pathname, visitor]);

  const { data: unread } = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: () => api.notificationsUnreadCount(),
    enabled: authed,
    refetchInterval: 60_000,
  });
  const unreadCount = unread?.unreadCount ?? 0;

  const preference = useCity();
  const [q, setQ] = useState('');
  const search = (e: React.FormEvent) => {
    e.preventDefault();
    /*
      Carries the city through, so searching lands on Browse already scoped the way this bar
      says it is - rather than silently widening back out to everywhere.
    */
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (preference.city) params.set('city', preference.city);
    const query = params.toString();
    router.push(query ? `/events?${query}` : '/events');
  };

  // Clears this user's cached wallet before the session (lib/use-shell-auth).
  const logout = useSignOut();

  const t = useTranslations('common.nav');
  const a = useTranslations('common.action');
  const h = useTranslations('home.header');
  const m = useTranslations('common.marketing');
  const showSearch = !hasOwnSearch(pathname);

  return (
    <header
      data-brand="customer"
      className="sticky top-0 z-40 border-b border-brand-line bg-brand-canvas pt-[env(safe-area-inset-top)] font-brand-text text-brand-ink print:hidden"
    >
      {/*
        Wraps rather than overflows: on a phone the search row drops under the bar on purpose,
        and at 320px (WCAG 1.4.10) nothing is cut, because the only flexible thing in the first
        row is the city label, which truncates inside its own pill.
      */}
      <div className="mx-auto flex max-w-shell flex-wrap items-center gap-x-2 gap-y-2 px-4 py-2 sm:gap-x-3 sm:px-6 lg:h-[68px] lg:flex-nowrap lg:gap-x-6 lg:px-10 lg:py-0">
        <Link
          href="/"
          aria-label={h('homeLabel')}
          className={`inline-flex h-11 shrink-0 items-center rounded-brand-control ${BRAND_FOCUS}`}
        >
          <Wordmark size="md" tone="brand" />
        </Link>

        <CityPicker
          allCitiesLabel={t('allCities')}
          className="ml-auto min-w-0 lg:ml-0"
          triggerClassName={`inline-flex h-11 max-w-full items-center gap-1.5 rounded-full border border-brand-line-strong bg-brand-surface px-3 text-brand-ui font-semibold text-brand-ink transition-colors hover:border-brand-ink-3 lg:h-10 ${BRAND_FOCUS}`}
        />

        {showSearch && (
          <form
            onSubmit={search}
            role="search"
            className="order-last w-full lg:order-none lg:w-auto lg:max-w-[560px] lg:flex-1"
          >
            <div className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-brand-ink-3"
              />
              <input
                type="search"
                aria-label={h('searchLabel')}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={h('searchPlaceholder')}
                className="h-11 w-full rounded-brand-control border border-brand-field bg-brand-surface pl-10 pr-3 text-brand-ui text-brand-ink placeholder:text-brand-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-focus focus-visible:ring-offset-2 focus-visible:ring-offset-brand-canvas"
              />
              {/*
                No submit button: a form with one text field submits on Enter by itself
                (HTML implicit submission). A visually hidden one was a 1x1 px control, which
                fails the 24px target rule (WCAG 2.5.8) the phone suite enforces.
              */}
            </div>
          </form>
        )}

        <nav aria-label={h('mainNav')} className="hidden items-center gap-1 lg:ml-auto lg:flex">
          {LINKS.map((l) => {
            const active = l.match(pathname);
            return (
              <Link
                key={l.href}
                href={
                  authed || !l.href.startsWith('/account')
                    ? l.href
                    : `/login?next=${encodeURIComponent(l.href)}`
                }
                aria-current={active ? 'page' : undefined}
                className={`${navLink} ${
                  active
                    ? 'text-brand-ink underline decoration-2 underline-offset-[10px]'
                    : 'text-brand-ink-2'
                }`}
              >
                {t(l.key)}
              </Link>
            );
          })}
        </nav>

        <div className="flex shrink-0 items-center gap-1">
          {authed ? (
            <>
              {/*
                Desktop only: the bottom bar carries account things on a phone, and two bells on
                one screen was a reported bug ("we are duplicating the icons").
              */}
              <Link
                href="/account/notifications"
                aria-label={
                  unreadCount > 0
                    ? h('notificationsUnread', { count: unreadCount })
                    : h('notifications')
                }
                title={h('notifications')}
                className={`relative hidden h-11 w-11 items-center justify-center rounded-full text-brand-ink-2 transition-colors hover:text-brand-gold-text lg:inline-flex ${BRAND_FOCUS}`}
              >
                <Bell className="h-5 w-5" aria-hidden />
                {unreadCount > 0 && (
                  <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-marigold px-1 text-[0.625rem] font-semibold tabular-nums text-brand-on-marigold">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
              </Link>
              {/*
                Identity, not just an exit: which account this is matters most on a shared
                device and right before paying.
              */}
              <AccountMenu onSignOut={logout} />
            </>
          ) : combinedRoute && !known ? (
            // The answer is not known yet: hold the space, draw nothing.
            <span aria-hidden data-auth="pending" className="inline-block h-11 w-11" />
          ) : (
            <>
              {/*
                Not below 360px: at 320 the wordmark, the city and this button do not fit one
                row, and a row of its own for "Sign in" pushed the search and the hero down. The
                bottom bar's Account tab leads to the same sign-in at that width.

                On a signed-out shop page "Sign in" sits beside "Get started" instead: in the
                second row on a desktop, in the menu on a phone (a phone bar with the wordmark,
                the city, "Sign in" and a menu button does not fit one row at 390).
              */}
              {!visitor && (
                <Link
                  href={signInHref}
                  className={`${brandButtonClasses('secondary', 'md')} max-[359px]:hidden`}
                >
                  {a('signIn')}
                </Link>
              )}
              {visitor && (
                <PlatformMenuButton
                  open={menuOpen}
                  controls="shop-platform-menu"
                  onToggle={() => setMenuOpen((o) => !o)}
                />
              )}
            </>
          )}
        </div>
      </div>

      {visitor && (
        <div data-nav-row="platform" className="hidden border-t border-brand-line lg:block">
          <div className="mx-auto flex h-[52px] max-w-shell items-center gap-x-6 px-10">
            <nav aria-label={m('navLabel')} className="-ml-3 flex items-center gap-1">
              <PlatformLinks pathname={pathname} />
            </nav>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <VisitorActions signInHref={signInHref} />
            </div>
          </div>
        </div>
      )}
      {visitor && menuOpen && (
        <PlatformMenu
          id="shop-platform-menu"
          pathname={pathname}
          actions={<VisitorActions signInHref={signInHref} wide />}
        />
      )}
    </header>
  );
}
