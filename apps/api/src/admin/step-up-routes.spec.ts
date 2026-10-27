import { Reflector } from '@nestjs/core';
import { MFA_RECENT_KEY, type RequestUser } from '../common/decorators';
import { MfaGuard } from '../auth/mfa/mfa.guard';
import { AdminController } from './admin.controller';
import { AdminUsersController } from './admin-users.controller';
import { RefundsController } from '../refunds/refunds.controller';
import { PaymentAdminController } from '../payments/admin/payment-admin.controller';
import { PaymentOutageController } from '../payments/outage/payment-outage.controller';
import { PromotionController } from '../payments/promotion/promotion.controller';
import { AdminOrganizationsController } from '../organizations/organizations.controller';
import { PlatformFeePoliciesController } from './platform-fee-policies.controller';
import { AdminBillingController } from '../billing/billing-admin.controller';
import { AdminCampaignsController } from '../campaigns/campaigns.controller';

/*
  The staff writes that now also need a fresh second-factor check, beside the ones listed in
  auth/mfa/mfa.step-up-routes.spec.ts (payouts, settlements, staff). Same deliberate shape: a
  list in a test, so dropping the decorator from one of these is a decision seen in review.

  Each one either moves money (refund approval), changes what every buyer pays (fee, tax and
  regulated cinema price rules), changes where and how payments are taken (provider config,
  routes, failover, outage suspensions, environment promotion), or stops somebody (organizer
  suspension or deletion, account suspension and sign-out).
*/
const STEP_UP: Array<[string, new (...a: never[]) => unknown, string[]]> = [
  ['refunds', RefundsController, ['process']],
  [
    'platform config',
    AdminController,
    [
      'createFeeRule',
      'updateFeeRule',
      'createTaxRule',
      'updateTaxRule',
      'supersedeTaxRule',
      'deleteTaxRule',
      'createCinemaPricingPolicy',
      'updateCinemaPricingPolicy',
      'activateCinemaPricingPolicy',
      'supersedeCinemaPricingPolicy',
      'disableCinemaPricingPolicy',
    ],
  ],
  [
    'platform fee policies',
    PlatformFeePoliciesController,
    ['createPlatformFeePolicy', 'deactivatePlatformFeePolicy'],
  ],
  [
    'payment config',
    PaymentAdminController,
    ['updateConfig', 'createRoute', 'updateRoute', 'deleteRoute'],
  ],
  [
    'payment outage',
    PaymentOutageController,
    ['route', 'country', 'provider', 'failover', 'maintenance'],
  ],
  ['payment promotion', PromotionController, ['approve', 'apply']],
  ['organizers', AdminOrganizationsController, ['setSuspension', 'removeOrganization']],
  ['accounts', AdminUsersController, ['suspend', 'reinstate', 'revokeSessions']],
  /*
    Organizer billing: what organizers pay (plans, prices) and what they get without paying
    (trials, complimentary plans, credits, discounts, single-feature grants).
  */
  [
    'organizer billing',
    AdminBillingController,
    [
      'loadCatalog',
      'updatePlan',
      'setPlanEntitlements',
      'createPrice',
      'updatePrice',
      'deactivatePrice',
      'grantTrial',
      'grantComplimentary',
      'endGrant',
      'grantCredits',
      'recordDiscount',
      'grantOverride',
      'revokeOverride',
    ],
  ],
  // Stopping, or releasing, an organizer's campaign: mail going out under the platform's name.
  ['organizer campaigns', AdminCampaignsController, ['pause', 'release']],
];

/** Reads on the same controllers: a fresh code must NOT be demanded to look. */
const NOT_STEP_UP: Array<[new (...a: never[]) => unknown, string[]]> = [
  [AdminController, ['feeRules', 'taxRules', 'cinemaPricingPolicies']],
  [PlatformFeePoliciesController, ['list', 'detail', 'preview']],
  [PaymentAdminController, ['overview', 'health']],
  [PaymentOutageController, ['status']],
  [AdminOrganizationsController, ['list', 'reviewSignals']],
  [AdminBillingController, ['plans', 'searchSubscriptions', 'account', 'metrics']],
  [AdminCampaignsController, ['list', 'health']],
];

/** A verified session whose last check was this long ago. */
const verified = (agoMs: number): NonNullable<RequestUser['mfa']> => ({
  required: true,
  enrolled: true,
  verified: true,
  verifiedAt: Date.now() - agoMs,
  stepUp: 'available',
});
/** MFA_ENROLLMENT=deferred, not enrolled (key set) or no key at all outside LOCAL/DEV. */
const relaxed = (stepUp: 'available' | 'unconfigured'): NonNullable<RequestUser['mfa']> => ({
  required: false,
  enrolled: false,
  verified: false,
  verifiedAt: null,
  stepUp,
});

async function guardRun(
  controller: new (...a: never[]) => unknown,
  handler: string,
  mfa: NonNullable<RequestUser['mfa']>,
) {
  const guard = new MfaGuard(new Reflector(), {
    stepUpMs: 10 * 60_000,
    recordSensitiveRefusal: jest.fn().mockResolvedValue(undefined),
  } as never);
  const user = { id: 'u', email: 'e', fullName: 'n', roles: ['ADMIN'], mfa } as RequestUser;
  const ctx = {
    getHandler: () => (controller.prototype as Record<string, unknown>)[handler],
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ user, method: 'POST', path: '/x', headers: {} }) }),
  };
  try {
    return (await guard.canActivate(ctx as never)) ? 'PASS' : 'REFUSED';
  } catch (e) {
    return (e as { code?: string }).code ?? 'ERROR';
  }
}

describe('staff writes that now need a recent second-factor check', () => {
  for (const [name, controller, handlers] of STEP_UP) {
    for (const h of handlers) {
      it(`${name}: ${controller.name}.${h}`, async () => {
        const fn = (controller.prototype as Record<string, unknown>)[h];
        expect(typeof fn).toBe('function');
        expect(Reflect.getMetadata(MFA_RECENT_KEY, fn as object)).toBe(true);
        // Through the real guard: a check eleven minutes old is refused, one a minute old passes.
        expect(await guardRun(controller, h, verified(11 * 60_000))).toBe('MFA_STEP_UP_REQUIRED');
        expect(await guardRun(controller, h, verified(60_000))).toBe('PASS');
        // MFA_ENROLLMENT=deferred is not a way round it: not enrolled asks for setup, and a
        // server with no key blocks the action outright.
        expect(await guardRun(controller, h, relaxed('available'))).toBe('MFA_SETUP_REQUIRED');
        expect(await guardRun(controller, h, relaxed('unconfigured'))).toBe('MFA_NOT_CONFIGURED');
      });
    }
  }

  for (const [controller, handlers] of NOT_STEP_UP) {
    for (const h of handlers) {
      it(`does not demand a fresh code to read: ${controller.name}.${h}`, async () => {
        expect(await guardRun(controller, h, verified(11 * 60_000))).toBe('PASS');
        // ...nor an authenticator at all while enrollment is deferred.
        expect(await guardRun(controller, h, relaxed('available'))).toBe('PASS');
      });
    }
  }

  it('does not ask an organizer refunding their own customer for a code they do not have', async () => {
    const guard = new MfaGuard(new Reflector(), { stepUpMs: 10 * 60_000 } as never);
    const ctx = {
      getHandler: () => RefundsController.prototype.process,
      getClass: () => RefundsController,
      switchToHttp: () => ({
        getRequest: () => ({
          user: { id: 'o', email: 'o', fullName: 'o', roles: ['ORGANIZER_OWNER'] },
        }),
      }),
    };
    expect(await guard.canActivate(ctx as never)).toBe(true);
  });
});
