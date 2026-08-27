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
 * Mobile bottom navigation (v1.4 WS2). Shown only on small screens for signed-in
 * users; desktop keeps the top header. Fixed to the bottom with safe-area padding
 * so it clears the iOS home indicator in the installed PWA.
 */
export function BottomNav() {
  const t = useTranslations('common.nav');
  const pathname = usePathname();
  const [authed, setAuthed] = useState(false);
  useEffect(() => setAuthed(!!tokenStore.access), []);
  if (!authed) return null;

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden"
    >
      <ul className="mx-auto flex max-w-lg items-stretch justify-around">
        {ITEMS.map((item) => {
          const active = item.match(pathname);
          const Icon = item.icon;
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
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
