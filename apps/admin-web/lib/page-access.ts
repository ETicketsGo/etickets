import { ADMIN_NAV, allNavLinks, type AdminNavGroup } from './admin-nav';

/**
 * Whether the signed-in operator may open the admin page at a path, decided from the menu.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────
 * The menu hides a link the operator holds no duty for, but a typed or bookmarked URL still
 * opened the page. Its data request was refused (403, nothing leaked) and the page said "We
 * couldn't load this. Please try again." with a Try again button that could never work. The
 * layout now asks this first and shows a plain "you do not have access" panel instead.
 *
 * ── HOW ────────────────────────────────────────────────────────────────────────────
 * The page belongs to the LONGEST menu link whose href is the path or a prefix of it, so a
 * detail page (`/admin/refunds/abc`) needs what its list needs, and a manager-only page inside
 * a section (`/admin/acquisition/team`) needs its own link's capabilities, not the section's.
 * `exact` is ignored here: it says where the menu marks "you are here", not who may enter.
 * A path no link with a requirement covers is allowed - the dashboard and Account security
 * need no duty, and nobody may be locked out of their own sign-in security.
 *
 * ── THIS IS NOT THE AUTHORIZATION ──────────────────────────────────────────────────
 * The API refuses the request either way. A super admin is sent every capability by
 * `/auth/me`; the role is also honoured here so a gap in that list can never lock them out.
 */

export interface PageViewer {
  roles?: readonly string[];
  adminPermissions?: readonly string[];
}

/**
 * Pages under `app/admin` that no menu link covers and that every operator may open. Empty
 * today: every page is a menu link or sits under one. `page-access.test.ts` fails when a new
 * page is neither, so the choice is made on purpose and not by falling through to "allowed".
 */
export const ALWAYS_ALLOWED_ROUTES: readonly string[] = [];

function covers(href: string, pathname: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The menu link a path belongs to (longest matching href), or null. */
export function owningLinkHref(pathname: string, nav: AdminNavGroup[] = ADMIN_NAV): string | null {
  let best: string | null = null;
  for (const link of allNavLinks(nav)) {
    if (covers(link.href, pathname) && (!best || link.href.length > best.length)) {
      best = link.href;
    }
  }
  return best;
}

/** Every capability the page at this path needs (all of them); empty when it needs none. */
export function capabilitiesForPath(pathname: string, nav: AdminNavGroup[] = ADMIN_NAV): string[] {
  const href = owningLinkHref(pathname, nav);
  if (!href) return [];
  const link = allNavLinks(nav).find((l) => l.href === href);
  if (!link?.needs) return [];
  return [link.needs, ...(link.alsoNeeds ?? [])];
}

/** Whether this viewer may open the admin page at this path. */
export function pageAllowed(
  pathname: string,
  viewer: PageViewer | null | undefined,
  nav: AdminNavGroup[] = ADMIN_NAV,
): boolean {
  if (viewer?.roles?.includes('SUPER_ADMIN')) return true;
  if (ALWAYS_ALLOWED_ROUTES.some((r) => covers(r, pathname))) return true;
  const needed = capabilitiesForPath(pathname, nav);
  if (needed.length === 0) return true;
  const held = new Set(viewer?.adminPermissions ?? []);
  return needed.every((c) => held.has(c));
}
