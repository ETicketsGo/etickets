'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, LogOut, Menu, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import { useAuthUser, useLogout } from '@eticketsgo/web-kit';
import {
  ADMIN_NAV,
  activeGroupKey,
  activeHref,
  readFolded,
  writeFolded,
  type AdminNavGroup,
} from '@/lib/admin-nav';
import { ColorSchemeSwitch } from './color-scheme-switch';

/**
 * The admin console's frame: header, grouped sidebar, and the phone's drawer.
 *
 * ── WHY ADMIN HAS ITS OWN FRAME ────────────────────────────────────────────────────
 * `AppShell` renders a flat list with optional headings, and it is shared by the organizer
 * console, which another piece of work is redesigning at the same time. The admin menu needs two
 * things that list cannot express: groups an operator can fold, and a sidebar that can step out
 * of the way of a wide screen like the calendar. Building them here keeps the shared shell's
 * contract untouched, and every colour below is a semantic token, so a palette change in the
 * design tokens restyles this frame the same way it restyles that one.
 *
 * The header keeps the shared shell's names on purpose - "Toggle navigation", "Sign out" - so the
 * e2e checks that find those controls by name find them here too.
 */

function initials(name: string): string {
  return name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

const RAIL_KEY = 'etg_admin_nav_rail';

function readRail(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(RAIL_KEY) === '1';
  } catch {
    return false;
  }
}

function writeRail(on: boolean): void {
  try {
    window.localStorage.setItem(RAIL_KEY, on ? '1' : '0');
  } catch {
    /* not remembered, still works */
  }
}

function NavGroups({
  nav,
  pathname,
  folded,
  onToggleGroup,
  rail,
  onNavigate,
  idPrefix,
}: {
  nav: AdminNavGroup[];
  pathname: string;
  folded: string[];
  onToggleGroup: (key: string) => void;
  rail: boolean;
  onNavigate?: () => void;
  /** The desktop list and the drawer both render; ids must not collide. */
  idPrefix: string;
}) {
  const current = activeHref(pathname, nav);
  const currentGroup = activeGroupKey(pathname, nav);

  return (
    <nav aria-label="Admin" className="space-y-1">
      {nav.map((group) => {
        /*
          The group holding the current page is always open. Folding it would leave the person
          on a page whose menu entry they cannot see, with no marker of where they are.
        */
        const open =
          !group.label || rail || !folded.includes(group.key) || group.key === currentGroup;
        const listId = `${idPrefix}-group-${group.key}`;
        return (
          <div
            key={group.key}
            className={rail ? 'border-t border-border pt-1 first:border-t-0' : ''}
          >
            {group.label && !rail && (
              <button
                type="button"
                aria-expanded={open}
                aria-controls={listId}
                onClick={() => onToggleGroup(group.key)}
                disabled={group.key === currentGroup}
                className="group flex w-full items-center justify-between gap-2 rounded-md px-3 pb-1 pt-3 text-left text-caption font-semibold uppercase tracking-wide text-text-muted transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default disabled:hover:text-text-muted"
              >
                <span>{group.label}</span>
                <ChevronDown
                  aria-hidden
                  className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? '' : '-rotate-90'} ${
                    group.key === currentGroup ? 'opacity-0' : ''
                  }`}
                />
              </button>
            )}
            <ul id={listId} hidden={!open} className="space-y-0.5">
              {group.links.map((link) => {
                const active = link.href === current;
                const Icon = link.icon;
                return (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      onClick={onNavigate}
                      aria-current={active ? 'page' : undefined}
                      aria-label={rail ? link.label : undefined}
                      title={rail ? link.label : undefined}
                      className={`flex min-h-[2.75rem] items-center gap-2.5 rounded-md px-3 py-2 text-[0.9375rem] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 lg:min-h-0 ${
                        rail ? 'justify-center' : ''
                      } ${
                        active
                          ? 'bg-tint-primary font-semibold text-action-primary'
                          : 'text-text-secondary hover:bg-background-subtle hover:text-text-primary'
                      }`}
                    >
                      <Icon className="h-4 w-4 shrink-0" aria-hidden />
                      {!rail && <span className="min-w-0">{link.label}</span>}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/admin';
  const logout = useLogout();
  const { user } = useAuthUser();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [folded, setFolded] = useState<string[]>([]);
  const [rail, setRail] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  // Read after mount: the server has no storage, and a first render that differed between the
  // two would be a hydration mismatch.
  useEffect(() => {
    setFolded(readFolded());
    setRail(readRail());
  }, []);

  const toggleGroup = useCallback((key: string) => {
    setFolded((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      writeFolded(next);
      return next;
    });
  }, []);

  const toggleRail = () => {
    setRail((on) => {
      writeRail(!on);
      return !on;
    });
  };

  const closeDrawer = useCallback(() => {
    setMobileOpen(false);
    // Back to the control that opened it, so a keyboard user is not dropped at the top of the page.
    toggleRef.current?.focus();
  }, []);

  /*
    The drawer is a modal: Escape closes it, focus moves into it when it opens, and Tab cannot
    wander to the page underneath, which is covered and inert while it is open.
  */
  useEffect(() => {
    if (!mobileOpen) return;
    const panel = drawerRef.current;
    panel?.querySelector<HTMLElement>('a[aria-current="page"], a[href], button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDrawer();
      if (e.key !== 'Tab' || !panel) return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'),
      ).filter((el) => el.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen, closeDrawer]);

  return (
    <div className="min-h-dvh bg-background-canvas">
      <header className="sticky top-0 z-30 border-b border-border bg-background-surface/80 pt-[env(safe-area-inset-top)] backdrop-blur-md">
        <div className="flex items-center justify-between gap-2 px-4 py-3 lg:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button
              ref={toggleRef}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 lg:hidden"
              aria-label="Toggle navigation"
              aria-expanded={mobileOpen}
              aria-controls="admin-drawer"
              onClick={() => setMobileOpen((o) => !o)}
            >
              <Menu className="h-5 w-5" aria-hidden />
            </button>
            <Link
              href="/admin"
              className="flex min-w-0 items-center gap-2 font-bold text-text-primary"
            >
              <span className="text-[1.05rem] tracking-tight">
                ETickets<span className="text-action-primary">Go</span>
              </span>
              <span className="rounded-full bg-background-subtle px-2 py-0.5 text-caption font-medium text-text-muted">
                Admin
              </span>
            </Link>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            {/*
              From `sm` up only. At 320-390px the brand, the menu button, three appearance
              buttons and Sign out do not fit on one line, and the brand was drawn under the
              switch. On a phone the switch is in the menu drawer instead.
            */}
            <ColorSchemeSwitch className="hidden sm:flex" />
            {user && (
              <div className="flex items-center gap-2.5">
                <div className="hidden text-right md:block">
                  <p className="text-[0.8125rem] font-medium leading-tight text-text-primary">
                    {user.fullName}
                  </p>
                  <p className="text-caption leading-tight text-text-muted">{user.email}</p>
                </div>
                <div
                  className="hidden h-9 w-9 items-center justify-center rounded-full bg-tint-primary text-[0.8125rem] font-semibold text-action-primary sm:flex"
                  aria-hidden
                >
                  {initials(user.fullName)}
                </div>
              </div>
            )}
            <button
              onClick={logout}
              aria-label="Sign out"
              className="flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-[0.8125rem] font-medium text-text-secondary transition-colors hover:bg-background-subtle hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <LogOut className="h-3.5 w-3.5" aria-hidden />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-screen-2xl gap-6 px-4 py-8 lg:px-6 xl:gap-8">
        <aside
          className={`hidden shrink-0 lg:block ${rail ? 'w-14' : 'w-60'}`}
          aria-label="Admin menu"
        >
          <div className="sticky top-24 max-h-[calc(100dvh-7rem)] overflow-y-auto pb-6 pr-1">
            {/*
              `aria-expanded`, not `aria-pressed`: it opens and closes the menu labels, and the
              admin list pages find their group chips as `button[aria-pressed]` - a pressed-state
              button in the frame would be counted as one of them.
            */}
            <button
              type="button"
              onClick={toggleRail}
              aria-expanded={!rail}
              aria-label={rail ? 'Expand menu' : 'Collapse menu'}
              title={rail ? 'Expand menu' : 'Collapse menu'}
              className={`mb-2 flex h-9 items-center gap-2 rounded-md px-3 text-caption font-medium text-text-muted transition-colors hover:bg-background-subtle hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                rail ? 'w-full justify-center' : ''
              }`}
            >
              {rail ? (
                <PanelLeftOpen className="h-4 w-4" aria-hidden />
              ) : (
                <>
                  <PanelLeftClose className="h-4 w-4" aria-hidden />
                  <span>Collapse menu</span>
                </>
              )}
            </button>
            <NavGroups
              nav={ADMIN_NAV}
              pathname={pathname}
              folded={folded}
              onToggleGroup={toggleGroup}
              rail={rail}
              idPrefix="side"
            />
          </div>
        </aside>

        <AnimatePresence>
          {mobileOpen && (
            <motion.div
              className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm lg:hidden"
              onClick={closeDrawer}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <motion.div
                id="admin-drawer"
                ref={drawerRef}
                role="dialog"
                aria-modal="true"
                aria-label="Admin menu"
                className="flex h-full w-[min(20rem,85vw)] flex-col border-r border-border bg-background-surface pt-[env(safe-area-inset-top)]"
                onClick={(e) => e.stopPropagation()}
                initial={{ x: '-100%' }}
                animate={{ x: 0 }}
                exit={{ x: '-100%' }}
                transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
              >
                <div className="flex items-center justify-between border-b border-border px-4 py-3">
                  <span className="text-[0.9375rem] font-semibold text-text-primary">Menu</span>
                  <button
                    type="button"
                    onClick={closeDrawer}
                    aria-label="Close menu"
                    className="flex h-11 w-11 items-center justify-center rounded-md text-text-secondary hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    <X className="h-5 w-5" aria-hidden />
                  </button>
                </div>
                <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:hidden">
                  <span className="text-sm text-text-secondary">Appearance</span>
                  <ColorSchemeSwitch />
                </div>
                <div className="flex-1 overflow-y-auto p-3 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
                  <NavGroups
                    nav={ADMIN_NAV}
                    pathname={pathname}
                    folded={folded}
                    onToggleGroup={toggleGroup}
                    rail={false}
                    onNavigate={() => setMobileOpen(false)}
                    idPrefix="drawer"
                  />
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
