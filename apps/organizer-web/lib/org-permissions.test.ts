import { describe, expect, it } from 'vitest';
import { isForbidden, orgPermissions } from './org-permissions';

/**
 * The console's copy of the API's organization role rules.
 *
 * Pinned because the failure in each direction is different: too loose and a manager is
 * offered a Refund button the API refuses; too tight and an owner — or an administrator the
 * API lets through everything — loses a button they are entitled to, with nothing to say why.
 */
describe('what a member may do', () => {
  it('lets the owner do everything', () => {
    expect(orgPermissions('ORGANIZER_OWNER')).toEqual({ ownerActions: true, financials: true });
  });

  it('lets a manager see payouts but not act as the owner', () => {
    expect(orgPermissions('ORGANIZER_MANAGER')).toEqual({ ownerActions: false, financials: true });
  });

  it('keeps check-in staff away from both', () => {
    expect(orgPermissions('CHECKIN_STAFF')).toEqual({ ownerActions: false, financials: false });
  });

  it('does not restrict an administrator (null) or an API that sends no role (undefined)', () => {
    expect(orgPermissions(null)).toEqual({ ownerActions: true, financials: true });
    expect(orgPermissions(undefined)).toEqual({ ownerActions: true, financials: true });
  });

  it('treats a role it does not recognise as allowed nothing', () => {
    expect(orgPermissions('SOMETHING_NEW')).toEqual({ ownerActions: false, financials: false });
  });
});

describe('a refused request', () => {
  it('is a 403, and nothing else', () => {
    expect(isForbidden({ status: 403 })).toBe(true);
    expect(isForbidden({ status: 500 })).toBe(false);
    expect(isForbidden(new Error('network'))).toBe(false);
    expect(isForbidden(null)).toBe(false);
  });
});
