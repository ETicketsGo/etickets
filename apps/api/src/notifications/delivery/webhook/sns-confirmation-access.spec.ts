import { AdminPermission, Role } from '@eticketsgo/shared-types';
import { ADMIN_PERMISSION_KEY, ROLES_KEY } from '../../../common/decorators';
import { NotificationOpsController } from '../notification-ops.controller';

/**
 * Who may read the SNS subscription confirmation status.
 *
 * ── WHY THIS IS ASSERTED ON THE ROUTES AND NOT THROUGH A LOGIN ─────────────────────
 * The guards that enforce these decorators are global and already have their own tests; what
 * is worth protecting here is that this route carries the HIGH capability rather than
 * inheriting the controller's read-level one: which topic the platform trusts is
 * configuration. And that the token-revealing routes of the retired manual flow (ADR-052) are
 * GONE -- since ADR-054 no token is ever held, and a route that could hand one out must not
 * quietly come back.
 *
 * `admin-surface.spec.ts` already proves every admin controller is gated at all. This proves
 * the bar for these routes specifically.
 */
describe('the SNS confirmation routes are held at the configuration capability', () => {
  const proto = NotificationOpsController.prototype as unknown as Record<string, () => unknown>;

  const ROUTES = ['snsPendingConfirmation'] as const;

  it.each(['revealSnsConfirmation', 'markSnsConfirmed'])(
    '%s no longer exists: nothing can reveal or hand-confirm a token',
    (handler) => {
      expect(proto[handler]).toBeUndefined();
    },
  );

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
