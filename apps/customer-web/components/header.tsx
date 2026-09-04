'use client';

import { useRouter } from '@/i18n/navigation';
import { useQuery } from '@tanstack/react-query';
import { Ticket, Compass, Receipt, Film, Sparkles, LifeBuoy, Bell } from 'lucide-react';
import { api, tokenStore } from '@/lib/api';
import { CityPicker, useIsAuthenticated } from '@eticketsgo/web-kit';
import { ButtonLink } from '@/components/ui';
import { AccountMenu } from '@/components/account-menu';
import { currentUserId } from '@/lib/offline/identity';
import { purgeUser } from '@/lib/offline/wallet-store';
import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { LanguageSwitcher } from '@/components/language-switcher';
import { Logo } from '@eticketsgo/web-kit';

const navLink =
  'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-text-secondary transition-colors hover:bg-background-subtle hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas';

export function Header() {
  const router = useRouter();
  // Subscribed, not read-once. The previous `useEffect(..., [])` ran only on mount, and
  // Next.js keeps this layout mounted across client-side navigation — so signing in never
  // updated the header and signed-in users kept seeing "Sign in / Sign up".
  const authed = useIsAuthenticated();

  const { data: unread } = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: () => api.notificationsUnreadCount(),
    enabled: authed,
    refetchInterval: 60_000,
  });
  const unreadCount = unread?.unreadCount ?? 0;

  const logout = () => {
    // Shared-device safety: remove this user's cached wallet + QR payloads before
    // clearing the session, so nothing private survives logout on the device.
    const uid = currentUserId();
    if (uid) void purgeUser(uid);
    tokenStore.clear();
    router.push('/');
  };

  const t = useTranslations('common.nav');
  const a = useTranslations('common.action');

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background-surface/80 pt-[env(safe-area-inset-top)] backdrop-blur-md">
      {/*
        Wraps rather than overflows.

        The caps below trim the widest items, but trimming is a losing game: the next
        translation that runs longer than its English source puts the bar over again, and
        WCAG 1.4.10 is measured at 320px where there is nothing spare. Allowing a second row
        makes the header correct at any width for any string length, which is what the
        criterion is actually asking for — content that reflows instead of content that has
        been made to fit one case.
      */}
      <div /*
          Wrapping stops at `lg`, not `sm`.

          It stopped at `sm` (640px), and the header's contents need about 940px — so from
          640 to 1023 the bar overflowed and dragged the WHOLE PAGE into horizontal
          scrolling. Every storefront page, on every tablet held in portrait, scrolled
          sideways. Measured at 768: 942px of content in a 768px window, identical before
          this change, so it was not new — just never looked at, because a laptop is 1280
          and a phone wraps.
        */
        className="mx-auto flex max-w-shell flex-wrap items-center justify-between gap-y-2 px-4 py-3 sm:px-6 lg:flex-nowrap lg:px-8"
      >
        <div className="flex items-center gap-1">
          <Link
            href="/"
            aria-label="ETicketsGo home"
            className="flex items-center gap-2 rounded-md font-bold tracking-tight text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas"
          >
            {/* The wordmark still hides on a phone — the mark alone identifies the brand
                and the space belongs to the city picker beside it. */}
            <Logo markClassName="h-8 w-8" className="hidden sm:inline-flex" id="hdr" />
            <Logo markClassName="h-8 w-8" showWordmark={false} className="sm:hidden" id="hdr-sm" />
          </Link>
          {/*
            Beside the logo, not buried in a filter panel. Someone filtered to Delhi who
            cannot see that they are will report the Mumbai show as missing.
          */}
          <CityPicker allCitiesLabel={t('allCities')} />
        </div>
        {/*
          The icon links are hidden until `lg` because `BottomNav` already carries them,
          and `BottomNav` is `lg:hidden` — so every width below `lg` was showing BOTH. They
          were `sm:flex`, so from 640px to 1023px the same four destinations appeared twice
          on screen and the duplicate pushed the header to 707px inside a 640px window,
          scrolling every storefront page sideways. The reasoning below was right all along;
          the breakpoint simply did not match the bar it was deferring to.

          At 320px — the width WCAG 1.4.10 measures at, a 1280px page zoomed to 400% — this
          nav was 434px wide inside a 320px viewport, so the page had to be scrolled in two
          directions to read. Four duplicated destinations were the bulk of it.

          What stays on a small screen is what the bottom bar does NOT provide: signing in,
          creating an account, the account menu, and the language switcher — which has to
          stay reachable precisely because the person who needs it cannot read the page.
        */}
        <nav className="flex items-center gap-1.5 text-[0.9375rem] sm:gap-3">
          <Link href="/explore" aria-label={t('explore')} className={`hidden lg:flex ${navLink}`}>
            <Sparkles className="h-4 w-4" />
            <span className="hidden sm:inline">{t('explore')}</span>
          </Link>
          <Link href="/events" aria-label={t('browse')} className={`hidden lg:flex ${navLink}`}>
            <Compass className="h-4 w-4" />
            <span className="hidden sm:inline">{t('browse')}</span>
          </Link>
          <Link href="/movies" aria-label={t('movies')} className={`hidden lg:flex ${navLink}`}>
            <Film className="h-4 w-4" />
            <span className="hidden sm:inline">{t('movies')}</span>
          </Link>
          <Link href="/help" aria-label={t('help')} className={`hidden lg:flex ${navLink}`}>
            <LifeBuoy className="h-4 w-4" />
            <span className="hidden sm:inline">{t('help')}</span>
          </Link>
          {authed ? (
            <>
              <Link href="/account/bookings" aria-label={t('bookings')} className={navLink}>
                <Receipt className="h-4 w-4" />
                <span className="hidden sm:inline">{t('bookings')}</span>
              </Link>
              <Link href="/account/tickets" aria-label={t('tickets')} className={navLink}>
                <Ticket className="h-4 w-4" />
                <span className="hidden sm:inline">{t('tickets')}</span>
              </Link>
              <Link
                href="/account/notifications"
                aria-label={
                  unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'
                }
                className={`relative ${navLink}`}
              >
                <Bell className="h-4 w-4" />
                <span className="hidden sm:inline">{t('alerts')}</span>
                {unreadCount > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-action-primary px-1 text-[0.625rem] font-semibold text-action-primary-foreground">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
              </Link>
              {/*
                Identity, not just an exit. The corner used to hold a bare "Sign out", so a
                signed-in customer could not tell which account they were on — and had no
                route to their profile or to becoming an organizer.
              */}
              <AccountMenu onSignOut={logout} />
            </>
          ) : (
            <>
              <Link
                href="/login"
                className="rounded-md px-3 py-1.5 text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas"
              >
                {a('signIn')}
              </Link>
              <ButtonLink href="/register" size="sm" className="hidden sm:inline-flex">
                {a('register')}
              </ButtonLink>
            </>
          )}
          {/*
            In the header, on every page, for everyone — not only after signing in.

            Somebody who cannot read the page cannot be asked to find a setting in an account
            they have not created yet. This is the control that makes the French half of the
            product reachable at all.
          */}
          <LanguageSwitcher className="ml-1" />
        </nav>
      </div>
    </header>
  );
}
