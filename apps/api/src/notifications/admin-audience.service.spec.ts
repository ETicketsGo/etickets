import { NotificationType, Role } from '@eticketsgo/shared-types';
import { AdminAudienceService } from './admin-audience.service';

/**
 * Reaching the people who approve things.
 *
 * Every notification before this was addressed to ONE known recipient. Approvals are the
 * opposite shape — "whoever can act on this" — which is why an organization could register
 * and an event could be submitted with nothing telling a human to look.
 *
 * These tests are mostly about the failure paths, because this code runs INSIDE the request
 * that registers an organization. If it throws, the registration is lost; if it goes quiet,
 * a review queue fills up unseen. Neither is acceptable, and they pull in opposite
 * directions.
 */
const makeService = (over: {
  users?: { id: string; email: string }[];
  members?: { user: { id: string; email: string } }[];
  send?: jest.Mock;
  findUsers?: jest.Mock;
  findMembers?: jest.Mock;
}) => {
  const send = over.send ?? jest.fn().mockResolvedValue(undefined);
  const findUsers = over.findUsers ?? jest.fn().mockResolvedValue(over.users ?? []);
  const findMembers = over.findMembers ?? jest.fn().mockResolvedValue(over.members ?? []);
  const prisma = {
    user: { findMany: findUsers },
    organizationMember: { findMany: findMembers },
  } as never;
  const notifications = { send } as never;
  return { service: new AdminAudienceService(prisma, notifications), send, findUsers, findMembers };
};

describe('notifying admins', () => {
  it('sends one notification per admin, not a single shared one', () => {
    // Each admin gets it in their own inbox and on their own devices. One admin reading it
    // must not make it disappear for the rest.
    const { service, send } = makeService({
      users: [
        { id: 'a1', email: 'one@x.test' },
        { id: 'a2', email: 'two@x.test' },
      ],
    });
    return service
      .notifyAdmins(NotificationType.ORGANIZATION_REGISTERED, { organizationName: 'Asha' })
      .then((count) => {
        expect(count).toBe(2);
        expect(send).toHaveBeenCalledTimes(2);
        expect(send.mock.calls.map((c) => c[0].userId).sort()).toEqual(['a1', 'a2']);
        // Addressed by BOTH id and email: the id reaches the in-app inbox and push, the
        // email reaches someone who has not opened the console in a month.
        expect(send.mock.calls[0][0].toEmail).toBe('one@x.test');
      });
  });

  it('only pages ACTIVE admins', async () => {
    const { service, findUsers } = makeService({ users: [] });
    await service.notifyAdmins(NotificationType.EVENT_SUBMITTED, {});
    const where = findUsers.mock.calls[0][0].where;
    // A suspended or deleted admin must not be paged, and cannot act anyway.
    expect(where.status).toBe('ACTIVE');
    expect(where.OR).toEqual([
      { roles: { has: Role.ADMIN } },
      { roles: { has: Role.SUPER_ADMIN } },
    ]);
  });

  it('reports zero when there is no admin at all', async () => {
    // Worth surfacing: an approval queue with no reviewers is a queue nothing leaves.
    const { service, send } = makeService({ users: [] });
    await expect(service.notifyAdmins(NotificationType.EVENT_SUBMITTED, {})).resolves.toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('NEVER throws when a single delivery fails', async () => {
    /*
      This runs inside the request that creates the organization. Throwing here would roll
      the caller back and lose a registration over an email outage — the notification is the
      least important thing happening in that request.
    */
    const send = jest
      .fn()
      .mockRejectedValueOnce(new Error('smtp down'))
      .mockResolvedValueOnce(undefined);
    const { service } = makeService({
      users: [
        { id: 'a1', email: 'one@x.test' },
        { id: 'a2', email: 'two@x.test' },
      ],
      send,
    });
    await expect(service.notifyAdmins(NotificationType.ORGANIZATION_REGISTERED, {})).resolves.toBe(
      2,
    );
    // The healthy admin is still notified — one bad address does not silence the rest.
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('NEVER throws when the lookup itself fails', async () => {
    const { service } = makeService({
      findUsers: jest.fn().mockRejectedValue(new Error('db down')),
    });
    await expect(service.notifyAdmins(NotificationType.EVENT_SUBMITTED, {})).resolves.toBe(0);
  });
});

describe('notifying an organization', () => {
  it('goes to the OWNERS, not every member', async () => {
    // A decision about the business belongs to whoever runs it. Copying in every check-in
    // staffer is how people learn to ignore the channel.
    const { service, findMembers } = makeService({
      members: [{ user: { id: 'u1', email: 'owner@x.test' } }],
    });
    await service.notifyOrganizationOwners('org1', NotificationType.ORGANIZATION_APPROVED, {});
    expect(findMembers.mock.calls[0][0].where).toEqual({
      organizationId: 'org1',
      role: Role.ORGANIZER_OWNER,
    });
  });

  it('carries the rejection reason through to the recipient', async () => {
    const { service, send } = makeService({
      members: [{ user: { id: 'u1', email: 'owner@x.test' } }],
    });
    await service.notifyOrganizationOwners('org1', NotificationType.ORGANIZATION_REJECTED, {
      reason: 'Registration document unreadable',
    });
    // "Rejected" with no cause leaves somebody unable to act, and support answering the
    // same question every time.
    expect(send.mock.calls[0][0].payload.reason).toBe('Registration document unreadable');
  });

  it('does not throw when an organization somehow has no owner', async () => {
    const { service } = makeService({ members: [] });
    await expect(
      service.notifyOrganizationOwners('org1', NotificationType.ORGANIZATION_APPROVED, {}),
    ).resolves.toBe(0);
  });
});
