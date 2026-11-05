import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allNavLinks } from './admin-nav';
import {
  ALWAYS_ALLOWED_ROUTES,
  capabilitiesForPath,
  owningLinkHref,
  pageAllowed,
} from './page-access';

/**
 * Who may open which admin page by URL. The menu hides what an operator cannot open; this is
 * the same rule for a typed or bookmarked address, so the page says "no access" instead of
 * "We couldn't load this".
 */

const agent = { roles: ['ADMIN'], adminPermissions: ['CRM_AGENT'] };
const manager = { roles: ['ADMIN'], adminPermissions: ['CRM_AGENT', 'CRM_MANAGER'] };
const superAdmin = { roles: ['SUPER_ADMIN'], adminPermissions: [] };
const finance = {
  roles: ['ADMIN'],
  adminPermissions: ['FINANCE_READ', 'PAYOUT_MANAGE', 'BOOKING_READ'],
};
const nobody = { roles: ['ADMIN'], adminPermissions: [] };

describe('an acquisition agent holding only CRM_AGENT', () => {
  it.each([
    '/admin/bookings',
    '/admin/bookings/abc123',
    '/admin/payouts',
    '/admin/settlements',
    '/admin/staff',
    '/admin/payment-config',
    '/admin/audit',
    '/admin/reports',
    '/admin/cinema-pricing/legal-types',
  ])('is refused %s', (path) => {
    expect(pageAllowed(path, agent)).toBe(false);
  });

  it.each([
    '/admin/acquisition',
    '/admin/acquisition/prospects',
    '/admin/acquisition/prospects/p1',
    '/admin/acquisition/pipeline',
    '/admin/acquisition/follow-ups',
    '/admin/acquisition/activities',
  ])('may open %s', (path) => {
    expect(pageAllowed(path, agent)).toBe(true);
  });

  it('is refused the manager-only team and reports pages', () => {
    expect(pageAllowed('/admin/acquisition/team', agent)).toBe(false);
    expect(pageAllowed('/admin/acquisition/reports', agent)).toBe(false);
    expect(pageAllowed('/admin/acquisition/team', manager)).toBe(true);
    expect(pageAllowed('/admin/acquisition/reports', manager)).toBe(true);
  });

  it('keeps the dashboard and their own account security', () => {
    expect(pageAllowed('/admin', agent)).toBe(true);
    expect(pageAllowed('/admin/security', agent)).toBe(true);
  });
});

describe('a super admin', () => {
  it('may open every page, even with an empty capability list', () => {
    for (const link of allNavLinks()) expect(pageAllowed(link.href, superAdmin)).toBe(true);
    expect(pageAllowed('/admin/bookings/abc', superAdmin)).toBe(true);
  });
});

describe('a finance operator', () => {
  it('keeps the money pages', () => {
    for (const path of [
      '/admin/payouts',
      '/admin/settlements',
      '/admin/finance-reconciliation',
      '/admin/disputes',
      '/admin/reports',
      '/admin/bookings',
      '/admin/payments',
    ]) {
      expect(pageAllowed(path, finance)).toBe(true);
    }
  });

  it('is not given configuration or staff pages', () => {
    expect(pageAllowed('/admin/payment-config', finance)).toBe(false);
    expect(pageAllowed('/admin/staff', finance)).toBe(false);
  });
});

describe('pages that need no duty', () => {
  it('stay open to an account with no duties', () => {
    expect(pageAllowed('/admin', nobody)).toBe(true);
    expect(pageAllowed('/admin/security', nobody)).toBe(true);
    expect(pageAllowed('/admin/security/anything', nobody)).toBe(true);
  });

  it('leave paths outside the admin menu alone', () => {
    expect(pageAllowed('/enroll-mfa', nobody)).toBe(true);
    expect(pageAllowed('/login', nobody)).toBe(true);
  });
});

describe('matching', () => {
  it('uses the longest link, not a shorter prefix', () => {
    expect(capabilitiesForPath('/admin/acquisition/team')).toEqual(['CRM_AGENT', 'CRM_MANAGER']);
    expect(capabilitiesForPath('/admin/acquisition')).toEqual(['CRM_AGENT']);
  });

  it('does not mistake a sibling with a shared prefix', () => {
    // "/admin/payments" (BOOKING_READ) must not own "/admin/payment-config" (PAYMENT_ADMIN).
    expect(capabilitiesForPath('/admin/payment-config')).toEqual(['PAYMENT_ADMIN']);
  });
});

/** Every page under app/admin, including `[id]` detail pages, as a path. */
function adminPages(): string[] {
  const root = resolve(__dirname, '..', 'app', 'admin');
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === 'page.tsx') {
        const rel = relative(root, dir).split(sep).filter(Boolean).join('/');
        out.push(rel ? `/admin/${rel}` : '/admin');
      }
    }
  };
  walk(root);
  return out.sort();
}

describe('route coverage', () => {
  it('finds the pages', () => {
    expect(adminPages()).toContain('/admin/bookings/[id]');
  });

  it('puts every admin page under a menu link of its own section, or on the always-allowed list', () => {
    /*
      Every path falls under the dashboard ("/admin", no duty), so a new page with no menu link
      would quietly be open to everybody. Here it must be covered by a link deeper than the
      dashboard - whose capability then guards it - or be named in ALWAYS_ALLOWED_ROUTES.
    */
    const uncovered = adminPages().filter((page) => {
      if (page === '/admin') return false;
      if (ALWAYS_ALLOWED_ROUTES.includes(page)) return false;
      const owner = owningLinkHref(page);
      return !owner || owner === '/admin';
    });
    expect(uncovered).toEqual([]);
  });

  it('names only real pages on the always-allowed list', () => {
    const pages = new Set(adminPages());
    expect(ALWAYS_ALLOWED_ROUTES.filter((r) => !pages.has(r))).toEqual([]);
  });
});
