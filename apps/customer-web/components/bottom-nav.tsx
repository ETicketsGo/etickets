'use client';

import { usePathname } from '@/i18n/navigation';
import { useEffect, useState } from 'react';
import { Home, Compass, Ticket, Bell, User } from 'lucide-react';
import { tokenStore } from '@/lib/api';
import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';

/*
  `label` is a CATALOGUE KEY, not a string.

  The bottom bar is the whole navigation on a phone, so an English label here leaves a French
  reader with an English product however well the page above it is translated.
*/
type Item = { href: string; label: string; icon: typeof Home; match: (p: string) => boolean };

const ITEMS: Item[] = [
  { href: '/', label: 'home', icon: Home, match: (p) => p === '/' },
  { href: '/events', label: 'browse', icon: Compass, match: (p) => p.startsWith('/events') },
  {
    href: '/account/tickets',
    label: 'tickets',
    icon: Ticket,
    match: (p) => p.startsWith('/account/tickets'),
  },
  {
    href: '/account/notifications',
    label: 'alerts',
    icon: Bell,
    match: (p) => p.startsWith('/account/notifications'),
  },
  {
    href: '/account/bookings',
    label: 'account',
    icon: User,
    match: (p) =>
      p.startsWith('/account') &&
      !p.startsWith('/account/tickets') &&
      !p.startsWith('/account/notifications'),
  },
];

/**
 * The navigation, on a phone.
 *
 * ── WHY IT IS THERE BEFORE YOU SIGN IN ─────────────────────────────────────────────
 * It used to render only for signed-in visitors. Installed to a home screen and opened, the
 * app therefore had no tabs at all until you signed in - a page with a header, which is a
 * website. The bar is how an app is navigated, and it is the first thing that says this is
 * one, so it is there from the first launch.
 *
 * Signed out, the destinations still work: Home and Browse are public, and Tickets, Alerts
 * and Account lead to sign-in with a `next` that returns you to the tab you picked. That is
 * a better answer than hiding them, which leaves somebody looking for their tickets with
 * nothing on screen that mentions tickets.
 *
 * Fixed to the bottom with safe-area padding so it clears the gesture bar in the installed
 * app - which only reports a real inset now that the viewport opts into covering it.
 */
export function BottomNav() {
  const t = useTranslations('common.nav');
  const pathname = usePathname();
  const [authed, setAuthed] = useState(false);
  useEffect(() => setAuthed(!!tokenStore.access), []);
  /*
    Not while choosing seats. That screen has its own bar at the bottom — the seats, the amount
    and the pay button — and a navigation bar under it would put five ways to leave the booking
    beneath the one thing the buyer came to press.
  */
  if (pathname.startsWith('/shows/')) return null;

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden print:hidden"
    >
      <ul className="mx-auto flex max-w-lg items-stretch justify-around">
        {ITEMS.map((item) => {
          const active = item.match(pathname);
          const Icon = item.icon;
          return (
            <li key={item.href} className="flex-1">
              <Link
                /*
                  Signed out, the account tabs go to sign-in and come BACK here. Sending
                  somebody to a bare login screen and dropping the tab they asked for is how a
                  sign-in turns into "where was I going again".
                */
                href={
                  authed || !item.href.startsWith('/account')
                    ? item.href
                    : `/login?next=${encodeURIComponent(item.href)}`
                }
                aria-current={active ? 'page' : undefined}
                className={`flex min-h-[3.25rem] flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-[0.6875rem] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                  active ? 'text-action-primary' : 'text-text-muted hover:text-text-primary'
                }`}
              >
                <Icon className="h-5 w-5" aria-hidden />
                {t(item.label)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
