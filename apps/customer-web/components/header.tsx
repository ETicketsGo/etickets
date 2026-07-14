'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Ticket, Compass, LogOut, Receipt, Film, Sparkles, LifeBuoy } from 'lucide-react';
import { tokenStore } from '@/lib/api';
import { ButtonLink } from '@/components/ui';

const navLink =
  'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-text-secondary transition-colors hover:bg-background-subtle hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas';

export function Header() {
  const router = useRouter();
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    setAuthed(!!tokenStore.access);
  }, []);

  const logout = () => {
    tokenStore.clear();
    setAuthed(false);
    router.push('/');
  };

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background-surface/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
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
        <nav className="flex items-center gap-1.5 text-[0.9375rem] sm:gap-3">
          <Link href="/explore" aria-label="Explore" className={navLink}>
            <Sparkles className="h-4 w-4" />
            <span className="hidden sm:inline">Explore</span>
          </Link>
          <Link href="/events" aria-label="Browse events" className={navLink}>
            <Compass className="h-4 w-4" />
            <span className="hidden sm:inline">Browse</span>
          </Link>
          <Link href="/movies" aria-label="Browse movies" className={navLink}>
            <Film className="h-4 w-4" />
            <span className="hidden sm:inline">Movies</span>
          </Link>
          <Link href="/help" aria-label="Help center" className={navLink}>
            <LifeBuoy className="h-4 w-4" />
            <span className="hidden sm:inline">Help</span>
          </Link>
          {authed ? (
            <>
              <Link href="/account/bookings" aria-label="My bookings" className={navLink}>
                <Receipt className="h-4 w-4" />
                <span className="hidden sm:inline">Bookings</span>
              </Link>
              <Link href="/account/tickets" aria-label="My tickets" className={navLink}>
                <Ticket className="h-4 w-4" />
                <span className="hidden sm:inline">Tickets</span>
              </Link>
              <button onClick={logout} aria-label="Sign out" className={navLink}>
                <LogOut className="h-4 w-4" />
                <span className="hidden sm:inline">Sign out</span>
              </button>
            </>
          ) : (
            <>
              <Link
                href="/login"
                className="rounded-md px-3 py-1.5 text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas"
              >
                Sign in
              </Link>
              <ButtonLink href="/register" size="sm">
                Sign up
              </ButtonLink>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
