'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { LogOut, Receipt, Store, Ticket, User } from 'lucide-react';
import { initialsOf, useAuthUser } from '@eticketsgo/web-kit';

/**
 * Who you are signed in as, and what you can do about it.
 *
 * The right-hand corner used to hold a single "Sign out" button. Signed-in customers had no
 * way to see which account they were on — which matters most on a shared device and right
 * before paying — and no route to their own profile from the header.
 *
 * "Become an organizer" lives here because this is where somebody realises they want it. It
 * was previously reachable only from marketing copy on the signed-out landing page, so an
 * existing customer had nowhere to start.
 */
const item =
  'flex w-full items-center gap-2.5 px-3 py-2 text-left text-[0.9375rem] text-text-secondary transition-colors hover:bg-background-subtle hover:text-text-primary focus-visible:bg-background-subtle focus-visible:text-text-primary focus-visible:outline-none';

export function AccountMenu({ onSignOut }: { onSignOut: () => void }) {
  const { user } = useAuthUser();
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  // Close on outside click and on Escape. Escape also returns focus to the trigger, so a
  // keyboard user is not dropped at the top of the document.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (wrapper.current && !wrapper.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const name = user?.fullName?.trim();
  const label = name || user?.email || 'Account';

  return (
    <div className="relative" ref={wrapper}>
      <button
        ref={button}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Account menu for ${label}`}
        data-testid="account-menu-trigger"
        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-text-secondary transition-colors hover:bg-background-subtle hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas"
      >
        <span
          aria-hidden
          className="flex h-7 w-7 items-center justify-center rounded-full bg-action-primary text-[0.6875rem] font-semibold text-action-primary-foreground"
        >
          {initialsOf(user?.fullName, user?.email)}
        </span>
        <span className="hidden max-w-[10rem] truncate sm:inline">{label}</span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Account"
          data-testid="account-menu"
          className="absolute right-0 z-50 mt-2 w-64 overflow-hidden rounded-lg border border-border bg-background-surface py-1 shadow-lg"
        >
          {/* Identity first: on a shared device the question is "who am I signed in as". */}
          <div className="border-b border-border px-3 py-2.5">
            <p className="truncate text-[0.9375rem] font-medium text-text-primary">
              {name || 'Your account'}
            </p>
            {user?.email ? (
              <p className="truncate text-caption text-text-muted">{user.email}</p>
            ) : null}
          </div>

          <Link
            href="/account/profile"
            role="menuitem"
            className={item}
            onClick={() => setOpen(false)}
          >
            <User className="h-4 w-4" />
            Profile
          </Link>
          <Link
            href="/account/bookings"
            role="menuitem"
            className={item}
            onClick={() => setOpen(false)}
          >
            <Receipt className="h-4 w-4" />
            My bookings
          </Link>
          <Link
            href="/account/tickets"
            role="menuitem"
            className={item}
            onClick={() => setOpen(false)}
          >
            <Ticket className="h-4 w-4" />
            My tickets
          </Link>

          <div className="my-1 border-t border-border" />
          <Link
            href="/account/become-organizer"
            role="menuitem"
            data-testid="become-organizer"
            className={item}
            onClick={() => setOpen(false)}
          >
            <Store className="h-4 w-4" />
            <span>
              Become an organizer
              <span className="block text-caption text-text-muted">Sell your own tickets</span>
            </span>
          </Link>

          <div className="my-1 border-t border-border" />
          <button type="button" role="menuitem" className={item} onClick={onSignOut}>
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
