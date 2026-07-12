'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Ticket, Compass, LogOut } from 'lucide-react';
import { tokenStore } from '@/lib/api';

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
          className="flex items-center gap-2 font-bold tracking-tight text-text-primary"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-action-primary text-action-primary-foreground shadow-sm">
            <Ticket className="h-4 w-4" />
          </span>
          <span className="text-[1.05rem]">
            ETickets<span className="text-action-primary">Go</span>
          </span>
        </Link>
        <nav className="flex items-center gap-1.5 text-[0.9375rem] sm:gap-3">
          <Link
            href="/events"
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-text-secondary transition-colors hover:bg-background-subtle hover:text-text-primary"
          >
            <Compass className="h-4 w-4" />
            <span className="hidden sm:inline">Browse</span>
          </Link>
          {authed ? (
            <>
              <Link
                href="/account/tickets"
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-text-secondary transition-colors hover:bg-background-subtle hover:text-text-primary"
              >
                <Ticket className="h-4 w-4" />
                <span className="hidden sm:inline">My tickets</span>
              </Link>
              <button
                onClick={logout}
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-text-secondary transition-colors hover:bg-background-subtle hover:text-text-primary"
              >
                <LogOut className="h-4 w-4" />
                <span className="hidden sm:inline">Sign out</span>
              </button>
            </>
          ) : (
            <>
              <Link
                href="/login"
                className="rounded-md px-3 py-1.5 text-text-secondary transition-colors hover:text-text-primary"
              >
                Sign in
              </Link>
              <Link
                href="/register"
                className="rounded-md bg-action-primary px-4 py-2 font-semibold text-action-primary-foreground shadow-sm transition-all duration-200 hover:bg-action-primary-hover hover:shadow-md active:scale-[0.98]"
              >
                Sign up
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
