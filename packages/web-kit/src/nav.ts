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
   * Back-office capabilities the page's own data needs, ALL of them, as `AdminPermission`
   * names. The API's guard requires every listed capability, so this does too.
   *
   * A link to a page that answers "you may not see this" is a door painted on a wall. The
   * admin menu listed all twenty-five pages to every operator, so a moderator met a refusal
   * on half of them. This is what hides those: it mirrors the server's guard, it is never the
   * guard - the route still refuses whoever types the URL.
   */
  capabilities?: string[];
  /**
   * The icon the collapsed rail shows for the group this item starts. Only read on an item
   * that has `group`; without one the rail uses the group's first item's icon.
   */
  groupIcon?: LucideIcon;
  /** Other words somebody might type into quick navigation to find this page. */
  keywords?: string[];
}

/** Who is looking: their roles and, for platform staff, their back-office capabilities. */
export interface NavViewer {
  roles: string[];
  adminPermissions?: string[];
}

/** Whether this viewer may open the item's page, by role and by capability. */
export function navAllowed(item: NavItem, viewer: NavViewer | null | undefined): boolean {
  if (item.roles && !(viewer && viewer.roles.some((r) => item.roles!.includes(r)))) return false;
  if (item.capabilities && item.capabilities.length > 0) {
    const held = new Set(viewer?.adminPermissions ?? []);
    if (!item.capabilities.every((c) => held.has(c))) return false;
  }
  return true;
}

/**
 * The nav this viewer may use: forbidden items removed, at every level.
 *
 * A section the viewer cannot open is removed with its children, and a group whose items are
 * all gone takes its heading with it. When only a group's FIRST item goes, the heading moves
 * to the next item that survives, so the rest keep their place under the right name.
 */
export function visibleNav(items: NavItem[], viewer: NavViewer | null | undefined): NavItem[] {
  const out: NavItem[] = [];
  let pendingGroup: Pick<NavItem, 'group' | 'groupIcon'> | null = null;
  for (const item of items) {
    if (item.group) pendingGroup = { group: item.group, groupIcon: item.groupIcon };
    if (!navAllowed(item, viewer)) continue;
    const children = item.children?.filter((c) => navAllowed(c, viewer));
    const next: NavItem = { ...item, children: children && children.length ? children : undefined };
    if (pendingGroup) {
      next.group = pendingGroup.group;
      next.groupIcon = pendingGroup.groupIcon;
      pendingGroup = null;
    } else {
      delete next.group;
      delete next.groupIcon;
    }
    out.push(next);
  }
  return out;
}

export interface NavSection {
  /** Undefined for items listed before any heading. */
  label?: string;
  icon?: LucideIcon;
  items: NavItem[];
}

/** Items in their labelled groups. A `group` on an item starts a new one. */
export function navSections(items: NavItem[]): NavSection[] {
  const sections: NavSection[] = [];
  for (const item of items) {
    if (item.group || sections.length === 0)
      sections.push({ label: item.group, icon: item.groupIcon ?? item.icon, items: [] });
    sections[sections.length - 1].items.push(item);
  }
  return sections;
}

/** The index of the section holding the current page, or -1. */
export function activeSectionIndex(pathname: string, sections: NavSection[]): number {
  const current = navCurrentHref(
    pathname,
    sections.flatMap((s) => s.items),
  );
  if (!current) return -1;
  const holds = (list: NavItem[]): boolean =>
    list.some((i) => i.href === current || holds(i.children ?? []));
  return sections.findIndex((s) => holds(s.items));
}

/** One place quick navigation can take you. */
export interface QuickNavEntry {
  label: string;
  href: string;
  /** Where it sits, for the result line: "Business / Finance & payouts". */
  trail: string;
  icon?: LucideIcon;
  keywords: string[];
}

/** Every page in the nav as a flat list, in menu order, with where each one sits. */
export function quickNavEntries(items: NavItem[]): QuickNavEntry[] {
  const out: QuickNavEntry[] = [];
  for (const section of navSections(items)) {
    for (const item of section.items) {
      out.push({
        label: item.label,
        href: item.href,
        trail: section.label ?? '',
        icon: item.icon,
        keywords: item.keywords ?? [],
      });
      for (const kid of item.children ?? []) {
        out.push({
          label: kid.label,
          href: kid.href,
          trail: [section.label, item.label].filter(Boolean).join(' / '),
          icon: kid.icon ?? item.icon,
          keywords: kid.keywords ?? [],
        });
      }
    }
  }
  return out;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Quick navigation's matches for what was typed, best first.
 *
 * Every word typed has to appear somewhere - the label, the group it sits in or one of its
 * keywords - so "pay conf" finds Payment config and not Payouts. Ranked by where the first
 * word landed: the start of the label, then the start of any word in it, then anywhere in
 * the label, then only in its group or keywords; ties keep menu order, which is the order
 * people learn. An empty query lists everything, so the dialog doubles as a map.
 *
 * It searches only what it is given, and the shell gives it the nav AFTER `visibleNav`, so a
 * page the viewer cannot open is not something they can find here either.
 */
export function filterQuickNav(entries: QuickNavEntry[], query: string): QuickNavEntry[] {
  const words = norm(query).split(' ').filter(Boolean);
  if (words.length === 0) return entries;
  const scored: { e: QuickNavEntry; score: number; i: number }[] = [];
  entries.forEach((e, i) => {
    const label = norm(e.label);
    const hay = [label, norm(e.trail), ...e.keywords.map(norm)].join(' ');
    if (!words.every((w) => hay.includes(w))) return;
    const first = words[0];
    const score = label.startsWith(first)
      ? 0
      : label.split(' ').some((w) => w.startsWith(first))
        ? 1
        : label.includes(first)
          ? 2
          : 3;
    scored.push({ e, score, i });
  });
  return scored.sort((a, b) => a.score - b.score || a.i - b.i).map((s) => s.e);
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
