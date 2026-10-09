import type { LucideIcon } from 'lucide-react';

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
  /**
   * Other path prefixes that belong to this item's section.
   *
   * "Venues & seating" is one entry, but the pages behind it live under three prefixes -
   * venues, the spaces inside them and the cinema screens - because the routes predate the
   * merge. Without this, opening a seat map left the sidebar with nothing marked, and the
   * organizer with no answer to "where am I".
   */
  match?: string[];
  /**
   * Secondary pages, listed under this item.
   *
   * The sidebar shows the handful of places an organizer goes every day; everything else
   * still has a way in, one level down, next to the thing it belongs to - Payouts under
   * Finance, Counter under Bookings. Shown when the section is open, and openable by hand.
   */
  children?: NavItem[];
  /**
   * False to stop Next prefetching this link.
   *
   * For a link whose page may not exist in this build - the organizer Calendar is linked
   * before its page lands. A production prefetch of a route that is not there never settled,
   * so every page with the sidebar on screen kept a request open forever, and every e2e
   * test waiting for 'networkidle' on a desktop page timed out.
   */
  prefetch?: boolean;
}

function isActive(pathname: string, href: string, exact?: boolean): boolean {
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

/** The item itself, any of its extra prefixes, or any of its children is the current page. */
export function navInSection(pathname: string, item: NavItem): boolean {
  if (isActive(pathname, item.href, item.exact)) return true;
  if (item.match?.some((m) => isActive(pathname, m))) return true;
  return item.children?.some((c) => navInSection(pathname, c)) ?? false;
}

/**
 * The ONE item that gets `aria-current="page"`.
 *
 * The longest matching href wins, so on /organizer/payouts it is Payouts that is current
 * and not Finance above it - Finance is marked as the open section instead. Two items both
 * claiming to be the current page is what a screen reader would otherwise announce.
 */
export function navCurrentHref(pathname: string, items: NavItem[]): string | null {
  let best: string | null = null;
  const visit = (list: NavItem[]) => {
    for (const item of list) {
      const hit =
        isActive(pathname, item.href, item.exact) ||
        (item.match?.some((m) => isActive(pathname, m)) ?? false);
      if (hit && (!best || item.href.length > best.length)) best = item.href;
      if (item.children) visit(item.children);
    }
  };
  visit(items);
  return best;
}
