import { describe, expect, it } from 'vitest';
import { adminAccountIdentity } from './account-identity';

describe('adminAccountIdentity', () => {
  it('names a super admin by role, not by a list of every duty', () => {
    const id = adminAccountIdentity({
      roles: ['SUPER_ADMIN', 'ADMIN'],
      adminPermissions: ['BANK_VERIFY', 'PAYOUT_MANAGE', 'ADMIN_MANAGE'],
    });
    expect(id).toEqual({ role: 'Super admin', duties: [], summary: 'Holds every duty' });
  });

  it('names limited staff by the duties they hold, in the Staff & duties words', () => {
    const id = adminAccountIdentity({
      roles: ['ADMIN'],
      adminPermissions: ['PAYOUT_MANAGE', 'BANK_VERIFY', 'PAYOUT_MANAGE'],
    });
    expect(id.role).toBe('Admin');
    expect(id.duties).toEqual(['Check bank accounts', 'Manage payouts']);
    expect(id.summary).toBeNull();
  });

  it('reads an unknown duty as plain words rather than leaving it blank', () => {
    expect(
      adminAccountIdentity({ roles: ['ADMIN'], adminPermissions: ['NEW_THING'] }).duties,
    ).toEqual(['New thing']);
  });

  it('says so when a staff account holds no duty yet', () => {
    const id = adminAccountIdentity({ roles: ['ADMIN'], adminPermissions: [] });
    expect(id.role).toBe('Admin');
    expect(id.duties).toEqual([]);
    expect(id.summary).toBe('No duties yet. Ask a super admin to give you one.');
  });

  it('says nothing for a signed-out visitor or an account with no back-office role', () => {
    expect(adminAccountIdentity(null)).toEqual({ role: null, duties: [], summary: null });
    expect(adminAccountIdentity({ roles: ['CUSTOMER'] })).toEqual({
      role: null,
      duties: [],
      summary: null,
    });
  });

  it('writes plain ASCII only', () => {
    const all = [
      adminAccountIdentity({ roles: ['SUPER_ADMIN'] }),
      adminAccountIdentity({ roles: ['ADMIN'], adminPermissions: [] }),
      adminAccountIdentity({
        roles: ['ADMIN'],
        adminPermissions: ['BANK_VERIFY', 'PAYOUT_MANAGE', 'REFUND_APPROVE', 'CRM_AGENT'],
      }),
    ];
    for (const id of all) {
      expect(JSON.stringify(id)).toMatch(/^[\x20-\x7e]*$/);
    }
  });
});
