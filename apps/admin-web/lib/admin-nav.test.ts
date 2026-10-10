import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filterQuickNav, quickNavEntries, visibleNav } from '@eticketsgo/web-kit';
import { ADMIN_NAV, activeGroupKey, activeHref, adminNavItems, allNavLinks } from './admin-nav';

/**
 * The admin menu: every page has a way in, and exactly one item says where you are.
 */

/** Every static route under app/admin, as a path: "/admin", "/admin/refunds", ... */
function adminRoutes(): string[] {
  const root = resolve(__dirname, '..', 'app', 'admin');
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        // A `[id]` page is reached from its list, not from the menu.
        if (!name.startsWith('[')) walk(full);
      } else if (name === 'page.tsx') {
        const rel = relative(root, dir).split(sep).filter(Boolean).join('/');
        out.push(rel ? `/admin/${rel}` : '/admin');
      }
    }
  };
  walk(root);
  return out.sort();
}

describe('the admin menu', () => {
  it('has a way in to every admin page', () => {
    const hrefs = new Set(allNavLinks().map((l) => l.href));
    const missing = adminRoutes().filter((r) => !hrefs.has(r));
    expect(missing).toEqual([]);
  });

  it('points at nothing that is not a page', () => {
    const routes = new Set(adminRoutes());
    expect(allNavLinks().filter((l) => !routes.has(l.href))).toEqual([]);
  });

  it('lists each page once', () => {
    const hrefs = allNavLinks().map((l) => l.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('is grouped by the operations jobs, in shift order', () => {
    expect(ADMIN_NAV.map((g) => g.label)).toEqual([
      'Overview',
      'Events',
      'Organizers & verification',
      'Bookings & payments',
      'Refunds & disputes',
      'Payouts & reconciliation',
      'Operational alerts',
      'Audit history',
      'Platform configuration',
    ]);
  });

  it('puts the approval queue and the calendar under Events', () => {
    const events = ADMIN_NAV.find((g) => g.key === 'events')!;
    expect(events.links.map((l) => l.href)).toEqual(
      expect.arrayContaining(['/admin/events', '/admin/calendar']),
    );
  });

  it('keeps settings, payment config, tax rules, cinema pricing and staff under configuration', () => {
    const config = ADMIN_NAV.find((g) => g.key === 'config')!.links.map((l) => l.href);
    for (const href of [
      '/admin/settings',
      '/admin/payment-config',
      '/admin/tax-rules',
      '/admin/cinema-pricing',
      '/admin/staff',
    ]) {
      expect(config).toContain(href);
    }
  });
});

describe('where you are', () => {
  it('marks the dashboard only on the dashboard', () => {
    expect(activeHref('/admin')).toBe('/admin');
    expect(activeHref('/admin/refunds')).toBe('/admin/refunds');
  });

  it('marks the list for a detail page under it', () => {
    expect(activeHref('/admin/refunds/abc123')).toBe('/admin/refunds');
    expect(activeGroupKey('/admin/refunds/abc123')).toBe('refunds');
  });

  it('does not mistake a sibling with a shared prefix', () => {
    // "/admin/payments" must not light up on "/admin/payment-config".
    expect(activeHref('/admin/payment-config')).toBe('/admin/payment-config');
    expect(activeHref('/admin/settlements')).toBe('/admin/settlements');
  });

  it('marks nothing for a path outside the menu', () => {
    expect(activeHref('/login')).toBeNull();
    expect(activeGroupKey('/login')).toBeNull();
  });
});

/**
 * Who sees what. The menu, the rail and quick navigation all read `visibleNav(adminNavItems())`,
 * so these are the rules for every one of them.
 */
describe('the menu lists only what the operator can open', () => {
  const ALL = [
    'BOOKING_READ',
    'ORGANIZER_READ',
    'FINANCE_READ',
    'OPS_READ',
    'REFUND_REVIEW',
    'REFUND_APPROVE',
    'ORGANIZER_REVIEW',
    'EVENT_REVIEW',
    'PLATFORM_CONFIG_READ',
    'PLATFORM_CONFIG',
    'PAYOUT_MANAGE',
    'PAYMENT_ADMIN',
    'ADMIN_MANAGE',
  ];
  const hrefsFor = (perms: string[]) =>
    visibleNav(adminNavItems(), { roles: ['ADMIN'], adminPermissions: perms }).map((i) => i.href);

  it('gives somebody holding every capability every page', () => {
    // A super admin: /auth/me returns every capability for SUPER_ADMIN.
    expect(hrefsFor(ALL).sort()).toEqual(
      allNavLinks()
        .map((l) => l.href)
        .sort(),
    );
  });

  it('gives a moderator the review queues and nothing that would refuse them', () => {
    const hrefs = hrefsFor(['EVENT_REVIEW', 'ORGANIZER_REVIEW']);
    expect(hrefs).toEqual(['/admin', '/admin/events', '/admin/calendar', '/admin/organizers']);
  });

  it('gives an account with no duties the landing page only', () => {
    expect(hrefsFor([])).toEqual(['/admin']);
  });

  it('never shows money pages to the support desk', () => {
    const hrefs = hrefsFor(['BOOKING_READ', 'ORGANIZER_READ']);
    for (const money of [
      '/admin/payouts',
      '/admin/settlements',
      '/admin/payment-config',
      '/admin/reports',
    ]) {
      expect(hrefs).not.toContain(money);
    }
    // ORGANIZER_READ is not ORGANIZER_REVIEW: the organizer queue would refuse them.
    expect(hrefs).not.toContain('/admin/organizers');
    expect(hrefs).toContain('/admin/bookings');
  });

  it('keeps each surviving page under its own group heading', () => {
    // A group's first link can be the one that goes: Approval queue and Refunds both need
    // more than BOOKING_READ, so Movies and Support carry their groups' names instead. And
    // Platform configuration is gone entirely: none of it opens with BOOKING_READ.
    const items = visibleNav(adminNavItems(), {
      roles: ['ADMIN'],
      adminPermissions: ['BOOKING_READ'],
    });
    expect(items.find((i) => i.href === '/admin/movies')?.group).toBe('Events');
    expect(items.find((i) => i.href === '/admin/support')?.group).toBe('Refunds & disputes');
    expect(items.filter((i) => i.group).map((i) => i.group)).toEqual([
      'Overview',
      'Events',
      'Bookings & payments',
      'Refunds & disputes',
      'Audit history',
    ]);
  });

  it('keeps platform configuration away from the support desk', () => {
    /*
      Fee rules, tax rules and cinema pricing used to open with BOOKING_READ, mirroring an API
      that let the support desk change them. Each now needs PLATFORM_CONFIG_READ to open.
    */
    const CONFIG = ['/admin/settings', '/admin/tax-rules', '/admin/cinema-pricing'];
    const support = hrefsFor(['BOOKING_READ', 'ORGANIZER_READ']);
    for (const page of CONFIG) expect(support).not.toContain(page);

    const reader = hrefsFor(['PLATFORM_CONFIG_READ']);
    for (const page of CONFIG) expect(reader).toContain(page);
    // The write capability alone does not open a page whose list it cannot load.
    const writer = hrefsFor(['PLATFORM_CONFIG']);
    for (const page of CONFIG) expect(writer).not.toContain(page);
  });

  it('quick navigation cannot find a page the operator cannot open', () => {
    const moderator = visibleNav(adminNavItems(), {
      roles: ['ADMIN'],
      adminPermissions: ['EVENT_REVIEW'],
    });
    expect(filterQuickNav(quickNavEntries(moderator), 'payout')).toEqual([]);
    expect(filterQuickNav(quickNavEntries(moderator), 'calendar').map((e) => e.href)).toEqual([
      '/admin/calendar',
    ]);
    const admin = visibleNav(adminNavItems(), { roles: ['ADMIN'], adminPermissions: ALL });
    expect(filterQuickNav(quickNavEntries(admin), 'payout')[0].href).toBe('/admin/payouts');
  });
});
