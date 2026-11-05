import { ADMIN_PRESETS, AdminPermission, permissionsFor } from '@eticketsgo/shared-types';

/**
 * The ready-made bundles are exactly what the owner approved on 2026-10-10.
 *
 * A preset is handed to a new starter in one click, so one capability too many in a bundle is
 * one capability too many for everybody it is ever given to. The definitions are therefore
 * pinned here capability by capability, sorted, so adding or dropping one is a failing build
 * and a decision in review rather than a quiet edit.
 */
const APPROVED: Record<string, AdminPermission[]> = {
  // Existing + SUPPORT_MANAGE.
  SUPPORT: [
    AdminPermission.BOOKING_READ,
    AdminPermission.ORGANIZER_READ,
    AdminPermission.SUPPORT_MANAGE,
  ],
  // Unchanged: in particular no SUPPORT_MANAGE.
  REFUND_DESK: [
    AdminPermission.BOOKING_READ,
    AdminPermission.ORGANIZER_READ,
    AdminPermission.REFUND_REVIEW,
  ],
  // Existing + FINANCE_APPROVE + FINANCE_RESOLVE + PLATFORM_CONFIG_READ.
  FINANCE: [
    AdminPermission.BOOKING_READ,
    AdminPermission.FINANCE_READ,
    AdminPermission.REFUND_REVIEW,
    AdminPermission.REFUND_APPROVE,
    AdminPermission.PAYOUT_MANAGE,
    AdminPermission.FINANCE_APPROVE,
    AdminPermission.FINANCE_RESOLVE,
    AdminPermission.PLATFORM_CONFIG_READ,
    // + BILLING_READ (organizer plans and platform invoices).
    AdminPermission.BILLING_READ,
    // + BILLING_ADJUST (owner decision 2026-10-27): billing operations, not catalogue or prices.
    AdminPermission.BILLING_ADJUST,
  ],
  // Unchanged.
  MODERATOR: [
    AdminPermission.ORGANIZER_READ,
    AdminPermission.ORGANIZER_REVIEW,
    AdminPermission.EVENT_REVIEW,
  ],
  // New.
  OPERATIONS: [AdminPermission.OPS_READ, AdminPermission.OPS_EXECUTE],
  // New (separation of duties, granted to nobody until the owner names people).
  FINANCE_VERIFIER: [
    AdminPermission.BOOKING_READ,
    AdminPermission.FINANCE_READ,
    AdminPermission.PAYOUT_MANAGE,
    AdminPermission.BANK_VERIFY,
  ],
  FINANCE_PAYER: [
    AdminPermission.BOOKING_READ,
    AdminPermission.FINANCE_READ,
    AdminPermission.PAYOUT_MANAGE,
    AdminPermission.PAYOUT_EXECUTE,
  ],
  // + AUDIT_READ (the audit log left BOOKING_READ; this bundle's job is oversight).
  FINANCE_REVIEWER: [
    AdminPermission.BOOKING_READ,
    AdminPermission.FINANCE_READ,
    AdminPermission.AUDIT_READ,
    AdminPermission.BILLING_READ,
  ],
  OPS_ONCALL: [AdminPermission.OPS_READ, AdminPermission.OPS_EXECUTE],
  // New (organizer acquisition CRM): the CRM duties and NOTHING else - no booking, organizer,
  // finance or audit read. An acquisition agent must not reach customers or money.
  CRM_AGENT: [AdminPermission.CRM_AGENT],
  CRM_MANAGER: [AdminPermission.CRM_AGENT, AdminPermission.CRM_MANAGER],
  // New (organizer billing): plans, offers and single-feature grants; no bookings or payouts.
  BILLING_DESK: [
    AdminPermission.ORGANIZER_READ,
    AdminPermission.BILLING_READ,
    AdminPermission.BILLING_MANAGE,
    AdminPermission.BILLING_ADJUST,
    AdminPermission.ENTITLEMENT_GRANT,
  ],
};

describe('the ready-made staff bundles', () => {
  it('are exactly the approved set of bundles', () => {
    expect(Object.keys(ADMIN_PRESETS).sort()).toEqual(Object.keys(APPROVED).sort());
  });

  it.each(Object.keys(APPROVED))('%s carries exactly the approved capabilities', (key) => {
    expect([...ADMIN_PRESETS[key].grants].sort()).toEqual([...APPROVED[key]].sort());
    // No capability listed twice, which would hide a removal behind a duplicate.
    expect(new Set(ADMIN_PRESETS[key].grants).size).toBe(ADMIN_PRESETS[key].grants.length);
  });

  it('never bundles the powers that are granted person by person', () => {
    for (const preset of Object.values(ADMIN_PRESETS)) {
      expect(preset.grants).not.toContain(AdminPermission.PLATFORM_CONFIG);
      expect(preset.grants).not.toContain(AdminPermission.PAYMENT_ADMIN);
      expect(preset.grants).not.toContain(AdminPermission.ADMIN_MANAGE);
      // Locking people out is granted person by person, like managing staff.
      expect(preset.grants).not.toContain(AdminPermission.USER_SUSPEND);
    }
  });

  it('gives the audit log to the oversight bundle only', () => {
    const carriers = Object.entries(ADMIN_PRESETS)
      .filter(([, p]) => p.grants.includes(AdminPermission.AUDIT_READ))
      .map(([key]) => key);
    expect(carriers).toEqual(['FINANCE_REVIEWER']);
  });

  it('describes SUPPORT truthfully now that it can change a status', () => {
    const text = ADMIN_PRESETS.SUPPORT.description;
    // It used to promise "Cannot change or delete anything", which SUPPORT_MANAGE makes false.
    expect(text).not.toMatch(/cannot change or delete anything/i);
    expect(text).toMatch(/open, triaged or closed/);
    expect(text).toMatch(/cannot change a booking, a refund or any money/i);
  });

  it('keeps the CRM duties out of every other bundle, and everything else out of the CRM ones', () => {
    const crm: string[] = [AdminPermission.CRM_AGENT, AdminPermission.CRM_MANAGER];
    for (const [key, preset] of Object.entries(ADMIN_PRESETS)) {
      const carries = preset.grants.filter((g) => crm.includes(g));
      if (key.startsWith('CRM_')) expect(preset.grants.every((g) => crm.includes(g))).toBe(true);
      else expect(carries).toEqual([]);
    }
  });

  it('keeps catalogue, price and single-feature writes in the billing desk bundle only', () => {
    const writes: string[] = [AdminPermission.BILLING_MANAGE, AdminPermission.ENTITLEMENT_GRANT];
    for (const [key, preset] of Object.entries(ADMIN_PRESETS)) {
      if (key === 'BILLING_DESK') continue;
      expect(preset.grants.filter((g) => writes.includes(g))).toEqual([]);
    }
  });

  it('gives billing operations to Finance and the billing desk, and nobody else', () => {
    const holders = Object.entries(ADMIN_PRESETS)
      .filter(([, p]) => p.grants.includes(AdminPermission.BILLING_ADJUST))
      .map(([key]) => key)
      .sort();
    expect(holders).toEqual(['BILLING_DESK', 'FINANCE']);
  });

  it('owner decision 2026-10-27: Finance operates billing, the reviewer only reads it', () => {
    const finance = ADMIN_PRESETS.FINANCE.grants;
    expect(finance).toEqual(
      expect.arrayContaining([AdminPermission.BILLING_READ, AdminPermission.BILLING_ADJUST]),
    );
    expect(finance).not.toContain(AdminPermission.BILLING_MANAGE);
    expect(finance).not.toContain(AdminPermission.ENTITLEMENT_GRANT);
    const reviewer = ADMIN_PRESETS.FINANCE_REVIEWER.grants.filter(
      (g) => g.startsWith('BILLING_') || g === AdminPermission.ENTITLEMENT_GRANT,
    );
    expect(reviewer).toEqual([AdminPermission.BILLING_READ]);
  });

  it('a super admin holds every billing capability by role, with no grant rows', () => {
    const held = permissionsFor(['ADMIN', 'SUPER_ADMIN'], []);
    for (const p of [
      AdminPermission.BILLING_READ,
      AdminPermission.BILLING_MANAGE,
      AdminPermission.BILLING_ADJUST,
      AdminPermission.ENTITLEMENT_GRANT,
    ]) {
      expect(held.has(p)).toBe(true);
    }
  });

  it('writes the changed and new descriptions in plain ASCII', () => {
    for (const key of [
      'SUPPORT',
      'FINANCE',
      'OPERATIONS',
      'CRM_AGENT',
      'CRM_MANAGER',
      'BILLING_DESK',
    ]) {
      expect(ADMIN_PRESETS[key].description).toMatch(/^[\x20-\x7e]+$/);
      expect(ADMIN_PRESETS[key].label).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});
