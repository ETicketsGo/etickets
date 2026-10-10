import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filterQuickNav, navSections, quickNavEntries, type NavItem } from '@eticketsgo/web-kit';
import { navFor } from './organizer-nav';

/**
 * Every organizer page has a way in from the sidebar.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * Regrouping a sidebar is how a page quietly loses its only door. The audit behind this
 * change found the check-in gate unreachable for owners and every cinema page with no item
 * marked while you stood on it - neither was anybody's decision, both were what was left
 * after a nav was edited by hand.
 *
 * So the rule is checked against the app directory itself: a page is reachable if its path
 * is a nav item's href, sits under one, or sits under one of an item's `match` prefixes. A
 * new page added under a prefix nothing covers fails here, not in an organizer's hands.
 */
const APP = resolve(__dirname, '..', 'app', 'organizer');

function pageRoutes(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...pageRoutes(full));
    else if (name === 'page.tsx') {
      const rel = relative(APP, dir).split(sep).join('/');
      out.push(rel ? `/organizer/${rel}` : '/organizer');
    }
  }
  return out;
}

function flatten(items: NavItem[]): NavItem[] {
  return items.flatMap((i) => [i, ...flatten(i.children ?? [])]);
}

function reachable(route: string, items: NavItem[]): boolean {
  const under = (prefix: string) => route === prefix || route.startsWith(`${prefix}/`);
  return flatten(items).some(
    (i) => (i.exact ? route === i.href : under(i.href)) || (i.match ?? []).some(under),
  );
}

/** Pages that are paper, not screens: they render with no shell at all, by design. */
const PRINT = (route: string) => route.endsWith('/print');

/**
 * Pages that are deliberately not screens an organizer uses: the design-system style page
 * exists only on a development server (every built app answers 404) and is for the people
 * building pages, so a menu item for it would be a door to nothing in production.
 */
const NOT_FOR_ORGANIZERS = new Set(['/organizer/design-system']);

describe('the organizer sidebar', () => {
  const owner = navFor({ doesFilmBusiness: true, can: { financials: true, ownerActions: true } });
  const routes = pageRoutes(APP).filter((r) => !PRINT(r) && !NOT_FOR_ORGANIZERS.has(r));

  it('found the pages to check', () => {
    // A path mistake here would make every assertion below vacuous.
    expect(routes.length).toBeGreaterThan(30);
    expect(routes).toContain('/organizer/payouts');
  });

  it.each(routes)('reaches %s', (route) => {
    expect(reachable(route, owner), `${route} has no way in from the sidebar`).toBe(true);
  });

  it('has the four groups the owner asked for, in order', () => {
    expect(owner.filter((i) => i.group).map((i) => i.group)).toEqual([
      'Workspace',
      'Operations',
      'Business',
      'Account',
    ]);
  });

  it('links the calendar', () => {
    expect(flatten(owner).map((i) => i.href)).toContain('/organizer/calendar');
  });

  it('lists Movies only for an organization that shows films', () => {
    const promoter = navFor({
      doesFilmBusiness: false,
      can: { financials: true, ownerActions: true },
    });
    expect(flatten(promoter).map((i) => i.href)).not.toContain('/organizer/movies');
    expect(flatten(owner).map((i) => i.href)).toContain('/organizer/movies');
  });

  it('gives check-in staff the gate and help, and no money', () => {
    const staff = navFor({
      doesFilmBusiness: true,
      can: { financials: false, ownerActions: false },
    });
    expect(flatten(staff).map((i) => i.href)).toEqual(['/organizer/gate', '/organizer/help']);
  });

  it('never lists the same page twice', () => {
    const hrefs = flatten(owner).map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

describe('quick navigation and the collapsed rail', () => {
  const owner = navFor({ doesFilmBusiness: false, can: { financials: true, ownerActions: true } });
  const staff = navFor({ doesFilmBusiness: true, can: { financials: false, ownerActions: false } });

  it('finds a secondary page by name, with where it sits', () => {
    const [hit] = filterQuickNav(quickNavEntries(owner), 'payouts');
    expect(hit.href).toBe('/organizer/payouts');
    expect(hit.trail).toBe('Business / Finance & payouts');
  });

  it('finds a page by a word that is not in its name', () => {
    expect(filterQuickNav(quickNavEntries(owner), 'scan')[0].href).toBe('/organizer/gate');
  });

  it('cannot take check-in staff anywhere their sidebar does not list', () => {
    // The search reads the same nav as the sidebar, so a door the sidebar does not show is
    // not a door the search can open either.
    expect(filterQuickNav(quickNavEntries(staff), 'finance')).toEqual([]);
    expect(filterQuickNav(quickNavEntries(staff), 'payouts')).toEqual([]);
    expect(filterQuickNav(quickNavEntries(staff), '').map((e) => e.href)).toEqual([
      '/organizer/gate',
      '/organizer/help',
    ]);
  });

  it('gives every rail group its own picture', () => {
    const icons = navSections(owner).map((s) => s.icon);
    expect(icons.every(Boolean)).toBe(true);
    expect(new Set(icons).size).toBe(icons.length);
  });
});
