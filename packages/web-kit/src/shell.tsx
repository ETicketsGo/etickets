'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronsLeft, ChevronsRight, LogOut, Menu, Plus, X, type LucideIcon } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { useAuthUser, useLogout } from './hooks';
import { apiAssetUrl } from './api';
import { LogoMark } from './logo';
import { visibleNav, type NavItem } from './nav';
import { IconButton } from './primitives';
import {
  NavRail,
  NavTree,
  QuickNav,
  QuickNavTrigger,
  RailTip,
  useQuickNavShortcut,
} from './sidebar-nav';

/**
 * Remembered per device: a collapsed sidebar is about the screen somebody is sitting at, not
 * about who they are. Every access is wrapped - a private window throws on localStorage, and
 * a preference that cannot be read is not worth failing a page over.
 */
const SIDEBAR_KEY = 'etg_sidebar_collapsed';
function readCollapsed(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(SIDEBAR_KEY) === '1';
  } catch {
    return false;
  }
}
function writeCollapsed(value: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_KEY, value ? '1' : '0');
  } catch {
    /* not saved; the sidebar still works for this visit */
  }
}

const FOCUSABLE = 'a[href], button:not([disabled])';
const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
/** On the navy, the ring is the light teal: the console teal is too dark to see there. */
const NAV_FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nav-accent';

function initials(name: string): string {
  return name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

/**
 * The role line under the person's name, from the platform roles on their account.
 *
 * Used only when the app does not say something more specific (the organizer console passes
 * the member's role in THIS organization, which is the one that decides what they can do
 * here). Highest role first: a platform admin who also owns an organization is shown as the
 * admin they are.
 */
const ROLE_LABEL: [string, string][] = [
  ['SUPER_ADMIN', 'Super admin'],
  ['ADMIN', 'Admin'],
  ['ORGANIZER_OWNER', 'Owner'],
  ['ORGANIZER_MANAGER', 'Manager'],
  ['CHECKIN_STAFF', 'Check-in staff'],
];
export function accountRoleLabel(roles: readonly string[] | null | undefined): string | null {
  return ROLE_LABEL.find(([r]) => roles?.includes(r))?.[1] ?? null;
}

/** The top bar's one primary action: "Create event". */
export interface ShellAction {
  label: string;
  href: string;
  icon?: LucideIcon;
}

/**
 * The organizer and admin console frame: a deep navy sidebar, a clean top bar, the phone
 * drawer and quick navigation (docs/design/eticketsgo-premium-reference.png).
 *
 * ── ONE SHELL FOR BOTH CONSOLES ────────────────────────────────────────────────────
 * Both consoles are this component and behave identically: folding groups (only the current
 * one open), a rail of named group buttons with tooltips and flyouts, Ctrl/Cmd+K quick
 * navigation, a sticky sidebar that never adds a second scroll, and the drawer on a phone.
 * See `sidebar-nav.tsx`. What differs is the menu, the name in the masthead and the slots.
 *
 * ── THE LAYOUT ─────────────────────────────────────────────────────────────────────
 * From `lg` up it is a two-column grid: the sidebar takes the full height of the window on the
 * left, carrying the platform mark, and the top bar and the page share the column beside it.
 * The top bar is first in the DOM - search, the primary action and the account come before the
 * menu for a keyboard user - and the grid places the sidebar. Below `lg` there is no sidebar:
 * the top bar carries the menu button, and the menu is a drawer.
 *
 * ── THE TOP BAR ────────────────────────────────────────────────────────────────────
 * Left to right: the workspace masthead (an organization's own name and logo; admin has
 * none), "Find a page" (quick navigation, Ctrl/Cmd+K), then the one primary action, the
 * notifications bell, `headerAccessory` (the appearance switch), the person with their role,
 * and Sign out. Only the masthead and the search field are flexible: they truncate, and
 * everything else keeps its size, so nothing can overlap at any width
 * (`console-header-long-names.spec.ts`, `shell-header-overlap.spec.ts`).
 *
 * ── WHO SEES WHAT ──────────────────────────────────────────────────────────────────
 * The nav is filtered here by role and by back-office capability (`visibleNav`), once, and
 * the sidebar, the rail, the drawer and quick navigation all read the filtered copy - so no
 * surface can offer a page the viewer cannot open. It is never the authorization.
 */
export function AppShell({
  brand,
  nav,
  workspace,
  headerAccessory,
  drawerAccessory,
  primaryAction,
  notifications,
  accountRole,
  navLabel = 'Main',
  drawerLabel = 'Navigation',
  width = 'contained',
  children,
}: {
  /** The console's name beside the platform mark: "Organizer", "Admin". */
  brand: string;
  nav: NavItem[];
  /** The organization this workspace belongs to. Its name is the masthead. */
  workspace?: { name: string; logoUrl?: string | null };
  /** Rendered in the top bar beside the account - the appearance switch. */
  headerAccessory?: ReactNode;
  /** Rendered at the top of the phone drawer, for a control the narrow top bar has no room for. */
  drawerAccessory?: ReactNode;
  /**
   * The view's one primary action, in the top bar from `sm` up: icon and words from `xl`,
   * the icon with its name as a tooltip below that. Hidden on its own page, where it would
   * be a button that goes nowhere.
   */
  primaryAction?: ShellAction | null;
  /** The notifications control (`NotificationsButton`), from `sm` up, where the app has one. */
  notifications?: ReactNode;
  /** The line under the person's name. Defaults to their platform role. */
  accountRole?: string | null;
  /** The accessible name of the navigation landmark ("Main" for organizers, "Admin"). */
  navLabel?: string;
  /** The accessible name of the phone drawer. */
  drawerLabel?: string;
  /**
   * How the frame uses a wide screen. 'contained' centres the content in a 1280px column;
   * 'fluid' lets it take the row up to 1536px. A ceiling, not a target: each page still
   * decides its own measure.
   */
  width?: 'contained' | 'fluid';
  children: ReactNode;
}) {
  const pathname = usePathname() ?? '/';
  const logout = useLogout();
  const { user } = useAuthUser();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  /*
    Read after mount, not during render: the server has no localStorage, and a sidebar that
    rendered collapsed on the server and expanded on the client would be a hydration error.
  */
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => setCollapsed(readCollapsed()), []);
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      writeCollapsed(!c);
      return !c;
    });

  const items = useMemo(() => visibleNav(nav, user), [nav, user]);

  const openQuick = useCallback(() => {
    setMobileOpen(false);
    setQuickOpen(true);
  }, []);
  const closeQuick = useCallback(() => setQuickOpen(false), []);
  useQuickNavShortcut(openQuick);

  /*
    ── THE PHONE DRAWER IS A DIALOG ───────────────────────────────────────────────────
    It covers the page, so it behaves like one: it says so to assistive technology, takes
    focus when it opens, keeps Tab inside itself, closes on Escape, and hands focus back to
    the button that opened it.
  */
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const closeMobile = useCallback(() => setMobileOpen(false), []);
  useEffect(() => {
    if (!mobileOpen) return;
    const opener = menuButton.current;
    (
      drawer.current?.querySelector<HTMLElement>('a[aria-current="page"]') ??
      drawer.current?.querySelector<HTMLElement>(FOCUSABLE)
    )?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMobileOpen(false);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      opener?.focus();
    };
  }, [mobileOpen]);
  // A route change is a navigation; the drawer has done its job.
  useEffect(() => setMobileOpen(false), [pathname]);

  const trapTab = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Tab' || !drawer.current) return;
    const focusable = Array.from(drawer.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null,
    );
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

  const home = items[0]?.href ?? '/';
  const role = accountRole ?? accountRoleLabel(user?.roles);
  const logoUrl = apiAssetUrl(workspace?.logoUrl ?? null);
  const showAction =
    !!primaryAction &&
    !(pathname === primaryAction.href || pathname.startsWith(`${primaryAction.href}/`));
  const ActionIcon = primaryAction?.icon ?? Plus;

  return (
    <div className="min-h-dvh bg-background-canvas lg:grid lg:grid-cols-[auto_minmax(0,1fr)] lg:grid-rows-[auto_1fr]">
      <a
        href="#main"
        className="sr-only z-[80] rounded-md bg-background-surface px-4 py-2 text-ui font-semibold text-text-primary shadow-lg focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-30 border-b border-border bg-background-surface pt-[env(safe-area-inset-top)] lg:col-start-2 lg:row-start-1">
        {/* A fixed 4rem row from `lg` up, to line up with the sidebar's brand row. */}
        <div className="flex min-h-[3.75rem] items-center gap-2 px-4 py-2 sm:gap-3 lg:h-shell-topbar lg:gap-4 lg:px-6 lg:py-0">
          {/*
            `min-w-0` is load-bearing all the way down: a flex child will not shrink below its
            content width without it, so `truncate` on the masthead would do nothing and the
            top bar would push the page sideways at 320px.
          */}
          <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3 lg:max-w-[18rem] lg:flex-initial xl:max-w-[22rem]">
            <button
              ref={menuButton}
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-background-subtle hover:text-text-primary lg:hidden ${FOCUS}`}
              aria-label="Toggle navigation"
              aria-expanded={mobileOpen}
              aria-haspopup="dialog"
              onClick={() => setMobileOpen((o) => !o)}
            >
              <Menu className="h-5 w-5" aria-hidden />
            </button>
            {/*
              The platform mark, where there is no sidebar to carry it. Beside an organization's
              masthead it steps back to the mark and the console's name, from `sm` up only: on a
              phone the organization's own name is the one that matters.
            */}
            <Link
              href={home}
              className={`min-w-0 shrink-0 items-center gap-2 rounded-sm lg:hidden ${workspace ? 'hidden sm:flex' : 'flex'} ${FOCUS}`}
            >
              <LogoMark variant="compact" id="etg-topbar" className="h-7 w-7 shrink-0" />
              {!workspace && (
                <span className="font-display text-[1.0625rem] font-bold tracking-tight text-text-primary">
                  ETickets<span className="text-action-primary">Go</span>
                </span>
              )}
              <span className="rounded-full bg-background-subtle px-2 py-0.5 text-micro font-semibold text-text-secondary">
                {brand}
              </span>
            </Link>
            {workspace && (
              /*
                THE MASTHEAD: the organization's own name, and its logo where it has one. It is
                the flexible part of the top bar, so it truncates rather than reaching a control
                (`shell-header-overlap.spec.ts`); the full name stays in the text for assistive
                technology and in `title` for a pointer.
              */
              <div className="flex min-w-0 items-center gap-2.5">
                {logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={logoUrl}
                    alt=""
                    className="hidden h-8 w-8 shrink-0 rounded-md object-cover sm:block"
                  />
                ) : (
                  workspace.name.trim() && (
                    <span
                      aria-hidden
                      className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-md bg-tint-primary font-display text-micro font-bold text-action-primary sm:flex"
                    >
                      {initials(workspace.name)}
                    </span>
                  )
                )}
                <span
                  data-testid="workspace-name"
                  className="truncate font-display text-[0.9375rem] font-bold tracking-tight text-text-primary sm:text-[1.0625rem]"
                  title={workspace.name}
                >
                  {workspace.name}
                </span>
              </div>
            )}
          </div>

          {/* Quick navigation as the reference's search field. On a phone it is in the drawer. */}
          <div className="hidden min-w-[2.75rem] max-w-md flex-1 lg:block">
            <QuickNavTrigger onOpen={openQuick} />
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
            {showAction && primaryAction && (
              <>
                {/* Words from `xl`; below that the icon, named and with a tooltip. */}
                <Link
                  href={primaryAction.href}
                  className={`hidden h-10 items-center gap-2 rounded-md bg-action-primary px-4 text-ui font-semibold text-action-primary-foreground shadow-xs transition-colors duration-150 hover:bg-action-primary-hover active:translate-y-px motion-reduce:transition-none xl:inline-flex ${FOCUS} focus-visible:ring-offset-2 focus-visible:ring-offset-background-surface`}
                >
                  <ActionIcon className="h-4 w-4" aria-hidden />
                  {primaryAction.label}
                </Link>
                <IconButton
                  href={primaryAction.href}
                  icon={ActionIcon}
                  label={primaryAction.label}
                  variant="primary"
                  className="hidden sm:inline-flex xl:hidden"
                />
              </>
            )}
            {notifications && <div className="hidden sm:flex">{notifications}</div>}
            {headerAccessory}
            {user && (
              <>
                <span aria-hidden className="mx-1 hidden h-6 w-px bg-border lg:block" />
                <div className="flex items-center gap-2.5">
                  <div
                    className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full bg-tint-primary text-[0.8125rem] font-semibold text-action-primary sm:flex"
                    aria-hidden
                  >
                    {initials(user.fullName)}
                  </div>
                  {/*
                    Capped and truncated, like the masthead: a long name is the other way the
                    top bar used to push its own controls into each other. The address is in
                    `title`, so the role can have the second line.
                  */}
                  <div
                    data-testid="account-name"
                    className="hidden min-w-0 max-w-[9rem] lg:block xl:max-w-[12rem]"
                    title={[user.fullName, user.email].filter(Boolean).join(', ')}
                  >
                    <p className="truncate text-ui font-semibold leading-tight text-text-primary">
                      {user.fullName}
                    </p>
                    <p className="truncate text-micro leading-tight text-text-muted">
                      {role ?? user.email}
                    </p>
                  </div>
                </div>
              </>
            )}
            <IconButton icon={LogOut} label="Sign out" onClick={logout} />
          </div>
        </div>
      </header>

      {/*
        ── THE SIDEBAR ─────────────────────────────────────────────────────────────────
        Deep navy, the full height of the window, pinned. The PAGE is the one thing that
        scrolls: groups start folded except the current one, so the list fits a 768px-tall
        laptop, and on a shorter window only the list scrolls - thinly, with the brand row
        pinned above it.

        `z-20` because a sticky element is a stacking context of its own: without it the rail's
        flyouts and tooltips painted UNDER any positioned card beside it. Below the top bar
        (30) and the phone drawer (40).
      */}
      <aside
        aria-label="Sidebar"
        className={`sticky top-0 z-20 hidden h-dvh shrink-0 flex-col bg-nav text-nav-foreground transition-[width] duration-200 ease-premium motion-reduce:transition-none lg:col-start-1 lg:row-span-2 lg:row-start-1 lg:flex ${
          collapsed ? 'w-shell-rail' : 'w-shell-sidebar'
        }`}
      >
        {/*
          The platform mark and the console's name, with the collapse control beside them.
          `aria-expanded`, not `aria-pressed`: it opens and closes the sidebar's labels, and the
          admin list pages find their group chips as `button[aria-pressed]`.
        */}
        <div
          className={`flex shrink-0 border-b border-nav-border ${
            collapsed
              ? 'flex-col items-center gap-1 px-2 py-3'
              : 'h-shell-topbar items-center justify-between gap-2 pl-5 pr-3'
          }`}
        >
          <Link
            href={home}
            aria-label={collapsed ? `ETicketsGo ${brand}, home` : undefined}
            className={`flex min-w-0 items-center gap-2.5 rounded-md ${NAV_FOCUS}`}
          >
            <LogoMark variant="compact" id="etg-sidebar" className="h-8 w-8 shrink-0" />
            {!collapsed && (
              // Stacked, so the console's name is never truncated beside the collapse control.
              <span className="flex min-w-0 flex-col leading-none">
                <span className="font-display text-[1.0625rem] font-bold tracking-tight text-white">
                  ETicketsGo
                </span>
                <span className="mt-1 truncate text-[0.6875rem] font-semibold uppercase tracking-[0.1em] text-nav-muted">
                  {brand}
                </span>
              </span>
            )}
          </Link>
          <RailTip label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            {(tip) => (
              <button
                type="button"
                onClick={toggleCollapsed}
                aria-expanded={!collapsed}
                aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                {...tip}
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-nav-muted transition-colors duration-150 hover:bg-nav-hover hover:text-white ${NAV_FOCUS}`}
              >
                {collapsed ? (
                  <ChevronsRight className="h-[1.125rem] w-[1.125rem]" aria-hidden />
                ) : (
                  <ChevronsLeft className="h-[1.125rem] w-[1.125rem]" aria-hidden />
                )}
              </button>
            )}
          </RailTip>
        </div>
        <nav
          aria-label={navLabel}
          className={`min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-4 pt-3 [scrollbar-color:hsl(var(--nav-border))_transparent] [scrollbar-width:thin] ${
            collapsed ? 'px-2' : 'px-3'
          }`}
        >
          {collapsed ? (
            <NavRail items={items} pathname={pathname} />
          ) : (
            <NavTree items={items} pathname={pathname} />
          )}
        </nav>
      </aside>

      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            className="fixed inset-0 z-40 bg-black/50 lg:hidden"
            onClick={closeMobile}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.aside
              ref={drawer}
              role="dialog"
              aria-modal="true"
              aria-label={drawerLabel}
              onKeyDown={trapTab}
              className="flex h-full w-[min(20rem,86vw)] flex-col bg-nav pt-[env(safe-area-inset-top)] text-nav-foreground shadow-lg"
              onClick={(e) => e.stopPropagation()}
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            >
              <div className="flex items-center justify-between gap-2 border-b border-nav-border py-2 pl-4 pr-2">
                <span className="flex min-w-0 items-center gap-2.5">
                  <LogoMark variant="compact" id="etg-drawer" className="h-7 w-7 shrink-0" />
                  <span className="min-w-0 truncate font-display font-semibold text-white">
                    {workspace?.name.trim() ? workspace.name : `ETicketsGo ${brand}`}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={closeMobile}
                  aria-label="Close navigation"
                  className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-nav-muted hover:bg-nav-hover hover:text-white ${NAV_FOCUS}`}
                >
                  <X className="h-5 w-5" aria-hidden />
                </button>
              </div>
              {drawerAccessory && (
                /*
                  On a surface card, not on the navy: an accessory is the app's own control in
                  the console's ordinary colours, which are solved against a light surface.
                */
                <div className="mx-3 mt-3 overflow-hidden rounded-md bg-background-surface text-text-primary">
                  {drawerAccessory}
                </div>
              )}
              <div className="px-3 pt-3">
                <QuickNavTrigger onOpen={openQuick} tone="nav" />
              </div>
              <nav
                aria-label={navLabel}
                className="flex-1 overflow-y-auto px-3 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-3 [scrollbar-width:thin]"
              >
                <NavTree items={items} pathname={pathname} onNavigate={closeMobile} />
              </nav>
            </motion.aside>
          </motion.div>
        )}
      </AnimatePresence>

      <QuickNav items={items} open={quickOpen} onClose={closeQuick} />

      <main
        id="main"
        tabIndex={-1}
        className="min-w-0 px-4 py-6 focus:outline-none sm:px-6 lg:col-start-2 lg:row-start-2 lg:py-8 xl:px-8"
      >
        <div className={`mx-auto ${width === 'fluid' ? 'max-w-screen-2xl' : 'max-w-7xl'}`}>
          {children}
        </div>
      </main>
    </div>
  );
}

/**
 * The top of every console page: where you are, what this page is for, and its main action.
 *
 * `eyebrow` is a short context line above the title - the organization a dashboard belongs
 * to, the event a sub-page is about. `meta` sits under the description for facts about the
 * page as a whole (a status pill, a date range). Both are optional, and a page that passes
 * neither renders exactly the shape it always did.
 *
 * The title is the page's only <h1>, in the display face at the console's 30px. The actions
 * wrap under it on a phone rather than squeezing it: a heading broken over four lines to keep
 * a button beside it is the wrong trade on a 320px screen.
 */
export function PageHeader({
  title,
  description,
  action,
  breadcrumbs,
  eyebrow,
  meta,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  breadcrumbs?: { label: string; href?: string }[];
  eyebrow?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div className="mb-6 lg:mb-8">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav
          aria-label="Breadcrumb"
          className="mb-3 flex flex-wrap items-center gap-1.5 text-caption text-text-muted"
        >
          {breadcrumbs.map((b, i) => (
            <span key={i} className="flex items-center gap-1.5">
              {b.href ? (
                <Link
                  href={b.href}
                  className="rounded-sm transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {b.label}
                </Link>
              ) : (
                <span className="text-text-secondary" aria-current="page">
                  {b.label}
                </span>
              )}
              {i < breadcrumbs.length - 1 && <span aria-hidden>/</span>}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-0 max-w-3xl">
          {eyebrow && (
            <p className="mb-1.5 text-micro font-semibold uppercase tracking-[0.08em] text-action-primary">
              {eyebrow}
            </p>
          )}
          <h1 className="text-balance break-words font-display text-display font-bold tracking-tight text-text-primary">
            {title}
          </h1>
          {description && (
            <p className="mt-1.5 text-[0.9375rem] text-text-secondary">{description}</p>
          )}
          {meta && <div className="mt-3 flex flex-wrap items-center gap-2">{meta}</div>}
        </div>
        {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
      </div>
    </div>
  );
}
