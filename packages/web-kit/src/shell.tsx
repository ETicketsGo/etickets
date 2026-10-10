'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { LogOut, Menu, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
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
import { visibleNav, type NavItem } from './nav';
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
 * Responsive console shell: header, the shared sidebar, the phone drawer and quick navigation.
 *
 * ── ONE SHELL FOR BOTH CONSOLES ────────────────────────────────────────────────────
 * Admin used to have its own frame because this one could not fold groups or step aside for
 * a wide screen. It can now, so both consoles are this component and behave identically:
 * folding groups (only the current one open), a rail of named group buttons with tooltips and
 * flyouts, Ctrl/Cmd+K quick navigation, a sticky sidebar that never adds a second scroll
 * for the page, and the drawer on a phone. See `sidebar-nav.tsx`.
 *
 * ── WHOSE HEADER IS IT ─────────────────────────────────────────────────────────────
 * An organizer spends their working day in here. `workspace` puts the organization's own
 * name and logo in the CENTRE, where a masthead belongs, and the platform mark steps back to
 * a small attribution on the left. Omit `workspace` and the platform mark leads, which is what
 * admin does: there is no organization there whose masthead it could be.
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
  navLabel = 'Main',
  drawerLabel = 'Navigation',
  width = 'contained',
  children,
}: {
  brand: string;
  nav: NavItem[];
  /** The organization this workspace belongs to. Its name is the masthead. */
  workspace?: { name: string; logoUrl?: string | null };
  /** Rendered beside the user menu — a theme switch, an org switcher. */
  headerAccessory?: ReactNode;
  /** Rendered at the top of the phone drawer, for a control the narrow header has no room for. */
  drawerAccessory?: ReactNode;
  /** The accessible name of the navigation landmark ("Main" for organizers, "Admin"). */
  navLabel?: string;
  /** The accessible name of the phone drawer. */
  drawerLabel?: string;
  /**
   * How the frame uses a wide screen.
   *
   * 'contained' (the default) centres the content in a 1280px column. 'fluid' lets the
   * content take the rest of the row, up to 1536px: an organizer's tables and seat maps were
   * wrapping event names onto three lines at 1440 while canvas sat empty either side.
   *
   * It is a ceiling, not a target. Each page still decides its own measure.
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

  return (
    <div className="min-h-dvh bg-background-canvas">
      <header className="sticky top-0 z-30 border-b border-border bg-background-surface pt-[env(safe-area-inset-top)]">
        {/*
          A fixed 4rem row from `lg` up, because the sidebar below is pinned to the space
          under it and has to know exactly how tall it is.
        */}
        <div className="relative flex min-h-[3.75rem] items-center justify-between gap-2 px-4 py-2 lg:h-16 lg:px-6 lg:py-0">
          {/*
            `min-w-0` is load-bearing: a flex child will not shrink below its content width
            without it, so `truncate` on the workspace name would do nothing and the header
            would push the page sideways at 320px.
          */}
          <div className="flex min-w-0 items-center gap-3">
            <button
              ref={menuButton}
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-background-subtle lg:hidden ${FOCUS}`}
              aria-label="Toggle navigation"
              aria-expanded={mobileOpen}
              aria-haspopup="dialog"
              onClick={() => setMobileOpen((o) => !o)}
            >
              <Menu className="h-5 w-5" aria-hidden />
            </button>
            {workspace ? (
              // Attribution, not branding: small, muted, and still a link home.
              <Link
                href={home}
                className={`hidden shrink-0 items-center gap-1.5 rounded-sm text-caption font-medium text-text-muted transition-colors hover:text-text-secondary sm:flex ${FOCUS}`}
              >
                <span className="tracking-tight">
                  ETickets<span className="text-action-primary">Go</span>
                </span>
                <span aria-hidden>·</span>
                <span>{brand}</span>
              </Link>
            ) : (
              <Link
                href={home}
                className={`flex min-w-0 items-center gap-2 rounded-sm font-bold text-text-primary ${FOCUS}`}
              >
                <span className="font-display text-[1.0625rem] tracking-tight">
                  ETickets<span className="text-action-primary">Go</span>
                </span>
                <span className="rounded-full bg-background-subtle px-2 py-0.5 text-caption font-medium text-text-muted">
                  {brand}
                </span>
              </Link>
            )}
            {workspace && (
              /*
                THE PHONE'S COPY OF THE MASTHEAD. It flows after the hamburger and truncates,
                so it cannot reach a control (`shell-header-overlap.spec.ts`).
              */
              <span
                data-testid="workspace-name"
                className="truncate font-display text-[0.9375rem] font-bold tracking-tight text-text-primary sm:hidden"
              >
                {workspace.name}
              </span>
            )}
          </div>

          {/*
            The masthead, centred in the HEADER with absolute positioning from `sm` up, and
            click-through all the way down: it is a label, and on a narrow screen the centre is
            where the controls are (`masthead-does-not-block-controls.spec.ts`).
          */}
          {workspace && (
            <div className="pointer-events-none absolute inset-x-0 hidden justify-center sm:flex">
              <div className="flex max-w-[min(50vw,28rem)] items-center gap-2.5">
                {apiAssetUrl(workspace.logoUrl ?? null) && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={apiAssetUrl(workspace.logoUrl ?? null)!}
                    alt=""
                    className="h-7 w-7 shrink-0 rounded-md object-cover"
                  />
                )}
                <span
                  data-testid="workspace-name"
                  className="truncate font-display text-[1.0625rem] font-bold tracking-tight text-text-primary"
                  title={workspace.name}
                >
                  {workspace.name}
                </span>
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 sm:gap-3">
            {headerAccessory}
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
              className={`flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-[0.8125rem] font-medium text-text-secondary transition-colors hover:bg-background-subtle hover:text-text-primary ${FOCUS}`}
            >
              <LogOut className="h-3.5 w-3.5" aria-hidden />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </header>

      <div className="flex">
        {/*
          ── THE SIDEBAR ─────────────────────────────────────────────────────────────────
          Pinned under the header, full height. The PAGE is the one thing that scrolls: the
          sidebar's groups start folded except the current one, so it fits a 768px-tall
          laptop, and on a shorter window only its list scrolls - with a thin scrollbar, and
          with the search field and the collapse button pinned in view above and below.

          `z-20` because a sticky element is a stacking context of its own: without it the rail's
          flyouts and tooltips, however high their own z-index, painted UNDER any positioned card
          in the page beside it. Below the header (30) and the phone drawer (40).
        */}
        <aside
          aria-label="Sidebar"
          className={`sticky top-16 z-20 hidden h-[calc(100dvh-4rem)] shrink-0 flex-col border-r border-border bg-background-surface transition-[width] duration-200 ease-premium motion-reduce:transition-none lg:flex ${
            collapsed ? 'w-[4.5rem]' : 'w-[16.5rem]'
          }`}
        >
          {/*
            The search field and the collapse control share the top row. The control used to sit
            in a footer of its own, which cost the list 60px - the difference between the admin
            menu fitting a 768px-tall window and scrolling inside it.

            `aria-expanded`, not `aria-pressed`: it opens and closes the sidebar's labels, and
            the admin list pages find their group chips as `button[aria-pressed]`.
          */}
          <div
            className={`flex gap-1.5 pb-2 pt-3 ${collapsed ? 'flex-col items-center px-2' : 'items-center px-3'}`}
          >
            {!collapsed && (
              <div className="min-w-0 flex-1">
                <QuickNavTrigger onOpen={openQuick} />
              </div>
            )}
            <RailTip label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
              {(tip) => (
                <button
                  type="button"
                  onClick={toggleCollapsed}
                  aria-expanded={!collapsed}
                  aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                  {...tip}
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors duration-150 hover:bg-background-subtle hover:text-text-primary ${FOCUS}`}
                >
                  {collapsed ? (
                    <PanelLeftOpen className="h-[1.125rem] w-[1.125rem]" aria-hidden />
                  ) : (
                    <PanelLeftClose className="h-[1.125rem] w-[1.125rem]" aria-hidden />
                  )}
                </button>
              )}
            </RailTip>
            {collapsed && <QuickNavTrigger onOpen={openQuick} compact />}
          </div>
          <nav
            aria-label={navLabel}
            className={`min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-3 pt-1 [scrollbar-color:hsl(var(--border-strong))_transparent] [scrollbar-width:thin] ${
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
              className="fixed inset-0 z-40 bg-black/40 lg:hidden"
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
                className="flex h-full w-[min(20rem,86vw)] flex-col border-r border-border bg-background-surface pt-[env(safe-area-inset-top)] shadow-lg"
                onClick={(e) => e.stopPropagation()}
                initial={{ x: '-100%' }}
                animate={{ x: 0 }}
                exit={{ x: '-100%' }}
                transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              >
                <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
                  <span className="min-w-0 truncate font-display font-semibold text-text-primary">
                    {workspace?.name.trim() ? workspace.name : brand}
                  </span>
                  <button
                    type="button"
                    onClick={closeMobile}
                    aria-label="Close navigation"
                    className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-background-subtle ${FOCUS}`}
                  >
                    <X className="h-5 w-5" aria-hidden />
                  </button>
                </div>
                {drawerAccessory}
                <div className="px-3 pt-3">
                  <QuickNavTrigger onOpen={openQuick} />
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

        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <div className={`mx-auto ${width === 'fluid' ? 'max-w-screen-2xl' : 'max-w-7xl'}`}>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

/**
 * The top of every console page: where you are, what this page is for, and its main action.
 *
 * `eyebrow` is a short context line above the title - the organization a dashboard belongs
 * to, the event a sub-page is about. `meta` sits under the description for facts about the
 * page as a whole (a status badge, a date range). Both are optional, and a page that passes
 * neither renders exactly the shape it always did.
 *
 * The title is the page's only <h1>. The actions wrap under it on a phone rather than
 * squeezing it: a heading broken over four lines to keep a button beside it is the wrong
 * trade on a 320px screen.
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
    <div className="mb-8">
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
            <p className="mb-1.5 text-caption font-semibold text-action-primary">{eyebrow}</p>
          )}
          <h1 className="text-balance break-words font-display text-h2 font-bold tracking-tight text-text-primary">
            {title}
          </h1>
          {description && (
            <p className="mt-2 text-[0.9375rem] text-text-secondary">{description}</p>
          )}
          {meta && <div className="mt-3 flex flex-wrap items-center gap-2">{meta}</div>}
        </div>
        {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
      </div>
    </div>
  );
}
