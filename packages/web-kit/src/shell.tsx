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
import { brandButtonClasses } from './brand';
import {
  NavRail,
  NavTree,
  QuickNav,
  QuickNavTrigger,
  RailTip,
  useQuickNavShortcut,
  type ShellAppearance,
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
  return (
    name
      .split(/\s+/)
      // The first letter or digit of each word: "DeepTrics (local fixture)" is "DL", never "D(".
      .map((p) => p.match(/[\p{L}\p{N}]/u)?.[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase()
  );
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

/**
 * A short notice at the top of the sidebar: the organizer's "Finish setup, 3 of 5 done" while
 * setup is unfinished. One link, words always; in the collapsed rail it is the icon with its
 * words as a tooltip. The app decides when there is one - it disappears when setup is done.
 */
export interface ShellNotice {
  label: string;
  detail?: string;
  href: string;
  icon: LucideIcon;
  /** 0..1, drawn as a thin bar under the words. The words say the same thing. */
  progress?: number;
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
 * Both consoles are this component: Ctrl/Cmd+K quick navigation, a sticky sidebar that never
 * adds a second scroll, and the drawer on a phone. The classic (admin) sidebar folds its groups
 * and its rail opens flyouts; the desk (organizer) sidebar is one flat list with icons and a
 * rail of named icon links (organizer recovery). See `sidebar-nav.tsx`.
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
 *
 * ── TWO APPEARANCES, ONE FRAME ─────────────────────────────────────────────────────
 * `appearance="desk"` paints the same frame in the brand layer (docs/design/DESIGN-SYSTEM.md):
 * paper sidebar with a marigold current-item bar, the wordmark instead of the gradient mark,
 * an ink primary action that keeps its words. Admin stays `classic` until it adopts the system.
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
  sidebarNotice,
  navLabel = 'Main',
  drawerLabel = 'Navigation',
  width = 'contained',
  appearance = 'classic',
  renderMark,
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
   * the icon with its name as a tooltip below that (the desk keeps its words at every width
   * it is shown). Hidden on its own page, where it would be a button that goes nowhere.
   */
  primaryAction?: ShellAction | null;
  /** The notifications control (`NotificationsButton`), from `sm` up, where the app has one. */
  notifications?: ReactNode;
  /** The line under the person's name. Defaults to their platform role. */
  accountRole?: string | null;
  /** A notice above the sidebar's list (desk only): see `ShellNotice`. */
  sidebarNotice?: ShellNotice | null;
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
  /**
   * 'classic' is the navy console; 'desk' is the brand layer's light console
   * (docs/design/DESIGN-SYSTEM.md section 5). The desk wraps the whole frame in
   * `data-brand="console"`, so the page inside may use the `brand-*` tokens too.
   */
  appearance?: ShellAppearance;
  /**
   * The platform mark in the classic frame, drawn at the size each place asks for (the class
   * string). Left out, it is the gradient `LogoMark`. Admin passes its own: the mark its
   * favicon uses, so the tab and the console header are the same picture. The desk draws the
   * wordmark and never asks.
   */
  renderMark?: (className: string) => ReactNode;
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
  const desk = appearance === 'desk';
  const c = desk ? DESK : CLASSIC;
  const focus = desk ? DESK_RING : FOCUS;
  const navFocus = desk ? DESK_RING : NAV_FOCUS;

  return (
    <div
      data-brand={desk ? 'console' : undefined}
      className={`min-h-dvh lg:grid lg:grid-cols-[auto_minmax(0,1fr)] lg:grid-rows-[auto_1fr] ${c.root}`}
    >
      <a
        href="#main"
        className="sr-only z-[80] rounded-md bg-background-surface px-4 py-2 text-ui font-semibold text-text-primary shadow-lg focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>

      <header
        className={`sticky top-0 z-30 border-b pt-[env(safe-area-inset-top)] lg:col-start-2 lg:row-start-1 ${c.header}`}
      >
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
              className={`flex h-11 w-11 shrink-0 items-center justify-center lg:hidden ${c.iconButton} ${focus}`}
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
              className={`min-w-0 shrink-0 items-center gap-2 rounded-sm lg:hidden ${workspace ? 'hidden sm:flex' : 'flex'} ${focus}`}
            >
              {desk ? (
                <DeskWordmark />
              ) : (
                <>
                  {renderMark ? (
                    renderMark('h-7 w-7 shrink-0')
                  ) : (
                    <LogoMark variant="compact" id="etg-topbar" className="h-7 w-7 shrink-0" />
                  )}
                  {!workspace && (
                    <span className="font-display text-[1.0625rem] font-bold tracking-tight text-text-primary">
                      ETickets<span className="text-action-primary">Go</span>
                    </span>
                  )}
                  <span className="rounded-full bg-background-subtle px-2 py-0.5 text-micro font-semibold text-text-secondary">
                    {brand}
                  </span>
                </>
              )}
            </Link>
            {workspace && (
              /*
                THE MASTHEAD: the organization's own name, and its logo where it has one. It is
                the flexible part of the top bar, so it truncates rather than reaching a control
                (`shell-header-overlap.spec.ts`); the full name stays in the text for assistive
                technology and in `title` for a pointer.
              */
              <div className={`flex min-w-0 items-center ${desk ? 'gap-3' : 'gap-2.5'}`}>
                {logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={logoUrl}
                    alt=""
                    className={`hidden h-8 w-8 shrink-0 object-cover sm:block ${desk ? 'rounded-brand-control' : 'rounded-md'}`}
                  />
                ) : (
                  workspace.name.trim() && (
                    <span
                      aria-hidden
                      className={`hidden h-8 w-8 shrink-0 items-center justify-center sm:flex ${c.monogram}`}
                    >
                      {initials(workspace.name)}
                    </span>
                  )
                )}
                <span
                  data-testid="workspace-name"
                  className={`truncate ${c.mastheadName}`}
                  title={workspace.name}
                >
                  {workspace.name}
                </span>
              </div>
            )}
          </div>

          {/*
            Quick navigation as the reference's search field. On a phone it is in the drawer.
            The desk shows the field only where it has room for its words and shortcut (from
            `xl`); between `lg` and `xl` it is the search icon, so the primary action keeps its
            words at a 1024px laptop instead of the field squeezing everything (EXPERIENCE-AUDIT
            O3: "Ctrl K" wrapped and Create event lost its label there). Its floor is its own
            words: a long organization name truncates first, never into the field
            (`console-header-long-names.spec.ts`).
          */}
          {desk ? (
            <>
              <div className="hidden min-w-[11rem] max-w-md flex-1 xl:block">
                <QuickNavTrigger onOpen={openQuick} tone="desk" />
              </div>
              <div className="hidden lg:block xl:hidden">
                <QuickNavTrigger onOpen={openQuick} tone="desk" compact />
              </div>
            </>
          ) : (
            <div className="hidden min-w-[2.75rem] max-w-md flex-1 lg:block">
              <QuickNavTrigger onOpen={openQuick} />
            </div>
          )}

          <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
            {showAction && primaryAction && desk && (
              /*
                The desk's one primary action: ink on paper (paper on charcoal in the dark), and
                its words at every width it is shown - a "+" alone is a guess, not an action.
              */
              <Link
                href={primaryAction.href}
                className={`hidden sm:inline-flex ${brandButtonClasses('primary', 'md')}`}
              >
                <ActionIcon className="h-4 w-4" aria-hidden />
                {primaryAction.label}
              </Link>
            )}
            {showAction && primaryAction && !desk && (
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
                <span aria-hidden className={`mx-1 hidden h-6 w-px lg:block ${c.divider}`} />
                <div className={`flex items-center ${desk ? 'gap-3' : 'gap-2.5'}`}>
                  <div
                    className={`hidden h-9 w-9 shrink-0 items-center justify-center rounded-full sm:flex ${c.avatar}`}
                    aria-hidden
                  >
                    {initials(user.fullName)}
                  </div>
                  {/*
                    Capped and truncated, like the masthead: a long name is the other way the
                    top bar used to push its own controls into each other. The address is in
                    `title`, so the role can have the second line. The desk names the person from
                    `xl` only: at 1024px the avatar says who, and the room goes to the action.
                  */}
                  <div
                    data-testid="account-name"
                    className={`hidden min-w-0 max-w-[9rem] xl:max-w-[12rem] ${desk ? 'xl:block' : 'lg:block'}`}
                    title={[user.fullName, user.email].filter(Boolean).join(', ')}
                  >
                    <p className={`truncate leading-tight ${c.accountName}`}>{user.fullName}</p>
                    <p className={`truncate leading-tight ${c.accountRole}`}>
                      {role ?? user.email}
                    </p>
                  </div>
                </div>
              </>
            )}
            {desk ? (
              <button
                type="button"
                onClick={logout}
                aria-label="Sign out"
                title="Sign out"
                className={`flex h-10 w-10 shrink-0 items-center justify-center ${c.iconButton} ${focus}`}
              >
                <LogOut className="h-[1.125rem] w-[1.125rem]" aria-hidden />
              </button>
            ) : (
              <IconButton icon={LogOut} label="Sign out" onClick={logout} />
            )}
          </div>
        </div>
      </header>

      {/*
        ── THE SIDEBAR ─────────────────────────────────────────────────────────────────
        Navy (or the desk's paper), the full height of the window, pinned. The PAGE is the one
        thing that scrolls: groups start folded except the current one, so the list fits a
        768px-tall laptop, and on a shorter window only the list scrolls - thinly, with the
        brand row pinned above it.

        `z-20` because a sticky element is a stacking context of its own: without it the rail's
        flyouts and tooltips painted UNDER any positioned card beside it. Below the top bar
        (30) and the phone drawer (40).
      */}
      <aside
        aria-label="Sidebar"
        className={`sticky top-0 z-20 hidden h-dvh shrink-0 flex-col transition-[width] duration-200 ease-premium motion-reduce:transition-none lg:col-start-1 lg:row-span-2 lg:row-start-1 lg:flex ${c.aside} ${
          collapsed ? 'w-shell-rail' : c.asideWidth
        }`}
      >
        {/*
          The platform mark and the console's name, with the collapse control beside them.
          `aria-expanded`, not `aria-pressed`: it opens and closes the sidebar's labels, and the
          admin list pages find their group chips as `button[aria-pressed]`.
        */}
        <div
          className={`flex shrink-0 border-b ${c.asideBorder} ${
            collapsed
              ? 'flex-col items-center gap-1 px-2 py-3'
              : `h-shell-topbar items-center justify-between gap-2 pr-3 ${desk ? 'pl-4' : 'pl-5'}`
          }`}
        >
          <Link
            href={home}
            aria-label={collapsed ? `ETicketsGo ${brand}, home` : undefined}
            className={`flex min-w-0 items-center gap-2.5 rounded-md ${navFocus}`}
          >
            {desk ? (
              collapsed ? (
                <span
                  aria-hidden
                  className="flex h-8 w-8 items-center justify-center rounded-brand-control bg-brand-ink font-brand-display text-brand-ui font-extrabold text-brand-canvas"
                >
                  E
                </span>
              ) : (
                // Stacked, so the console's name is never truncated beside the collapse control.
                <span className="flex min-w-0 flex-col gap-1 leading-none">
                  <DeskWordmark />
                  <span className="truncate text-brand-eyebrow uppercase text-brand-ink-3">
                    {brand}
                  </span>
                </span>
              )
            ) : (
              <>
                {renderMark ? (
                  renderMark('h-8 w-8 shrink-0')
                ) : (
                  <LogoMark variant="compact" id="etg-sidebar" className="h-8 w-8 shrink-0" />
                )}
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
              </>
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
                className={`flex h-9 w-9 shrink-0 items-center justify-center transition-colors duration-150 ${c.collapse} ${navFocus}`}
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
          className={`min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-4 [scrollbar-width:thin] ${c.navScroll} ${
            collapsed ? 'px-2 pt-3' : `px-3 ${desk ? 'pt-4' : 'pt-3'}`
          }`}
        >
          {desk && sidebarNotice && (
            <DeskNotice notice={sidebarNotice} compact={collapsed} pathname={pathname} />
          )}
          {collapsed ? (
            <NavRail items={items} pathname={pathname} appearance={appearance} />
          ) : (
            <NavTree items={items} pathname={pathname} appearance={appearance} />
          )}
        </nav>
      </aside>

      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            className={`fixed inset-0 z-40 lg:hidden ${c.overlay}`}
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
              className={`flex h-full w-[min(20rem,86vw)] flex-col pt-[env(safe-area-inset-top)] ${c.drawer}`}
              onClick={(e) => e.stopPropagation()}
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            >
              <div
                className={`flex items-center justify-between gap-2 border-b py-2 pl-4 pr-2 ${c.asideBorder}`}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  {desk ? (
                    <span className="min-w-0 truncate text-brand-body font-semibold text-brand-ink">
                      {workspace?.name.trim() ? workspace.name : `ETicketsGo ${brand}`}
                    </span>
                  ) : (
                    <>
                      {renderMark ? (
                        renderMark('h-7 w-7 shrink-0')
                      ) : (
                        <LogoMark variant="compact" id="etg-drawer" className="h-7 w-7 shrink-0" />
                      )}
                      <span className="min-w-0 truncate font-display font-semibold text-white">
                        {workspace?.name.trim() ? workspace.name : `ETicketsGo ${brand}`}
                      </span>
                    </>
                  )}
                </span>
                <button
                  type="button"
                  onClick={closeMobile}
                  aria-label="Close navigation"
                  className={`flex h-11 w-11 shrink-0 items-center justify-center ${c.collapse} ${navFocus}`}
                >
                  <X className="h-5 w-5" aria-hidden />
                </button>
              </div>
              {drawerAccessory && (
                /*
                  On a surface card, not on the navy: an accessory is the app's own control in
                  the console's ordinary colours, which are solved against a light surface.
                */
                <div className={`mx-3 mt-3 ${c.drawerAccessory}`}>{drawerAccessory}</div>
              )}
              <div className="px-3 pt-3">
                <QuickNavTrigger onOpen={openQuick} tone={desk ? 'desk' : 'nav'} />
              </div>
              <nav
                aria-label={navLabel}
                className="flex-1 overflow-y-auto px-3 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-3 [scrollbar-width:thin]"
              >
                {desk && sidebarNotice && (
                  <DeskNotice notice={sidebarNotice} pathname={pathname} onNavigate={closeMobile} />
                )}
                <NavTree
                  items={items}
                  pathname={pathname}
                  onNavigate={closeMobile}
                  appearance={appearance}
                />
              </nav>
            </motion.aside>
          </motion.div>
        )}
      </AnimatePresence>

      <QuickNav items={items} open={quickOpen} onClose={closeQuick} />

      <main
        id="main"
        tabIndex={-1}
        className={`min-w-0 py-6 focus:outline-none lg:col-start-2 lg:row-start-2 lg:py-8 ${
          desk ? 'px-4 md:px-8' : 'px-4 sm:px-6 xl:px-8'
        }`}
      >
        <div className={`mx-auto ${width === 'fluid' ? 'max-w-screen-2xl' : 'max-w-7xl'}`}>
          {children}
        </div>
      </main>
    </div>
  );
}

/** The sidebar notice, expanded (words and a thin progress bar) or as a rail icon. */
function DeskNotice({
  notice,
  compact = false,
  pathname,
  onNavigate,
}: {
  notice: ShellNotice;
  compact?: boolean;
  pathname: string;
  onNavigate?: () => void;
}) {
  const Icon = notice.icon;
  const here = pathname === notice.href;
  if (compact) {
    return (
      <div className="mb-2 flex justify-center border-b border-brand-line pb-2">
        <RailTip label={notice.detail ? `${notice.label}, ${notice.detail}` : notice.label}>
          {(tip) => (
            <Link
              href={notice.href}
              aria-label={notice.detail ? `${notice.label}, ${notice.detail}` : notice.label}
              aria-current={here ? 'page' : undefined}
              {...tip}
              className={`flex h-10 w-10 items-center justify-center rounded-brand-control border border-brand-line bg-brand-surface text-brand-ink transition-colors duration-150 hover:bg-brand-sunken ${DESK_RING}`}
            >
              <Icon className="h-[1.125rem] w-[1.125rem]" aria-hidden />
            </Link>
          )}
        </RailTip>
      </div>
    );
  }
  const pct = Math.round(Math.min(1, Math.max(0, notice.progress ?? 0)) * 100);
  // Two short lines and a hairline of progress: it must not push the list into a scroll.
  return (
    <Link
      href={notice.href}
      onClick={onNavigate}
      aria-current={here ? 'page' : undefined}
      className={`mb-3 flex flex-col gap-1.5 rounded-brand-control border border-brand-line bg-brand-surface px-3 py-2 transition-colors duration-150 hover:border-brand-line-strong ${DESK_RING}`}
    >
      <span className="flex min-w-0 items-center gap-3">
        <Icon className="h-[1.125rem] w-[1.125rem] shrink-0 text-brand-ink" aria-hidden />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-brand-ui font-semibold text-brand-ink">
            {notice.label}
          </span>
          {notice.detail && (
            <span className="truncate text-brand-meta tabular-nums text-brand-ink-2">
              {notice.detail}
            </span>
          )}
        </span>
      </span>
      {notice.progress !== undefined && (
        <span aria-hidden className="h-1 w-full overflow-hidden rounded-full bg-brand-sunken">
          <span className="block h-full rounded-full bg-brand-ink" style={{ width: `${pct}%` }} />
        </span>
      )}
    </Link>
  );
}

/** The brand wordmark: the name in the display face and the one marigold dot. */
function DeskWordmark() {
  return (
    <span className="inline-flex items-baseline whitespace-nowrap font-brand-display text-[1.25rem] font-extrabold leading-none tracking-tight text-brand-ink">
      ETicketsGo
      <span aria-hidden className="ml-0.5 inline-block h-2 w-2 rounded-full bg-brand-marigold" />
    </span>
  );
}

/** The desk's focus ring: the brand focus colour, offset from the paper. */
const DESK_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-focus focus-visible:ring-offset-2 focus-visible:ring-offset-brand-canvas';

/** The class strings each appearance paints the frame with. Structure is shared. */
const CLASSIC = {
  root: 'bg-background-canvas',
  header: 'border-border bg-background-surface',
  iconButton: 'rounded-md text-text-secondary hover:bg-background-subtle hover:text-text-primary',
  monogram: 'rounded-md bg-tint-primary font-display text-micro font-bold text-action-primary',
  mastheadName:
    'font-display text-[0.9375rem] font-bold tracking-tight text-text-primary sm:text-[1.0625rem]',
  divider: 'bg-border',
  avatar: 'bg-tint-primary text-[0.8125rem] font-semibold text-action-primary',
  accountName: 'text-ui font-semibold text-text-primary',
  accountRole: 'text-micro text-text-muted',
  aside: 'bg-nav text-nav-foreground',
  asideWidth: 'w-shell-sidebar',
  asideBorder: 'border-nav-border',
  collapse: 'rounded-md text-nav-muted hover:bg-nav-hover hover:text-white',
  navScroll: '[scrollbar-color:hsl(var(--nav-border))_transparent]',
  overlay: 'bg-black/50',
  drawer: 'bg-nav text-nav-foreground shadow-lg',
  drawerAccessory: 'overflow-hidden rounded-md bg-background-surface text-text-primary',
} as const;

const DESK: Record<keyof typeof CLASSIC, string> = {
  root: 'bg-brand-canvas font-brand-text text-brand-ink',
  header: 'border-brand-line bg-brand-canvas',
  iconButton:
    'rounded-brand-control text-brand-ink-2 transition-colors duration-150 hover:bg-brand-sunken hover:text-brand-ink',
  monogram:
    'rounded-brand-control bg-brand-ink font-brand-display text-[0.8125rem] font-bold text-brand-canvas',
  mastheadName: 'text-brand-ui font-semibold text-brand-ink sm:text-brand-body sm:font-semibold',
  divider: 'bg-brand-line',
  avatar: 'border border-brand-line bg-brand-surface text-brand-meta font-semibold text-brand-ink',
  accountName: 'text-brand-ui font-semibold text-brand-ink',
  accountRole: 'text-brand-meta text-brand-ink-3',
  // 232px: the specimen's sidebar; the page gets the rest of a 1024px laptop.
  aside: 'border-r border-brand-line bg-brand-canvas text-brand-ink',
  asideWidth: 'w-[14.5rem]',
  asideBorder: 'border-brand-line',
  collapse: 'rounded-brand-control text-brand-ink-3 hover:bg-brand-sunken hover:text-brand-ink',
  navScroll: '[scrollbar-color:hsl(var(--brand-line-strong))_transparent]',
  overlay: 'bg-brand-scrim/50',
  drawer: 'border-r border-brand-line bg-brand-canvas text-brand-ink shadow-brand-overlay',
  // The desk's accessories are drawn in its own tokens, so they need no card of their own.
  drawerAccessory: '',
};

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
