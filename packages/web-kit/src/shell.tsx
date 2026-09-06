'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { LogOut, Menu, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useAuthUser, useLogout } from './hooks';

export interface NavItem {
  label: string;
  href: string;
  /** Roles allowed to see this item; omit for all authenticated users. */
  roles?: string[];
  exact?: boolean;
  icon?: LucideIcon;
  /**
   * Starts a labelled group, rendered above this item.
   *
   * Grouping rather than hiding. The organizer sidebar reached sixteen items, several of
   * which are irrelevant to any one organizer — a concert promoter never shows a film. The
   * tempting fix is to hide what an organization has not used yet, but that is exactly how
   * seat maps went undiscovered: you cannot find the section that would let you start.
   *
   * A heading says "this is a separate concern, skip it if it is not yours" while leaving
   * it findable, which is the honest version of the same idea.
   */
  group?: string;
}

function isActive(pathname: string, href: string, exact?: boolean): boolean {
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
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
  children,
}: {
  brand: string;
  nav: NavItem[];
  /** The organization this workspace belongs to. Its name is the masthead. */
  workspace?: { name: string; logoUrl?: string | null };
  /** Rendered beside the user menu — a theme switch, an org switcher. */
  headerAccessory?: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const logout = useLogout();
  const { user } = useAuthUser();
  const [mobileOpen, setMobileOpen] = useState(false);

  const items = nav.filter(
    (n) => !n.roles || (user && user.roles.some((r) => n.roles!.includes(r))),
  );

  const NavLinks = () => (
    <nav className="space-y-0.5">
      {items.map((item) => {
        const active = isActive(pathname, item.href, item.exact);
        const Icon = item.icon;
        return (
          <div key={item.href}>
            {item.group && (
              <p className="px-3 pb-1 pt-4 text-caption font-semibold uppercase tracking-wide text-text-muted">
                {item.group}
              </p>
            )}
            <Link
              href={item.href}
              onClick={() => setMobileOpen(false)}
              aria-current={active ? 'page' : undefined}
              className={`flex min-h-[2.75rem] items-center gap-2.5 rounded-md px-3 py-2 text-[0.9375rem] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 lg:min-h-0 ${
                active
                  ? 'bg-tint-primary font-semibold text-action-primary'
                  : 'text-text-secondary hover:bg-background-subtle hover:text-text-primary'
              }`}
            >
              {Icon && <Icon className="h-4 w-4" />}
              {item.label}
            </Link>
          </div>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-dvh bg-background-canvas">
      <header className="sticky top-0 z-30 border-b border-border bg-background-surface/80 pt-[env(safe-area-inset-top)] backdrop-blur-md">
        <div className="relative flex items-center justify-between px-4 py-3 lg:px-6">
          <div className="flex items-center gap-3">
            <button
              className="flex h-11 w-11 items-center justify-center rounded-md text-text-secondary hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 lg:hidden"
              aria-label="Toggle navigation"
              aria-expanded={mobileOpen}
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
          </div>

          {/*
            The masthead.

            Centred with absolute positioning rather than by being the middle flex child: the
            two sides have different widths — a user's name is not the width of a menu button —
            so a flex centre would sit wherever those happened to leave it, drifting as the
            signed-in name changed. Absolute centring puts it in the middle of the HEADER,
            which is what "centre aligned" means to the person looking at it.

            `pointer-events-none` on the wrapper so an invisible band across the header cannot
            swallow clicks meant for the controls behind it.
          */}
          {workspace && (
            <div className="pointer-events-none absolute inset-x-0 flex justify-center">
              <div className="pointer-events-auto flex max-w-[min(50vw,28rem)] items-center gap-2.5">
                {workspace.logoUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={workspace.logoUrl}
                    alt=""
                    className="h-7 w-7 shrink-0 rounded-md object-cover"
                  />
                )}
                <span
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

      <div className="mx-auto flex max-w-7xl gap-8 px-4 py-8 lg:px-6">
        <aside className="hidden w-56 shrink-0 lg:block">
          <div className="sticky top-24">
            <NavLinks />
          </div>
        </aside>

        <AnimatePresence>
          {mobileOpen && (
            <motion.div
              className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm lg:hidden"
              onClick={() => setMobileOpen(false)}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <motion.aside
                className="h-full w-72 border-r border-border bg-background-surface p-4"
                onClick={(e) => e.stopPropagation()}
                initial={{ x: '-100%' }}
                animate={{ x: 0 }}
                exit={{ x: '-100%' }}
                transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
              >
                <NavLinks />
              </motion.aside>
            </motion.div>
          )}
        </AnimatePresence>

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  action,
  breadcrumbs,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  breadcrumbs?: { label: string; href?: string }[];
}) {
  return (
    <div className="mb-8">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav
          aria-label="Breadcrumb"
          className="mb-2 flex flex-wrap items-center gap-1.5 text-caption text-text-muted"
        >
          {breadcrumbs.map((b, i) => (
            <span key={i} className="flex items-center gap-1.5">
              {b.href ? (
                <Link href={b.href} className="transition-colors hover:text-text-primary">
                  {b.label}
                </Link>
              ) : (
                <span className="text-text-secondary">{b.label}</span>
              )}
              {i < breadcrumbs.length - 1 && <span aria-hidden>/</span>}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-h2 font-bold tracking-tight text-text-primary">{title}</h1>
          {description && <p className="mt-1.5 text-[0.9375rem] text-text-muted">{description}</p>}
        </div>
        {action}
      </div>
    </div>
  );
}
