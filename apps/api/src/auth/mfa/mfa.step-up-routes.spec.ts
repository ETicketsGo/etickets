import { AdminPayoutsController } from '../../payouts/payouts.controller';
import { AdminStaffController } from '../../admin/admin-staff.controller';
import { SettlementController } from '../../payments/settlement/settlement.controller';
import { MFA_RECENT_KEY } from '../../common/decorators';
import { PlatformFeePoliciesController } from '../../admin/platform-fee-policies.controller';

/*
  Which actions demand a fresh second-factor check. A list in a test is deliberate: dropping
  the decorator from one of these is a decision, and this is where it shows up in review.
*/
const STEP_UP: Array<[string, new (...a: never[]) => unknown, string[]]> = [
  [
    'payouts',
    AdminPayoutsController,
    ['pay', 'revealAccount', 'verifyAccount', 'rejectAccount', 'fail'],
  ],
  ['settlements', SettlementController, ['approve', 'release']],
  ['staff', AdminStaffController, ['setPermissions', 'grant', 'invite', 'revoke', 'resetMfa']],
  // A fee waiver or override changes what buyers pay from the next sale on.
  [
    'platform fee policies',
    PlatformFeePoliciesController,
    ['createPlatformFeePolicy', 'deactivatePlatformFeePolicy'],
  ],
];

describe('sensitive back-office actions require a recent second-factor check', () => {
  for (const [name, controller, handlers] of STEP_UP) {
    for (const h of handlers) {
      it(`${name}.${h}`, () => {
        const fn = (controller.prototype as Record<string, unknown>)[h];
        expect(typeof fn).toBe('function');
        expect(Reflect.getMetadata(MFA_RECENT_KEY, fn as object)).toBe(true);
      });
    }
  }
});
