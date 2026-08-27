'use client';

import { usePathname } from '@/i18n/navigation';
import { useEffect, useState } from 'react';
import { Ticket, Menu, X } from 'lucide-react';
import { isSignedIn } from '@/lib/auth-flag';
import { Link } from '@/i18n/navigation';
import { LanguageSwitcher } from '@/components/language-switcher';
import { useTranslations } from 'next-intl';

const LINKS = [
  { href: '/features', label: 'features' },
  { href: '/solutions', label: 'solutions' },
  { href: '/pricing', label: 'pricing' },
  { href: '/organizers', label: 'forOrganizers' },
  { href: '/customers', label: 'forAttendees' },
  { href: '/docs', label: 'docs' },
];

export function MarketingNav() {
  const m = useTranslations('common.marketing');
  const a = useTranslations('storefront.auth');
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // The logo always goes to the home page (/). Only the right-hand actions adapt to
  // auth so a signed-in visitor sees a way into the app instead of "Sign in".
  const [authed, setAuthed] = useState(false);
  useEffect(() => setAuthed(isSignedIn()), [pathname]);

  // Close the mobile menu whenever the route changes.
  useEffect(() => setOpen(false), [pathname]);

  return (
    <header className="sticky top-0 z-50 border-b border-border/70 bg-background-canvas/80 backdrop-blur-lg">
      <nav
        className="mx-auto flex max-w-7xl items-center justify-between px-5 py-3.5 sm:px-8"
        aria-label="Primary"
      >
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

        {/* Desktop links */}
        <div className="hidden items-center gap-1 lg:flex">
          {LINKS.map((l) => {
            const active = pathname === l.href;
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`rounded-lg px-3 py-2 text-[0.9375rem] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                  active
                    ? 'text-text-primary'
                    : 'text-text-secondary hover:bg-background-subtle hover:text-text-primary'
                }`}
              >
                {m(l.label)}
              </Link>
            );
          })}
        </div>

        {/* Desktop actions */}
        <div className="hidden items-center gap-2 lg:flex">
          {authed ? (
            <>
              <Link
                href="/events"
                className="rounded-lg px-3 py-2 text-[0.9375rem] font-medium text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {m('browseEvents')}
              </Link>
              <Link
                href="/"
                className="inline-flex items-center rounded-xl bg-action-primary px-4 py-2 text-[0.9375rem] font-semibold text-action-primary-foreground shadow-sm transition-all hover:bg-action-primary-hover hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas"
              >
                {m('goToApp')}
              </Link>
            </>
          ) : (
            <>
              <Link
                href="/login"
                className="rounded-lg px-3 py-2 text-[0.9375rem] font-medium text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {a('signIn')}
              </Link>
              <Link
                href="/register"
                className="inline-flex items-center rounded-xl bg-action-primary px-4 py-2 text-[0.9375rem] font-semibold text-action-primary-foreground shadow-sm transition-all hover:bg-action-primary-hover hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas"
              >
                {m('getStarted')}
              </Link>
            </>
          )}
          {/*
            The marketing nav needs the switcher as much as the app header does — more, in
            fact: the home page is where most people arrive, and somebody who cannot read it
            has no other way to find French.
          */}
          <LanguageSwitcher className="ml-1 hidden sm:inline-flex" />
        </div>

        {/* Mobile toggle */}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls="marketing-mobile-menu"
          aria-label={open ? 'Close menu' : 'Open menu'}
          className="rounded-lg p-2 text-text-secondary hover:bg-background-subtle hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 lg:hidden"
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </nav>

      {/* Mobile menu */}
      {open && (
        <div
          id="marketing-mobile-menu"
          className="border-t border-border bg-background-canvas lg:hidden"
        >
          <div className="space-y-1 px-5 py-4">
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="block rounded-lg px-3 py-2.5 text-[0.9375rem] font-medium text-text-secondary hover:bg-background-subtle hover:text-text-primary"
              >
                {m(l.label)}
              </Link>
            ))}
            <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-4">
              {authed ? (
                <>
                  <Link
                    href="/events"
                    className="rounded-xl border border-border bg-background-surface px-4 py-2.5 text-center text-[0.9375rem] font-semibold text-text-primary"
                  >
                    {m('browseEvents')}
                  </Link>
                  <Link
                    href="/"
                    className="rounded-xl bg-action-primary px-4 py-2.5 text-center text-[0.9375rem] font-semibold text-action-primary-foreground"
                  >
                    {m('goToApp')}
                  </Link>
                </>
              ) : (
                <>
                  <Link
                    href="/login"
                    className="rounded-xl border border-border bg-background-surface px-4 py-2.5 text-center text-[0.9375rem] font-semibold text-text-primary"
                  >
                    {a('signIn')}
                  </Link>
                  <Link
                    href="/register"
                    className="rounded-xl bg-action-primary px-4 py-2.5 text-center text-[0.9375rem] font-semibold text-action-primary-foreground"
                  >
                    {m('getStarted')}
                  </Link>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
