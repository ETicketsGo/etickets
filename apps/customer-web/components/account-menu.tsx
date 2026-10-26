'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bell, BellRing, ExternalLink, LogOut, Receipt, Store, Ticket, User } from 'lucide-react';
import {
  accountContact,
  accountInitials,
  accountName,
  api,
  useAuthUser,
} from '@eticketsgo/web-kit';
import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';

import { ORGANIZER_LOGIN_URL, openOrganizerConsole } from '@/lib/organizer-console';

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
 *
 * Once they HAVE an organization the invitation is replaced rather than left standing. An
 * offer to do something already done reads as a failure — the first version of this menu kept
 * showing "Become an organizer" to people who had just become one, so they clicked it again
 * expecting it to have not worked. What they actually want at that point is the way back in.
 */
/*
  Brand tokens (DESIGN-SYSTEM.md): the menu opens inside the storefront header, which carries
  `data-brand="customer"`, so these resolve to paper, ink and the one overlay shadow.
*/
const item =
  'flex min-h-11 w-full items-center gap-2.5 px-3 py-2 text-left text-brand-ui text-brand-ink-2 transition-colors hover:bg-brand-sunken hover:text-brand-gold-text focus-visible:bg-brand-sunken focus-visible:text-brand-ink focus-visible:outline-none';

export function AccountMenu({ onSignOut }: { onSignOut: () => void }) {
  const t = useTranslations('common.nav');
  const a = useTranslations('common.a11y');
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

  /*
    Name, else email, else the person's own phone number. A phone-only account used to be shown
    by the placeholder address the database keeps for it, and given the initials "PH".
  */
  const name = accountName(user);
  const contact = accountContact(user);
  const initials = accountInitials(user);
  const label = name || t('account');

  /*
    Fetched only while the menu is open, and never retried.

    This is a nicety, not a permission: if the request fails or is slow the menu still works
    and simply shows the invitation, which is the pre-existing behaviour. Making a header
    dropdown depend on a network round-trip to render at all would be a poor trade.
  */
  const orgsQ = useQuery({
    queryKey: ['organizations', 'mine'],
    queryFn: () => api.organizations.listMine(),
    enabled: open && Boolean(user),
    retry: false,
    staleTime: 60_000,
  });
  const organization = orgsQ.data?.[0];

  return (
    <div className="relative" ref={wrapper}>
      <button
        ref={button}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={a('accountMenuFor', { name: label })}
        data-testid="account-menu-trigger"
        className="flex h-11 items-center gap-2 rounded-brand-control px-1.5 text-brand-ui font-semibold text-brand-ink-2 transition-colors hover:text-brand-gold-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-focus focus-visible:ring-offset-2 focus-visible:ring-offset-brand-canvas"
      >
        <span
          aria-hidden
          className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-action text-[0.75rem] font-semibold text-brand-on-action"
        >
          {initials ?? <User className="h-4 w-4" />}
        </span>
        <span className="hidden max-w-[10rem] truncate xl:inline">{label}</span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label={t('account')}
          data-testid="account-menu"
          className="absolute right-0 z-50 mt-2 w-64 overflow-hidden rounded-brand-card border border-brand-line bg-brand-surface py-1 font-brand-text shadow-brand-overlay"
        >
          {/* Identity first: on a shared device the question is "who am I signed in as". */}
          <div className="border-b border-brand-line px-3 py-2.5">
            <p className="truncate text-brand-ui font-semibold text-brand-ink">
              {name || 'Your account'}
            </p>
            {contact ? (
              <p className="truncate text-brand-meta text-brand-ink-3">{contact}</p>
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
          {/*
            The inbox. It was a tab of its own in the phone's bottom bar, which now carries four
            places (DESIGN-SYSTEM.md section 5), so this is where a phone reaches it; on a wide
            screen the bell in the header leads to the same page.
          */}
          <Link
            href="/account/notifications"
            role="menuitem"
            className={item}
            onClick={() => setOpen(false)}
          >
            <Bell className="h-4 w-4" />
            {t('alerts')}
          </Link>
          {/*
            Distinct from "Notifications", which is the inbox. This is where somebody decides
            what arrives and where — including whether we may use WhatsApp for their booking
            updates, which is a question they can otherwise never be asked.
          */}
          <Link
            href="/account/notification-settings"
            role="menuitem"
            className={item}
            onClick={() => setOpen(false)}
          >
            <BellRing className="h-4 w-4" />
            Notification settings
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

          <div className="my-1 border-t border-brand-line" />
          {organization ? (
            /*
              A different origin with its own session. It used to land on the console's sign-in
              page, which asked a phone-registered organizer for an email and password they never
              had. Now it carries THIS session across with a one-time code (see
              lib/organizer-console.ts) - never a token in the URL. The href is the console's
              sign-in, for a middle-click or a browser without script.
            */
            <a
              href={ORGANIZER_LOGIN_URL}
              role="menuitem"
              data-testid="open-organizer-console"
              className={item}
              onClick={(e) => {
                // A modified click (new tab) keeps the plain link; the handoff is this tab's.
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                setOpen(false);
                void openOrganizerConsole();
              }}
            >
              <Store className="h-4 w-4" />
              <span className="min-w-0">
                Organizer console
                <span className="block truncate text-brand-meta text-brand-ink-3">
                  {organization.name}
                </span>
              </span>
              <ExternalLink className="ml-auto h-3.5 w-3.5 shrink-0 text-brand-ink-3" aria-hidden />
            </a>
          ) : (
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
                <span className="block text-brand-meta text-brand-ink-3">
                  Sell your own tickets
                </span>
              </span>
            </Link>
          )}

          <div className="my-1 border-t border-brand-line" />
          <button type="button" role="menuitem" className={item} onClick={onSignOut}>
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
