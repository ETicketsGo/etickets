import { ADMIN_PRESETS, AdminPermission } from '@eticketsgo/shared-types';

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
  ],
  // Unchanged.
  MODERATOR: [
    AdminPermission.ORGANIZER_READ,
    AdminPermission.ORGANIZER_REVIEW,
    AdminPermission.EVENT_REVIEW,
  ],
  // New.
  OPERATIONS: [AdminPermission.OPS_READ, AdminPermission.OPS_EXECUTE],
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
    }
  });

  it('describes SUPPORT truthfully now that it can change a status', () => {
    const text = ADMIN_PRESETS.SUPPORT.description;
    // It used to promise "Cannot change or delete anything", which SUPPORT_MANAGE makes false.
    expect(text).not.toMatch(/cannot change or delete anything/i);
    expect(text).toMatch(/open, triaged or closed/);
    expect(text).toMatch(/cannot change a booking, a refund or any money/i);
  });

  it('writes the changed and new descriptions in plain ASCII', () => {
    for (const key of ['SUPPORT', 'FINANCE', 'OPERATIONS']) {
      expect(ADMIN_PRESETS[key].description).toMatch(/^[\x20-\x7e]+$/);
      expect(ADMIN_PRESETS[key].label).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});
