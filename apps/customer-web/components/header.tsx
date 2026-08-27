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
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
        <div className="flex items-center gap-1">
          <Link
            href="/"
            aria-label="ETicketsGo home"
            className="flex items-center gap-2 rounded-md font-bold tracking-tight text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-action-primary text-action-primary-foreground shadow-sm">
              <Ticket className="h-4 w-4" />
            </span>
            <span className="text-[1.05rem]">
              ETickets<span className="text-action-primary">Go</span>
            </span>
          </Link>
          {/*
            Beside the logo, not buried in a filter panel. Someone filtered to Delhi who
            cannot see that they are will report the Mumbai show as missing.
          */}
          <CityPicker />
        </div>
        <nav className="flex items-center gap-1.5 text-[0.9375rem] sm:gap-3">
          <Link href="/explore" aria-label={t('explore')} className={navLink}>
            <Sparkles className="h-4 w-4" />
            <span className="hidden sm:inline">{t('explore')}</span>
          </Link>
          <Link href="/events" aria-label={t('browse')} className={navLink}>
            <Compass className="h-4 w-4" />
            <span className="hidden sm:inline">{t('browse')}</span>
          </Link>
          <Link href="/movies" aria-label={t('movies')} className={navLink}>
            <Film className="h-4 w-4" />
            <span className="hidden sm:inline">{t('movies')}</span>
          </Link>
          <Link href="/help" aria-label={t('help')} className={navLink}>
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
              <ButtonLink href="/register" size="sm">
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
