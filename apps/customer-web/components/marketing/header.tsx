'use client';

import { useEffect, useState } from 'react';
import { Menu, X } from 'lucide-react';
import { BRAND_FOCUS, brandButtonClasses } from '@eticketsgo/web-kit';
import { Link, usePathname } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { AccountMenu } from '@/components/account-menu';
import { Wordmark } from '@/components/wordmark';
import { useShellAuth, useSignOut } from '@/lib/use-shell-auth';
import { useSignInHref } from '@/lib/use-sign-in-href';

/*
  ── THE MARKETING HEADER (N1) ────────────────────────────────────────────────────────────
  The public platform pages (Features, Pricing, For organizers, the legal pages) are read by
  somebody deciding whether to USE ETicketsGo, so their bar offers the platform pages. The ticket
  shop's bar (city, search, Explore, Movies, Tickets) is for somebody buying a ticket. PR #427 put
  the shop's bar on every page, which took the platform links away from a visitor reading the
  pitch; the owner asked for one visual design with two navigations.

  So this is drawn exactly like the storefront `Header` - paper, a hairline, the wordmark, the
  brand button and the same account menu - and only the destinations differ.

  The right-hand side follows the REAL session, read from the same hook as the storefront bar
  (`useShellAuth`), so the two can never disagree. Signed in: "Go to app" and the account menu,
  never "Sign in". Signed out: "Sign in" (back to this page) and "Get started". While the answer
  is not known yet, a blank space of the same size: showing "Sign in" to somebody who is signed
  in reads as being signed out.
*/

/**
 * The five platform destinations, in order. One list: the storefront header offers the same five
 * to a signed-out visitor on the home page (N2), and draws them from here.
 */
export const PLATFORM_LINKS = [
  { href: '/features', key: 'features' },
  { href: '/solutions', key: 'solutions' },
  { href: '/pricing', key: 'pricing' },
  { href: '/organizers', key: 'forOrganizers' },
  { href: '/customers', key: 'forAttendees' },
] as const;

const navLink = `inline-flex h-11 items-center rounded-brand-control px-3 text-brand-ui font-semibold transition-colors hover:text-brand-gold-text ${BRAND_FOCUS}`;

/** The platform links as a row of bar links, for a desktop bar. */
export function PlatformLinks({ pathname }: { pathname: string }) {
  const m = useTranslations('common.marketing');
  return (
    <>
      {PLATFORM_LINKS.map((l) => {
        const active = pathname === l.href;
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? 'page' : undefined}
            className={`${navLink} ${
              active
                ? 'text-brand-ink underline decoration-2 underline-offset-[10px]'
                : 'text-brand-ink-2'
            }`}
          >
            {m(l.key)}
          </Link>
        );
      })}
    </>
  );
}

/**
 * The phone menu: the platform links in a column, then the bar's actions. Shared by the marketing
 * header and the storefront header's signed-out home page, so the two phone menus are one menu.
 */
export function PlatformMenu({
  id,
  pathname,
  actions,
}: {
  id: string;
  pathname: string;
  actions: React.ReactNode;
}) {
  const m = useTranslations('common.marketing');
  return (
    <div id={id} className="border-t border-brand-line bg-brand-canvas lg:hidden">
      <nav aria-label={m('navLabel')} className="mx-auto max-w-shell px-4 py-3 sm:px-6">
        <ul>
          {PLATFORM_LINKS.map((l) => (
            <li key={l.href}>
              <Link
                href={l.href}
                aria-current={pathname === l.href ? 'page' : undefined}
                className={`${navLink} w-full ${
                  pathname === l.href ? 'text-brand-ink' : 'text-brand-ink-2'
                }`}
              >
                {m(l.key)}
              </Link>
            </li>
          ))}
        </ul>
        <div className="mt-3 grid grid-cols-2 gap-2 border-t border-brand-line pt-4">{actions}</div>
      </nav>
    </div>
  );
}

/**
 * "Sign in" (back to this page) and "Get started" for a signed-out visitor.
 *
 * "Get started" asks for an ORGANIZER account: it sits beside the platform pages, which pitch
 * selling tickets, and the customer form says "This is a customer account for buying tickets" to
 * somebody who came to sell them.
 */
export function VisitorActions({
  signInHref,
  wide = false,
}: {
  signInHref: string;
  wide?: boolean;
}) {
  const m = useTranslations('common.marketing');
  const a = useTranslations('common.action');
  const width = wide ? 'w-full' : '';
  return (
    <>
      <Link href={signInHref} className={`${brandButtonClasses('secondary', 'md')} ${width}`}>
        {a('signIn')}
      </Link>
      <Link
        href="/register?intent=organizer"
        className={`${brandButtonClasses('primary', 'md')} ${width}`}
      >
        {m('getStarted')}
      </Link>
    </>
  );
}

/** The menu button that opens `PlatformMenu`; phone widths only. */
export function PlatformMenuButton({
  open,
  controls,
  onToggle,
}: {
  open: boolean;
  controls: string;
  onToggle: () => void;
}) {
  const a11y = useTranslations('common.a11y');
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
      aria-label={open ? a11y('closeMenu') : a11y('openMenu')}
      className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-brand-control text-brand-ink-2 transition-colors hover:text-brand-gold-text lg:hidden ${BRAND_FOCUS}`}
    >
      {open ? <X className="h-5 w-5" aria-hidden /> : <Menu className="h-5 w-5" aria-hidden />}
    </button>
  );
}

export function MarketingHeader({ initialSignedIn = false }: { initialSignedIn?: boolean }) {
  const m = useTranslations('common.marketing');
  const h = useTranslations('home.header');
  const pathname = usePathname();
  const signInHref = useSignInHref();
  const { authed, known } = useShellAuth(initialSignedIn);
  const signOut = useSignOut();
  const [open, setOpen] = useState(false);

  // Close the phone menu whenever the route changes.
  useEffect(() => setOpen(false), [pathname]);

  const actions = (layout: 'bar' | 'menu') => {
    const width = layout === 'menu' ? 'w-full' : '';
    if (!known) {
      return <span aria-hidden data-auth="pending" className="inline-block h-11 w-24" />;
    }
    if (authed) {
      return (
        <Link
          href="/"
          data-testid="marketing-go-to-app"
          className={`${brandButtonClasses('primary', 'md')} ${width} col-span-2`}
        >
          {m('goToApp')}
        </Link>
      );
    }
    return <VisitorActions signInHref={signInHref} wide={layout === 'menu'} />;
  };

  return (
    <header
      data-brand="customer"
      data-nav="marketing"
      className="sticky top-0 z-40 border-b border-brand-line bg-brand-canvas pt-[env(safe-area-inset-top)] font-brand-text text-brand-ink print:hidden"
    >
      <div className="mx-auto flex max-w-shell items-center gap-x-2 px-4 py-2 sm:gap-x-3 sm:px-6 lg:h-[68px] lg:gap-x-6 lg:px-10 lg:py-0">
        <Link
          href="/"
          aria-label={h('homeLabel')}
          className={`inline-flex h-11 shrink-0 items-center rounded-brand-control ${BRAND_FOCUS}`}
        >
          <Wordmark />
        </Link>

        <nav aria-label={m('navLabel')} className="hidden items-center gap-1 lg:flex">
          <PlatformLinks pathname={pathname} />
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <div className="hidden items-center gap-2 lg:flex">{actions('bar')}</div>
          {/* The account menu is in the bar at every width: who you are is not a menu item. */}
          {known && authed && <AccountMenu onSignOut={signOut} />}
          <PlatformMenuButton
            open={open}
            controls="marketing-menu"
            onToggle={() => setOpen((o) => !o)}
          />
        </div>
      </div>

      {open && <PlatformMenu id="marketing-menu" pathname={pathname} actions={actions('menu')} />}
    </header>
  );
}
