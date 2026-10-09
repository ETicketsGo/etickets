import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADMIN_NAV, activeGroupKey, activeHref, allNavLinks } from './admin-nav';

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
