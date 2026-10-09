'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, LogOut, Menu, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { useAuthUser, useLogout } from './hooks';
import { apiAssetUrl } from './api';
import { navCurrentHref, navInSection, type NavItem } from './nav';

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

/** Items in their labelled groups. A `group` on an item starts a new one. */
function sectionsOf(items: NavItem[]): { label?: string; items: NavItem[] }[] {
  const sections: { label?: string; items: NavItem[] }[] = [];
  for (const item of items) {
    if (item.group || sections.length === 0) sections.push({ label: item.group, items: [] });
    sections[sections.length - 1].items.push(item);
  }
  return sections;
}

const FOCUSABLE = 'a[href], button:not([disabled])';

/**
 * The navigation itself, shared by the desktop sidebar and the phone drawer.
 *
 * `collapsed` is the icon rail. The labels stay in the DOM as screen-reader text and as a
 * `title`, so the rail is narrower, not anonymous; secondary pages are not listed there,
 * because a nested list of icons with no words is a puzzle, and the section page each one
 * sits under is one click away.
 */
function NavTree({
  items,
  pathname,
  collapsed,
  onNavigate,
}: {
  items: NavItem[];
  pathname: string;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const current = navCurrentHref(pathname, items);
  const [openState, setOpenState] = useState<Record<string, boolean>>({});
  const baseId = useId();

  const link = (item: NavItem, depth: 0 | 1) => {
    const isCurrent = item.href === current;
    const isSection = !isCurrent && depth === 0 && navInSection(pathname, item);
    const Icon = item.icon;
    return (
      <Link
        href={item.href}
        onClick={onNavigate}
        aria-current={isCurrent ? 'page' : undefined}
        title={collapsed ? item.label : undefined}
        className={`group flex min-h-[2.75rem] min-w-0 flex-1 items-center gap-3 rounded-md px-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:min-h-[2.375rem] ${
          depth === 1 ? 'text-[0.875rem]' : 'text-[0.9375rem]'
        } ${collapsed ? 'justify-center px-0' : ''} ${
          isCurrent
            ? 'bg-tint-primary font-semibold text-action-primary'
            : isSection
              ? 'font-semibold text-text-primary hover:bg-background-subtle'
              : 'text-text-secondary hover:bg-background-subtle hover:text-text-primary'
        }`}
      >
        {Icon && depth === 0 && <Icon className="h-[1.125rem] w-[1.125rem] shrink-0" aria-hidden />}
        <span className={collapsed ? 'sr-only' : 'truncate'}>{item.label}</span>
      </Link>
    );
  };

  return (
    <div className="space-y-5">
      {sectionsOf(items).map((section, si) => {
        const headingId = `${baseId}-g${si}`;
        return (
          <div
            key={section.label ?? `s${si}`}
            role="group"
            aria-labelledby={section.label ? headingId : undefined}
          >
            {section.label &&
              (collapsed ? (
                // The rail keeps the grouping as a rule, and the name for assistive technology.
                <p id={headingId} className="mx-3 mb-2 border-t border-border">
                  <span className="sr-only">{section.label}</span>
                </p>
              ) : (
                <p
                  id={headingId}
                  className="px-3 pb-1.5 text-[0.75rem] font-semibold uppercase tracking-[0.06em] text-text-muted"
                >
                  {section.label}
                </p>
              ))}
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const kids = item.children ?? [];
                const hasKids = kids.length > 0 && !collapsed;
                const open = openState[item.href] ?? navInSection(pathname, item);
                const listId = `${baseId}-${item.href.replace(/[^a-z0-9]/gi, '-')}`;
                return (
                  <li key={item.href}>
                    <div className="flex items-center gap-0.5">
                      {link(item, 0)}
                      {hasKids && (
                        <button
                          type="button"
                          aria-expanded={open}
                          aria-controls={listId}
                          aria-label={`${open ? 'Hide' : 'Show'} more ${item.label} pages`}
                          onClick={() => setOpenState((s) => ({ ...s, [item.href]: !open }))}
                          className="flex h-11 w-9 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-background-subtle hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:h-[2.375rem]"
                        >
                          <ChevronDown
                            className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`}
                            aria-hidden
                          />
                        </button>
                      )}
                    </div>
                    {hasKids && open && (
                      <ul
                        id={listId}
                        className="mb-1 ml-[1.4rem] mt-0.5 space-y-0.5 border-l border-border pl-2"
                      >
                        {kids.map((kid) => (
                          <li key={kid.href} className="flex">
                            {link(kid, 1)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

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
 * Responsive dashboard shell with a role-aware sidebar and user menu.
 *
 * ── WHOSE HEADER IS IT ─────────────────────────────────────────────────────────────
 * An organizer spends their working day in here. The header used to say "ETicketsGo ·
 * Organizer" and nothing else, so the answer to "whose software am I using" was, on every
 * screen, ours — which is exactly the third-party-tool feeling this is meant to remove.
 *
 * `workspace` puts the organization's own name and logo in the CENTRE, where a masthead
 * belongs, and the platform mark steps back to a small attribution on the left. Nothing is
 * hidden: the customer-facing product is still ETicketsGo and pretending otherwise would
 * confuse the person who has to raise a support ticket about it. It is a masthead, not a
 * white-label — and the difference is that the attribution stays legible rather than being
 * removed.
 *
 * Omit `workspace` and the shell renders exactly as it did, which is what admin does: there
 * is no organization there whose masthead it could be.
 */
export function AppShell({
  brand,
  nav,
  workspace,
  headerAccessory,
  width = 'contained',
  children,
}: {
  brand: string;
  nav: NavItem[];
  /** The organization this workspace belongs to. Its name is the masthead. */
  workspace?: { name: string; logoUrl?: string | null };
  /** Rendered beside the user menu — a theme switch, an org switcher. */
  headerAccessory?: ReactNode;
  /**
   * How the frame uses a wide screen.
   *
   * 'contained' (the default, and what admin keeps) centres sidebar and content together in
   * a 1280px column. 'fluid' pins the sidebar to the left edge and lets the content take the
   * rest, up to 1536px: an organizer's tables and seat maps were wrapping event names onto
   * three lines at 1440 while 160px of empty canvas sat either side of the frame.
   *
   * It is a ceiling, not a target. Each page still decides its own measure - a form or a
   * page of prose keeps a readable width inside it - so this only stops the FRAME from
   * being the thing that squeezes a table.
   */
  width?: 'contained' | 'fluid';
  children: ReactNode;
}) {
  const pathname = usePathname();
  const logout = useLogout();
  const { user } = useAuthUser();
  const [mobileOpen, setMobileOpen] = useState(false);
  /*
    Read after mount, not during render: the server has no localStorage, and a sidebar that
    rendered collapsed on the server and expanded on the client would be a hydration error.
    The cost is that a collapsed rail opens expanded for one frame on a cold load.
  */
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => setCollapsed(readCollapsed()), []);
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      writeCollapsed(!c);
      return !c;
    });

  const allowed = (n: NavItem) =>
    !n.roles || (!!user && user.roles.some((r) => n.roles!.includes(r)));
  const items = nav
    .filter(allowed)
    .map((n) => (n.children ? { ...n, children: n.children.filter(allowed) } : n));

  /*
    ── THE PHONE DRAWER IS A DIALOG ───────────────────────────────────────────────────
    It covers the page, so it behaves like one: it says so to assistive technology, takes
    focus when it opens, keeps Tab inside itself, closes on Escape, and hands focus back to
    the button that opened it. It used to do none of these, so a keyboard user who opened it
    tabbed straight through it into the page hidden behind the backdrop.
  */
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const closeMobile = useCallback(() => setMobileOpen(false), []);
  useEffect(() => {
    if (!mobileOpen) return;
    const opener = menuButton.current;
    drawer.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
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
    const focusable = Array.from(drawer.current.querySelectorAll<HTMLElement>(FOCUSABLE));
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

  return (
    <div className="min-h-dvh bg-background-canvas">
      <header className="sticky top-0 z-30 border-b border-border bg-background-surface pt-[env(safe-area-inset-top)]">
        {/*
          A fixed 4rem row from `lg` up, because the sidebar below is pinned to the space
          under it and has to know exactly how tall it is. Solid rather than the old
          translucent blur: the brief for these consoles is calm and opaque, and the blur
          was also the containing-block trap that bit the installed storefront.
        */}
        <div className="relative flex min-h-[3.75rem] items-center justify-between gap-2 px-4 py-2 lg:h-16 lg:px-6 lg:py-0">
          {/*
            `min-w-0` is load-bearing, not decoration.

            A flex child will not shrink below its content width without it, so `truncate` on
            the workspace name does nothing and the row simply gets wider than the screen. At
            320px that pushed the header 56px past the viewport and the whole page scrolled
            sideways - which is how moving the name out of absolute positioning traded one
            defect for another.
          */}
          <div className="flex min-w-0 items-center gap-3">
            <button
              ref={menuButton}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
              aria-label="Toggle navigation"
              aria-expanded={mobileOpen}
              aria-haspopup="dialog"
              onClick={() => setMobileOpen((o) => !o)}
            >
              <Menu className="h-5 w-5" />
            </button>
            {workspace ? (
              /*
                Attribution, not branding. Small, muted, and still a link home — somebody who
                needs to say "I am on ETicketsGo" to a support agent can read it, and nobody
                else has to look at it.
              */
              <Link
                href={items[0]?.href ?? '/'}
                className="hidden shrink-0 items-center gap-1.5 text-caption font-medium text-text-muted transition-colors hover:text-text-secondary sm:flex"
              >
                <span className="tracking-tight">
                  ETickets<span className="text-action-primary">Go</span>
                </span>
                <span aria-hidden>·</span>
                <span>{brand}</span>
              </Link>
            ) : (
              <Link
                href={items[0]?.href ?? '/'}
                className="flex items-center gap-2 font-bold text-text-primary"
              >
                <span className="text-[1.05rem] tracking-tight">
                  ETickets<span className="text-action-primary">Go</span>
                </span>
                <span className="rounded-full bg-background-subtle px-2 py-0.5 text-caption font-medium text-text-muted">
                  {brand}
                </span>
              </Link>
            )}
            {workspace && (
              /*
                THE PHONE'S COPY OF THE MASTHEAD.

                The centred one below is absolutely positioned, which is right on a wide
                header and impossible on a narrow one: at 390px the centre of the header IS
                where the controls are, so the name sat on top of the theme switch. It was
                made click-through rather than moved, so the control worked and still looked
                broken.

                Here it flows after the hamburger and truncates, so it cannot reach anything.
                A centred title is worth less on a phone than a header that is not overlapping
                itself.
              */
              <span
                data-testid="workspace-name"
                className="truncate text-[0.9375rem] font-bold tracking-tight text-text-primary sm:hidden"
              >
                {workspace.name}
              </span>
            )}
          </div>

          {/*
            The masthead.

            Centred with absolute positioning rather than by being the middle flex child: the
            two sides have different widths — a user's name is not the width of a menu button —
            so a flex centre would sit wherever those happened to leave it, drifting as the
            signed-in name changed. Absolute centring puts it in the middle of the HEADER,
            which is what "centre aligned" means to the person looking at it.

            SHOWN FROM `sm` UP ONLY. Below that the header is too narrow for a centred label
            to avoid the controls, and the phone gets the flowing copy in the left cluster
            instead. `pointer-events-none` stays on the wrapper regardless, so an invisible
            band across the header cannot swallow clicks meant for the controls behind it.

            ── AND NOT `pointer-events-auto` ON THE INNER BOX EITHER ──────────────────────
            It used to be there, which gave back exactly the bug the line above avoids. The
            wrapper spans the header and is transparent to clicks; the inner box is only as
            wide as the name, but on a narrow screen the centre IS where the controls are.
            Measured on the gate, which is a screen used on a phone by definition:

              320px  the name covered Light, Dark and Match system - all three unclickable
              412px  it covered Light and Dark
              1440px no overlap

            So on a phone the theme control could not be pressed at all. `elementFromPoint`
            at each button's centre returned the name, and a click timed out. It is a label:
            nothing in it is interactive, and it has no business intercepting a press.

            The `title` below only surfaces on hover, which needs pointer events, so it no
            longer shows. That is the right trade - a tooltip for a truncated name is worth
            less than a button that can be pressed - and it is kept because it is also what
            some assistive technology reads for the full name.
          */}
          {workspace && (
            <div className="pointer-events-none absolute inset-x-0 hidden justify-center sm:flex">
              <div className="flex max-w-[min(50vw,28rem)] items-center gap-2.5">
                {apiAssetUrl(workspace.logoUrl ?? null) && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    /*
                      Through `apiAssetUrl`: an uploaded picture is a path on the API, and
                      rendered raw it resolves against the console's own origin and 404s.
                      An absolute URL passes through untouched.
                    */
                    src={apiAssetUrl(workspace.logoUrl ?? null)!}
                    alt=""
                    className="h-7 w-7 shrink-0 rounded-md object-cover"
                  />
                )}
                <span
                  data-testid="workspace-name"
                  className="truncate text-[1.05rem] font-bold tracking-tight text-text-primary"
                  title={workspace.name}
                >
                  {workspace.name}
                </span>
              </div>
            </div>
          )}

          <div className="flex items-center gap-3">
            {headerAccessory}
            {user && (
              <div className="flex items-center gap-2.5">
                <div className="hidden text-right sm:block">
                  <p className="text-[0.8125rem] font-medium leading-tight text-text-primary">
                    {user.fullName}
                  </p>
                  <p className="text-caption leading-tight text-text-muted">{user.email}</p>
                </div>
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-tint-primary text-[0.8125rem] font-semibold text-action-primary">
                  {initials(user.fullName)}
                </div>
              </div>
            )}
            <button
              onClick={logout}
              aria-label="Sign out"
              className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[0.8125rem] font-medium text-text-secondary transition-colors hover:bg-background-subtle hover:text-text-primary"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </header>

      <div className="flex">
        {/*
          ── THE SIDEBAR ─────────────────────────────────────────────────────────────────
          Pinned to the left edge under the header, full height, scrolling on its own. It
          used to float inside the content column at whatever offset the page padding left
          it, so it moved when the frame width changed and scrolled away with a long page.

          Collapsible to an icon rail for somebody who wants the width for a seat map or a
          wide table - remembered per device. The toggle is at the foot of the rail, not in
          the header, because the header is already where the masthead has to avoid the
          controls (see `shell-header-overlap.spec.ts`).
        */}
        <aside
          aria-label="Sidebar"
          className={`sticky top-16 hidden h-[calc(100dvh-4rem)] shrink-0 flex-col border-r border-border bg-background-surface transition-[width] duration-200 ease-premium lg:flex ${
            collapsed ? 'w-[4.5rem]' : 'w-[17.5rem]'
          }`}
        >
          <nav aria-label="Main" className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-5">
            <NavTree items={items} pathname={pathname} collapsed={collapsed} />
          </nav>
          <div className="border-t border-border p-3">
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className={`flex h-9 w-full items-center gap-2 rounded-md px-3 text-caption font-medium text-text-muted transition-colors hover:bg-background-subtle hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                collapsed ? 'justify-center px-0' : ''
              }`}
            >
              {collapsed ? (
                <PanelLeftOpen className="h-4 w-4" aria-hidden />
              ) : (
                <>
                  <PanelLeftClose className="h-4 w-4" aria-hidden />
                  <span>Collapse</span>
                </>
              )}
            </button>
          </div>
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
                aria-label="Navigation"
                onKeyDown={trapTab}
                className="flex h-full w-[min(20rem,86vw)] flex-col border-r border-border bg-background-surface pt-[env(safe-area-inset-top)] shadow-lg"
                onClick={(e) => e.stopPropagation()}
                initial={{ x: '-100%' }}
                animate={{ x: 0 }}
                exit={{ x: '-100%' }}
                transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              >
                <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
                  <span className="min-w-0 truncate font-semibold text-text-primary">
                    {workspace?.name.trim() ? workspace.name : brand}
                  </span>
                  <button
                    type="button"
                    onClick={closeMobile}
                    aria-label="Close navigation"
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X className="h-5 w-5" aria-hidden />
                  </button>
                </div>
                <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 py-4">
                  <NavTree
                    items={items}
                    pathname={pathname}
                    collapsed={false}
                    onNavigate={closeMobile}
                  />
                </nav>
              </motion.aside>
            </motion.div>
          )}
        </AnimatePresence>

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
          <h1 className="break-words text-h2 font-bold tracking-tight text-text-primary">
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
