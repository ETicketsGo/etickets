'use client';

import { usePathname } from '@/i18n/navigation';
import { useEffect, useState } from 'react';
import { Home, Compass, Ticket, User } from 'lucide-react';
import { BRAND_FOCUS } from '@eticketsgo/web-kit';
import { tokenStore } from '@/lib/api';
import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';

/*
  `label` is a CATALOGUE KEY, not a string.

  The bottom bar is the whole navigation on a phone, so an English label here leaves a French
  reader with an English product however well the page above it is translated.
*/
type Item = { href: string; label: string; icon: typeof Home; match: (p: string) => boolean };

/*
  Four places, not five (docs/design/DESIGN-SYSTEM.md, section 5). Alerts left the bar: the
  notification list is one tap inside Account, and a fifth tab made every label smaller on the
  320px screen where they matter most. "Browse" became Explore; Browse is still where the search
  field and every "See all" link land.
*/
const ITEMS: Item[] = [
  { href: '/', label: 'home', icon: Home, match: (p) => p === '/' },
  { href: '/explore', label: 'explore', icon: Compass, match: (p) => p.startsWith('/explore') },
  {
    href: '/account/tickets',
    label: 'tickets',
    icon: Ticket,
    match: (p) => p.startsWith('/account/tickets'),
  },
  {
    href: '/account/bookings',
    label: 'account',
    icon: User,
    match: (p) => p.startsWith('/account') && !p.startsWith('/account/tickets'),
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
  const h = useTranslations('home.bottomNav');
  const pathname = usePathname();
  const [authed, setAuthed] = useState(false);
  /*
    Re-checked on every navigation, not once on mount.

    The dependency array was empty, so this bar learned whether the visitor was signed in when
    it first rendered and never asked again. Signing in is a client-side navigation - the bar
    is never unmounted - so after a real sign-in it still believed the visitor was a stranger
    and sent Tickets, Alerts and Account to the login screen. Reported from the installed app
    as "I have signed in, and when I click on account it is still showing sign in".

    `pathname` is the right trigger because every way of becoming signed in ends in a
    navigation, and it is what `SiteChrome` two components away has always used - the two were
    answering the same question with different answers.
  */
  useEffect(() => setAuthed(!!tokenStore.access), [pathname]);
  /*
    Out of the way while somebody is typing. With the on-screen keyboard up, a fixed bar sits
    on top of it and takes 56px of the little room left - measured at 320x508 with the search
    focused, the bar covered most of what was left below the field. It comes back on blur.
  */
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const isField = (t: EventTarget | null) =>
      t instanceof HTMLElement &&
      (t.tagName === 'TEXTAREA' ||
        t.isContentEditable ||
        (t.tagName === 'INPUT' &&
          !['button', 'checkbox', 'radio', 'submit', 'reset', 'range'].includes(
            (t as HTMLInputElement).type,
          )));
    const on = (e: FocusEvent) => setTyping(isField(e.target));
    const off = () => setTyping(false);
    document.addEventListener('focusin', on);
    document.addEventListener('focusout', off);
    return () => {
      document.removeEventListener('focusin', on);
      document.removeEventListener('focusout', off);
    };
  }, []);
  /*
    Not while choosing seats. That screen has its own bar at the bottom — the seats, the amount
    and the pay button — and a navigation bar under it would put five ways to leave the booking
    beneath the one thing the buyer came to press.
  */
  if (pathname.startsWith('/shows/') || typing) return null;

  return (
    <nav
      data-brand="customer"
      aria-label={h('label')}
      className="fixed inset-x-0 bottom-0 z-40 border-t border-brand-line bg-brand-canvas pb-[env(safe-area-inset-bottom)] font-brand-text lg:hidden print:hidden"
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
                /*
                  The current tab is told by weight and a marigold dot, never by colour alone:
                  ink stays ink, so it reads in greyscale and in bright sun.
                */
                className={`relative flex h-14 flex-col items-center justify-center gap-0.5 px-1 text-[0.75rem] leading-none transition-colors ${BRAND_FOCUS} ${
                  active
                    ? 'font-semibold text-brand-ink'
                    : 'font-medium text-brand-ink-3 hover:text-brand-gold-text'
                }`}
              >
                <Icon className="h-5 w-5" strokeWidth={active ? 2.4 : 1.8} aria-hidden />
                {t(item.label)}
                {active && (
                  <span
                    aria-hidden
                    className="absolute top-1.5 h-1.5 w-1.5 translate-x-3 rounded-full bg-brand-marigold"
                  />
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
