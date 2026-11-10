'use client';

import Link from 'next/link';
import { LogOut, User } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { accountInitials, accountName, formatPhoneForDisplay } from './account-display';

/**
 * Who is signed in to this console, as a menu opened from the avatar in the top bar.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────
 * One person often holds several logins - an organizer owner, a super admin, a second staff
 * member - and the top bar showed initials and a name that were the same on all of them. The
 * email address is what tells them apart, so it is beside the avatar on a wide screen and at
 * the top of this menu everywhere, with the role the account holds HERE under it.
 *
 * ── A DISCLOSURE, NOT AN ARIA MENU ────────────────────────────────────────────────
 * The panel holds text (the name, the role, a list of duties) as well as links, which an ARIA
 * `menu` may not contain. So it is a button with `aria-expanded` that shows a panel after it:
 * Tab walks into the panel, Escape closes it and puts focus back on the button, and a click
 * outside or focus leaving it closes it too.
 *
 * Only the signed-in person's own name, email and role are shown. It decides nothing: every
 * link the app passes is one this person can already open.
 */
export interface ConsoleAccountUser {
  fullName?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface ConsoleAccountLink {
  label: string;
  href: string;
}

export function ConsoleAccountMenu({
  user,
  role,
  details,
  links = [],
  onSignOut,
  appearance = 'classic',
}: {
  user: ConsoleAccountUser;
  /** The role this account holds in this console ("Owner", "Super admin"), when known. */
  role?: string | null;
  /**
   * More about the account, between the role and the links: the organizer's organization and
   * its switcher, the admin's duties. A function is handed `close` for a control that should
   * shut the menu when used.
   */
  details?: ReactNode | ((close: () => void) => ReactNode);
  /** The account's own pages ("Account security"). */
  links?: ConsoleAccountLink[];
  /** The console's existing sign-out, called as it is. */
  onSignOut: () => void;
  appearance?: 'classic' | 'desk';
}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const desk = appearance === 'desk';
  const s = desk ? DESK : CLASSIC;

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (wrapper.current && !wrapper.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const name = accountName(user);
  // The address that tells one login from another; a phone-only account has its number.
  const email = user.email?.trim() || null;
  const contact = email ?? formatPhoneForDisplay(user.phone);
  const initials = accountInitials(user);
  // The top bar's one line: the address where there is one, otherwise the name.
  const headline = email ?? name ?? 'Your account';
  const summary = [name, email, role].filter(Boolean).join(', ');
  const body = typeof details === 'function' ? details(close) : details;

  return (
    <div
      ref={wrapper}
      className="relative"
      onBlur={(e) => {
        // Tabbing out of the panel closes it, as a click outside does.
        if (open && !wrapper.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Account menu, signed in as ${headline}`}
        title={summary}
        data-testid="account-menu-trigger"
        onClick={() => setOpen((o) => !o)}
        className={`flex min-h-11 min-w-11 items-center gap-2.5 px-0.5 sm:min-h-10 ${s.trigger} ${s.focus}`}
      >
        <span
          aria-hidden
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${s.avatar}`}
        >
          {initials ?? <User className="h-4 w-4" />}
        </span>
        {/*
          Capped and truncated: a long address must not push the top bar's other controls into
          each other. The whole value is in the button's `title`. The desk shows it from `xl`,
          where it has the room; the classic frame from `lg`.
        */}
        <span
          data-testid="account-name"
          className={`hidden min-w-0 max-w-[9rem] text-left xl:max-w-[13rem] ${desk ? 'xl:block' : 'lg:block'}`}
        >
          <span className={`block truncate leading-tight ${s.name}`}>{headline}</span>
          {role && <span className={`block truncate leading-tight ${s.meta}`}>{role}</span>}
        </span>
      </button>

      {open && (
        <div
          id={panelId}
          data-testid="account-menu"
          className={`absolute right-0 top-full z-50 mt-2 w-72 max-w-[calc(100vw-2rem)] overflow-hidden py-1 ${s.panel}`}
        >
          <div className={`border-b px-4 py-3 ${s.line}`}>
            <p className={s.meta}>Signed in as</p>
            {name && name !== contact && (
              <p className={`truncate ${s.name}`} title={name}>
                {name}
              </p>
            )}
            {contact && (
              <p data-testid="account-menu-email" className={`truncate ${s.body}`} title={contact}>
                {contact}
              </p>
            )}
            {role && (
              <p className={`mt-2 ${s.body}`}>
                <span className={s.meta}>Role: </span>
                <span data-testid="account-menu-role" className="font-semibold">
                  {role}
                </span>
              </p>
            )}
          </div>

          {/* `empty:hidden`: details that render nothing leave no stray rule behind. */}
          {body && <div className={`border-b empty:hidden ${s.line}`}>{body}</div>}

          {links.map((l) => (
            <Link key={l.href} href={l.href} className={`${s.item} ${s.focus}`} onClick={close}>
              {l.label}
            </Link>
          ))}
          <button
            type="button"
            className={`${s.item} ${s.focus}`}
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
          >
            <LogOut className="h-4 w-4" aria-hidden />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The class strings for a row in the menu, so an app's `details` can draw its own controls
 * (the organizer's "Switch organization") the same way as the menu's links.
 */
export function consoleAccountMenuItemClass(appearance: 'classic' | 'desk' = 'classic'): string {
  const s = appearance === 'desk' ? DESK : CLASSIC;
  return `${s.item} ${s.focus}`;
}

/** The small grey label style used inside the menu, for an app's `details`. */
export function consoleAccountMenuMetaClass(appearance: 'classic' | 'desk' = 'classic'): string {
  return (appearance === 'desk' ? DESK : CLASSIC).meta;
}

const CLASSIC = {
  trigger: 'rounded-md hover:bg-background-subtle',
  focus: 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
  avatar: 'bg-tint-primary text-[0.8125rem] font-semibold text-action-primary',
  name: 'text-ui font-semibold text-text-primary',
  body: 'text-ui text-text-primary',
  meta: 'text-micro text-text-muted',
  line: 'border-border',
  panel: 'rounded-md border border-border bg-background-surface text-text-primary shadow-lg',
  item: 'flex min-h-11 w-full items-center gap-2.5 px-4 py-2 text-left text-ui text-text-secondary hover:bg-background-subtle hover:text-text-primary',
} as const;

const DESK: Record<keyof typeof CLASSIC, string> = {
  trigger: 'rounded-brand-control hover:bg-brand-sunken',
  focus:
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-focus focus-visible:ring-offset-2 focus-visible:ring-offset-brand-canvas',
  avatar: 'border border-brand-line bg-brand-surface text-brand-meta font-semibold text-brand-ink',
  name: 'text-brand-ui font-semibold text-brand-ink',
  body: 'text-brand-ui text-brand-ink',
  meta: 'text-brand-meta text-brand-ink-3',
  line: 'border-brand-line',
  panel:
    'rounded-brand-card border border-brand-line bg-brand-surface font-brand-text text-brand-ink shadow-brand-overlay',
  item: 'flex min-h-11 w-full items-center gap-2.5 px-4 py-2 text-left text-brand-ui text-brand-ink-2 hover:bg-brand-sunken hover:text-brand-ink',
};
