import { readdirSync, readFileSync, statSync } from 'node:fs';
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

  it('has the three section labels, in order', () => {
    expect(owner.filter((i) => i.group).map((i) => i.group)).toEqual([
      'Selling',
      'Operations',
      'Business',
    ]);
  });

  it('lists the top-level pages in the order the owner asked for', () => {
    // The sidebar rows: every item except the ones kept for quick navigation only.
    expect(owner.filter((i) => i.sidebar !== false).map((i) => i.label)).toEqual([
      'Overview',
      'Events',
      'Calendar',
      'Venues & seating',
      'Movies',
      'Bookings & attendees',
      'Counter',
      'Check-in',
      'Notifications',
      'Marketing',
      'Finance & payouts',
      'Team',
      'Settings',
      'Help & support',
    ]);
  });

  it('keeps Get started out of the sidebar list but findable', () => {
    const start = owner.find((i) => i.href === '/organizer/onboarding');
    expect(start?.sidebar).toBe(false);
    expect(filterQuickNav(quickNavEntries(owner), 'get started')[0].href).toBe(
      '/organizer/onboarding',
    );
  });

  it('has one level only: secondary pages are tabs of Marketing, Finance and Settings', () => {
    const parents = owner.filter((i) => i.children?.length).map((i) => i.href);
    expect(parents).toEqual(['/organizer/promotions', '/organizer/finance', '/organizer/settings']);
    for (const kid of owner.flatMap((i) => i.children ?? [])) {
      expect(kid.children, `${kid.href} nests a third level`).toBeUndefined();
    }
  });

  it('finds the page for the everyday words people type', () => {
    // On QA each of these found nothing in Find a page.
    const top = (q: string) => filterQuickNav(quickNavEntries(owner), q)[0]?.href;
    expect(top('bank')).toBe('/organizer/payouts');
    expect(top('invite')).toBe('/organizer/team');
    expect(top('discount')).toBe('/organizer/promotions');
    expect(top('legal')).toBe('/organizer/settings');
    // Tax invoices (Receipts) and the tax registration (Settings) are both right answers.
    expect(filterQuickNav(quickNavEntries(owner), 'tax').map((e) => e.href)).toEqual(
      expect.arrayContaining(['/organizer/settings', '/organizer/receipts']),
    );
    expect(top('theme')).toBe('/organizer/settings');
    expect(top('contact')).toBe('/organizer/help');
    expect(top('followers')).toBe('/organizer/audience');
  });

  it('lists Counter in the sidebar, straight under Bookings & attendees', () => {
    // As a tab of Bookings it was reachable only through Find a page (QA, 2026-10-16).
    const rows = owner.filter((i) => i.sidebar !== false).map((i) => i.href);
    expect(rows[rows.indexOf('/organizer/bookings') + 1]).toBe('/organizer/counter');
    expect(filterQuickNav(quickNavEntries(owner), 'box office')[0]?.href).toBe(
      '/organizer/counter',
    );
  });

  it('puts Billing & plans in Business (a Settings tab); the old Premium address lands on it', () => {
    const settings = owner.find((i) => i.href === '/organizer/settings');
    expect(settings?.children?.map((x) => x.href)).toEqual(['/organizer/billing']);
    expect(reachable('/organizer/premium', owner)).toBe(true);
    expect(filterQuickNav(quickNavEntries(owner), 'upgrade')[0]?.href).toBe('/organizer/billing');
    expect(filterQuickNav(quickNavEntries(owner), 'premium')[0]?.href).toBe('/organizer/billing');
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

  it('gives every section its own picture', () => {
    const icons = navSections(owner).map((s) => s.icon);
    expect(icons.every(Boolean)).toBe(true);
    expect(new Set(icons).size).toBe(icons.length);
  });
});

/**
 * A sidebar label and the title of the page it opens are the same words.
 *
 * The walkthrough found "Check-in" opening "Gate", "Marketing" opening "Promotions" and
 * "Bookings & attendees" opening "Find a booking": a person who clicked a label and landed under
 * another name was never sure they had arrived. Read from the page source, so a title edited
 * later cannot drift from the menu without failing here.
 */
describe('sidebar labels equal page titles', () => {
  const owner = navFor({ doesFilmBusiness: true, can: { financials: true, ownerActions: true } });
  /*
    Not compared: onboarding's title is a sentence about this organization, and the Overview and
    Calendar titles are drawn by their own components (desk.tsx "Overview", organizer-calendar.tsx
    "Calendar"), not by a literal in page.tsx.
  */
  const PERSONAL = new Set(['/organizer/onboarding', '/organizer', '/organizer/calendar']);

  function titleOf(href: string): string | null {
    const file = join(APP, href.replace('/organizer', ''), 'page.tsx');
    const src = readFileSync(file, 'utf8');
    const m = /<PageHeader[\s\S]{0,200}?[\s]title=["']([^"']+)["']/.exec(src);
    return m ? m[1].replace(/&amp;/g, '&') : null;
  }

  const items = flatten(owner).filter((i) => !PERSONAL.has(i.href));

  it.each(items.map((i) => [i.label, i.href]))(
    '%s opens a page of the same name',
    (label, href) => {
      const title = titleOf(href);
      expect(title, `${href} has no literal PageHeader title to compare`).not.toBeNull();
      expect(title).toBe(label);
    },
  );
});
