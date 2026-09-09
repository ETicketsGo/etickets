import { AdminPermission, Role } from '@eticketsgo/shared-types';
import { ADMIN_PERMISSION_KEY, ROLES_KEY } from '../../../common/decorators';
import { NotificationOpsController } from '../notification-ops.controller';

/**
 * Who may read an SNS confirmation token.
 *
 * ── WHY THIS IS ASSERTED ON THE ROUTES AND NOT THROUGH A LOGIN ─────────────────────
 * The guards that enforce these decorators are global and already have their own tests; what
 * is worth protecting here is that these three particular routes carry the HIGH capability
 * rather than inheriting the controller's read-level one. That distinction is a single
 * decorator, it is invisible in review, and getting it wrong would let any admin with
 * ordinary operational read access retrieve a token that attaches this platform's webhook to
 * an AWS topic.
 *
 * `admin-surface.spec.ts` already proves every admin controller is gated at all. This proves
 * the bar for these routes specifically.
 */
describe('the SNS confirmation routes are held at the configuration capability', () => {
  const proto = NotificationOpsController.prototype as unknown as Record<string, () => unknown>;

  const ROUTES = ['snsPendingConfirmation', 'revealSnsConfirmation', 'markSnsConfirmed'] as const;

  it.each(ROUTES)('%s requires PLATFORM_CONFIG', (handler) => {
    const permissions = Reflect.getMetadata(ADMIN_PERMISSION_KEY, proto[handler]) as
      AdminPermission[] | undefined;
    expect(permissions).toBeDefined();
    expect(permissions).toContain(AdminPermission.PLATFORM_CONFIG);
  });

  it.each(ROUTES)('%s does not settle for the read-level capability', (handler) => {
    /*
      OPS_READ is the controller's floor and is held by the support desk. Inheriting it here —
      which is what happens if the handler decorator is ever removed — would widen who can read
      a confirmation token from "can change platform configuration" to "can look at the queue".
    */
    const permissions = (Reflect.getMetadata(ADMIN_PERMISSION_KEY, proto[handler]) ??
      []) as AdminPermission[];
    expect(permissions).not.toContain(AdminPermission.OPS_READ);
  });

  it('is reachable only by an admin role at all', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, NotificationOpsController) as Role[] | undefined;
    expect(roles).toBeDefined();
    expect(roles).toEqual(expect.arrayContaining([Role.ADMIN, Role.SUPER_ADMIN]));
    // Nothing organizer-level or customer-level may appear on this controller.
    expect(roles).not.toContain(Role.CUSTOMER);
    expect(roles).not.toContain(Role.ORGANIZER_OWNER);
    expect(roles).not.toContain(Role.CHECKIN_STAFF);
  });

  it('names handlers that actually exist, so the assertions above cannot be vacuous', () => {
    for (const handler of ROUTES) expect(typeof proto[handler]).toBe('function');
  });
});
