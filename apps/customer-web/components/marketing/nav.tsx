'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Ticket, Menu, X } from 'lucide-react';
import { tokenStore } from '@/lib/api';

const LINKS = [
  { href: '/features', label: 'Features' },
  { href: '/solutions', label: 'Solutions' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/organizers', label: 'For organizers' },
  { href: '/customers', label: 'For attendees' },
  { href: '/docs', label: 'Docs' },
];

export function MarketingNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // The logo + actions adapt to auth so the marketing header behaves like the app
  // header: a signed-in visitor's logo goes to their app home, not the marketing home.
  const [authed, setAuthed] = useState(false);
  useEffect(() => setAuthed(!!tokenStore.access), [pathname]);

  // Close the mobile menu whenever the route changes.
  useEffect(() => setOpen(false), [pathname]);

  const homeHref = authed ? '/discover' : '/';

  return (
    <header className="sticky top-0 z-50 border-b border-border/70 bg-background-canvas/80 backdrop-blur-lg">
      <nav
        className="mx-auto flex max-w-7xl items-center justify-between px-5 py-3.5 sm:px-8"
        aria-label="Primary"
      >
        <Link
          href={homeHref}
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
                {l.label}
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
                Browse events
              </Link>
              <Link
                href="/discover"
                className="inline-flex items-center rounded-xl bg-action-primary px-4 py-2 text-[0.9375rem] font-semibold text-action-primary-foreground shadow-sm transition-all hover:bg-action-primary-hover hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas"
              >
                Go to app
              </Link>
            </>
          ) : (
            <>
              <Link
                href="/login"
                className="rounded-lg px-3 py-2 text-[0.9375rem] font-medium text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                Sign in
              </Link>
              <Link
                href="/register"
                className="inline-flex items-center rounded-xl bg-action-primary px-4 py-2 text-[0.9375rem] font-semibold text-action-primary-foreground shadow-sm transition-all hover:bg-action-primary-hover hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas"
              >
                Get started
              </Link>
            </>
          )}
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
                {l.label}
              </Link>
            ))}
            <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-4">
              {authed ? (
                <>
                  <Link
                    href="/events"
                    className="rounded-xl border border-border bg-background-surface px-4 py-2.5 text-center text-[0.9375rem] font-semibold text-text-primary"
                  >
                    Browse events
                  </Link>
                  <Link
                    href="/discover"
                    className="rounded-xl bg-action-primary px-4 py-2.5 text-center text-[0.9375rem] font-semibold text-action-primary-foreground"
                  >
                    Go to app
                  </Link>
                </>
              ) : (
                <>
                  <Link
                    href="/login"
                    className="rounded-xl border border-border bg-background-surface px-4 py-2.5 text-center text-[0.9375rem] font-semibold text-text-primary"
                  >
                    Sign in
                  </Link>
                  <Link
                    href="/register"
                    className="rounded-xl bg-action-primary px-4 py-2.5 text-center text-[0.9375rem] font-semibold text-action-primary-foreground"
                  >
                    Get started
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
