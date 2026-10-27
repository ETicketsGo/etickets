import { HttpStatus } from '@nestjs/common';
import { Role } from '@eticketsgo/shared-types';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';
import { OrganizerBillingController } from './billing.controller';

/**
 * Owner decision 2026-10-27: the organization OWNER manages the subscription. Starting a plan
 * checkout, buying a credit pack, opening the provider portal and cancelling are the owner's
 * alone; a manager can read the billing page and the invoices and nothing more.
 *
 * The membership check is the real rule (`OrgAccessService.assertMember` with the roles each
 * route names). This stands in a member whose role is fixed and refuses exactly as that check
 * does, then calls each route as an owner and as a manager.
 */
describe('organizer billing: only the owner changes the subscription', () => {
  const ORG = 'org-1';
  const user = {
    id: 'u1',
    email: 'u@example.test',
    fullName: 'Owner',
    roles: ['ORGANIZER'],
  } as unknown as RequestUser;

  function controllerFor(memberRole: string) {
    const access = {
      assertMember: jest.fn(async (_u: RequestUser, _org: string, roles?: string[]) => {
        if (roles && !roles.includes(memberRole)) {
          throw new AppException(ErrorCodes.FORBIDDEN, 'Not allowed.', HttpStatus.FORBIDDEN);
        }
      }),
    };
    const checkouts = {
      startPlanCheckout: jest.fn(async () => ({ url: 'https://pay.example/1' })),
      startCreditPackCheckout: jest.fn(async () => ({ url: 'https://pay.example/2' })),
      portal: jest.fn(async () => ({ url: 'https://pay.example/3' })),
      cancel: jest.fn(async () => ({
        status: 'ACTIVE',
        cancelAtPeriodEnd: true,
        currentPeriodEnd: null,
      })),
    };
    const reads = {
      organizerBilling: jest.fn(async () => ({ ok: true })),
      organizerInvoices: jest.fn(async () => []),
    };
    const ctrl = new OrganizerBillingController(
      access as never,
      {} as never,
      reads as never,
      {} as never,
      checkouts as never,
    );
    return { ctrl, checkouts, reads, access };
  }

  const writes = (ctrl: OrganizerBillingController) => [
    () => ctrl.checkout(user, ORG, { priceId: 'p1' }),
    () => ctrl.creditPackCheckout(user, ORG, { packCode: 'EMAIL_1K' }),
    () => ctrl.portal(user, ORG),
    () => ctrl.cancel(user, ORG, {}),
  ];

  it('lets the owner start a checkout, buy a pack, open the portal and cancel', async () => {
    const { ctrl, checkouts, access } = controllerFor(Role.ORGANIZER_OWNER);
    for (const call of writes(ctrl)) await expect(call()).resolves.toBeTruthy();
    expect(checkouts.startPlanCheckout).toHaveBeenCalled();
    expect(checkouts.startCreditPackCheckout).toHaveBeenCalled();
    expect(checkouts.portal).toHaveBeenCalled();
    expect(checkouts.cancel).toHaveBeenCalled();
    // Each write names the owner role and nothing else.
    for (const c of access.assertMember.mock.calls) expect(c[2]).toEqual([Role.ORGANIZER_OWNER]);
  });

  it('refuses a manager every write, before any provider is asked', async () => {
    const { ctrl, checkouts } = controllerFor(Role.ORGANIZER_MANAGER);
    for (const call of writes(ctrl)) {
      await expect(call()).rejects.toMatchObject({ code: ErrorCodes.FORBIDDEN });
    }
    expect(checkouts.startPlanCheckout).not.toHaveBeenCalled();
    expect(checkouts.startCreditPackCheckout).not.toHaveBeenCalled();
    expect(checkouts.portal).not.toHaveBeenCalled();
    expect(checkouts.cancel).not.toHaveBeenCalled();
  });

  it('lets a manager read the billing page and the invoices', async () => {
    const { ctrl, reads } = controllerFor(Role.ORGANIZER_MANAGER);
    await expect(ctrl.billing(user, ORG)).resolves.toEqual({ ok: true });
    await expect(ctrl.invoices(user, ORG)).resolves.toEqual([]);
    expect(reads.organizerBilling).toHaveBeenCalledWith(ORG);
  });
});
