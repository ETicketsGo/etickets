'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from '@/i18n/navigation';
import { useQuery } from '@tanstack/react-query';
import { Bell, Search } from 'lucide-react';
import { api, tokenStore } from '@/lib/api';
import {
  BRAND_FOCUS,
  CityPicker,
  brandButtonClasses,
  useCity,
  useIsAuthenticated,
} from '@eticketsgo/web-kit';
import { AccountMenu } from '@/components/account-menu';
import { currentUserId } from '@/lib/offline/identity';
import { purgeUser } from '@/lib/offline/wallet-store';
import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { Wordmark } from '@/components/wordmark';
import { useSignInHref } from '@/lib/use-sign-in-href';

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
*/

const navLink = `inline-flex h-11 items-center rounded-brand-control px-3 text-brand-ui font-semibold transition-colors hover:text-brand-ink ${BRAND_FOCUS}`;

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
  // Subscribed, not read-once: Next keeps this layout mounted across client navigation.
  const live = useIsAuthenticated();
  /*
    The hint is used ONLY until this component has mounted, and the token decides for ever
    after: the server and the first client paint read the same prop, so hydration has nothing
    to reconcile, and a stale cookie is corrected rather than believed.
  */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const authed = mounted ? live : initialSignedIn;

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

  const logout = () => {
    // Shared-device safety: remove this user's cached wallet + QR payloads before clearing the
    // session, so nothing private survives logout on the device.
    const uid = currentUserId();
    if (uid) void purgeUser(uid);
    tokenStore.clear();
    router.push('/');
  };

  const t = useTranslations('common.nav');
  const a = useTranslations('common.action');
  const h = useTranslations('home.header');
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
          <Wordmark />
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
                className={`relative hidden h-11 w-11 items-center justify-center rounded-full text-brand-ink-2 transition-colors hover:text-brand-ink lg:inline-flex ${BRAND_FOCUS}`}
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
          ) : (
            /*
              Not below 360px: at 320 the wordmark, the city and this button do not fit one
              row, and a row of its own for "Sign in" pushed the search and the hero down. The
              bottom bar's Account tab leads to the same sign-in at that width.
            */
            <Link
              href={signInHref}
              className={`${brandButtonClasses('secondary', 'md')} max-[359px]:hidden`}
            >
              {a('signIn')}
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
