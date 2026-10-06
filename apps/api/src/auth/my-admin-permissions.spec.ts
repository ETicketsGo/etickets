import { Role, AdminPermission } from '@eticketsgo/shared-types';
import { AuthService } from './auth.service';

/**
 * What the console is told about its own operator.
 *
 * ── WHY THIS IS WORTH TESTING ──────────────────────────────────────────────────────
 * The back office enforces a set of named capabilities and the console knew nothing about
 * them, so it showed every operator the same twenty-four menu items and the same landing
 * page, and discovered what they were allowed to do by being refused. `GET /admin/dashboard`
 * needs `BOOKING_READ`, which the moderation duty does not grant - so somebody whose job is
 * approving organizers signed in and met "We couldn't load this. Please try again."
 *
 * The thing that must stay true is the direction of the trust: this says what to OFFER, never
 * what to ALLOW. Every route keeps its own guard, which reads the grants from the database on
 * each request, so a client holding a stale list can only ask and be refused.
 */
function makeService(grants: string[]) {
  const findMany = jest.fn().mockResolvedValue(grants.map((permission) => ({ permission })));
  const prisma = { adminGrant: { findMany } };
  const service = new AuthService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, findMany };
}

describe('AuthService.myAdminPermissions', () => {
  it('reports the grants an admin actually holds', async () => {
    const { service } = makeService([
      AdminPermission.ORGANIZER_REVIEW,
      AdminPermission.EVENT_REVIEW,
    ]);
    const { adminPermissions } = await service.myAdminPermissions('u1', [Role.ADMIN]);
    expect(adminPermissions).toEqual(['EVENT_REVIEW', 'ORGANIZER_REVIEW']);
  });

  it('gives a plain admin with no grants nothing, rather than everything', async () => {
    /*
      The failure that would matter. An `ADMIN` role carries no implicit capability - only
      SUPER_ADMIN does - so a freshly created back-office account holds none, and that is a
      real state rather than a defensive branch.

      Returning every capability "because they are an admin" would make the console offer
      queues and figures that every request then refuses, which is the behaviour this field
      exists to remove.
    */
    const { service } = makeService([]);
    const { adminPermissions } = await service.myAdminPermissions('u1', [Role.ADMIN]);
    expect(adminPermissions).toEqual([]);
  });

  it('gives a super admin everything without needing a single grant row', async () => {
    // By ROLE, not by holding every grant: an installation whose last super admin has had
    // ADMIN_MANAGE revoked is one nobody can repair, so the recovery path is not grantable.
    const { service } = makeService([]);
    const { adminPermissions } = await service.myAdminPermissions('u1', [Role.SUPER_ADMIN]);
    expect(adminPermissions).toContain('ADMIN_MANAGE');
    expect(adminPermissions).toContain('FINANCE_READ');
    expect(adminPermissions.length).toBeGreaterThan(5);
  });

  it('tells a customer nothing, and does not go looking', async () => {
    /*
      `/auth/me` is every signed-in person's endpoint, not an admin one. A customer must get an
      empty list - and the query must not run at all, because this is on the critical path of
      every page load in the storefront and an index lookup per visitor buys nothing.
    */
    const { service, findMany } = makeService([AdminPermission.FINANCE_READ]);
    const { adminPermissions } = await service.myAdminPermissions('u1', [Role.CUSTOMER]);
    expect(adminPermissions).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('is not fooled by a grant row on an account that is not staff', async () => {
    // A leftover grant on an account whose ADMIN role was taken away must not read as
    // authority. The role is the gate; the grants only say which parts of it.
    const { service } = makeService([AdminPermission.REFUND_APPROVE]);
    const { adminPermissions } = await service.myAdminPermissions('u1', [Role.ORGANIZER_OWNER]);
    expect(adminPermissions).toEqual([]);
  });

  it('answers in a stable order whatever order the rows arrive in', async () => {
    // Grants come out of a database and then a Set, and neither promises an order. An
    // unstable list would invalidate the client's cached profile on every request for no
    // reason at all.
    const a = makeService([AdminPermission.PAYOUT_MANAGE, AdminPermission.BOOKING_READ]);
    const b = makeService([AdminPermission.BOOKING_READ, AdminPermission.PAYOUT_MANAGE]);
    expect((await a.service.myAdminPermissions('u1', [Role.ADMIN])).adminPermissions).toEqual(
      (await b.service.myAdminPermissions('u1', [Role.ADMIN])).adminPermissions,
    );
  });
});
