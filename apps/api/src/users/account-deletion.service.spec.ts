import { AccountDeletionService } from './account-deletion.service';
import { AppException } from '../common/errors';

/**
 * Deletion is irreversible and legally load-bearing, so these tests are as much about
 * what SURVIVES as about what is removed.
 */

function makeService(
  opts: {
    user?: unknown;
    ownerCounts?: { organizationId: string; _count: { _all: number } }[];
  } = {},
) {
  const tx = {
    refreshToken: { deleteMany: jest.fn() },
    pushSubscription: { deleteMany: jest.fn() },
    notificationPreference: { deleteMany: jest.fn() },
    notification: { deleteMany: jest.fn() },
    review: { deleteMany: jest.fn() },
    organizationMember: { deleteMany: jest.fn() },
    booking: { updateMany: jest.fn() },
    ticket: { updateMany: jest.fn() },
    user: { update: jest.fn() },
    auditLog: { create: jest.fn() },
  };

  const prisma = {
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          opts.user === undefined ? { id: 'u_1', status: 'ACTIVE', memberships: [] } : opts.user,
        ),
    },
    organizationMember: { groupBy: jest.fn().mockResolvedValue(opts.ownerCounts ?? []) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)),
  };

  return { service: new AccountDeletionService(prisma as never), prisma, tx };
}

describe('what is removed', () => {
  it('destroys every session so access ends immediately', async () => {
    const { service, tx } = makeService();

    await service.deleteMe('u_1');

    expect(tx.refreshToken.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u_1' } });
  });

  it('removes push subscriptions, notification prefs, notifications and reviews', async () => {
    const { service, tx } = makeService();

    await service.deleteMe('u_1');

    for (const model of [
      tx.pushSubscription,
      tx.notificationPreference,
      tx.notification,
      tx.review,
    ]) {
      expect(model.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u_1' } });
    }
  });

  it('revokes organization memberships', async () => {
    const { service, tx } = makeService();

    await service.deleteMe('u_1');

    expect(tx.organizationMember.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u_1' } });
  });
});

describe('what is retained, and anonymised', () => {
  it('keeps bookings but strips the personal data from them', async () => {
    const { service, tx } = makeService();

    await service.deleteMe('u_1');

    // updateMany, never deleteMany: the amounts, currency, reference and payment rows
    // are the records being retained for tax and dispute purposes.
    expect(tx.booking.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u_1' },
      data: { buyerName: 'Deleted user', buyerEmail: 'deleted+u_1@deleted.invalid' },
    });
    expect(tx.booking).not.toHaveProperty('deleteMany');
  });

  it('keeps tickets valid while removing the attendee identity', async () => {
    const { service, tx } = makeService();

    await service.deleteMe('u_1');

    const call = tx.ticket.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ attendeeUserId: 'u_1' });
    expect(call.data.attendeeUserId).toBeNull();
    expect(call.data.holderName).toBeNull();
    expect(call.data.holderEmail).toBeNull();
    // Deleting an account is not cancelling the tickets it bought — someone may be
    // about to walk through a gate with one.
    expect(call.data).not.toHaveProperty('status');
    expect(call.data).not.toHaveProperty('serial');
  });

  it('anonymises the user row rather than deleting it', async () => {
    const { service, tx } = makeService();

    await service.deleteMe('u_1');

    const data = tx.user.update.mock.calls[0][0].data;
    expect(data.status).toBe('DELETED');
    expect(data.email).toBe('deleted+u_1@deleted.invalid');
    expect(data.fullName).toBe('Deleted user');
    expect(data.roles).toEqual(['CUSTOMER']);
  });

  it('leaves a password hash that is valid bcrypt but matches nothing', async () => {
    const { service, tx } = makeService();

    await service.deleteMe('u_1');

    const hash = tx.user.update.mock.calls[0][0].data.passwordHash as string;
    // A sentinel string would make bcrypt.compare throw on a later login attempt,
    // turning a clean rejection into a 500.
    expect(hash).toMatch(/^\$2[aby]\$/);
    expect(hash).not.toContain('DELETED');
  });

  it('uses the reserved .invalid TLD so the address can never be routed', async () => {
    const { service, tx } = makeService();

    await service.deleteMe('u_1');

    expect(tx.user.update.mock.calls[0][0].data.email).toMatch(/@deleted\.invalid$/);
  });
});

describe('audit trail', () => {
  it('records the deletion without retaining personal data', async () => {
    const { service, tx } = makeService();

    await service.deleteMe('u_1', { reason: 'PRIVACY', ip: '203.0.113.9', userAgent: 'app/1.0' });

    const entry = tx.auditLog.create.mock.calls[0][0].data;
    expect(entry.action).toBe('USER_SELF_DELETED');
    expect(entry.entityId).toBe('u_1');
    // The old email must NOT be here: the audit log outlives the deletion, and a
    // subject-access request would surface it.
    expect(JSON.stringify(entry)).not.toContain('@');
  });

  it('reduces a free-text reason to a known category', async () => {
    const { service, tx } = makeService();

    await service.deleteMe('u_1', { reason: 'your app charged me twice, ref 12345' });

    // Verbatim grievances would be retained in a table that survives the deletion.
    expect(tx.auditLog.create.mock.calls[0][0].data.metadata.reason).toBe('OTHER');
  });

  it('records no reason when none was given', async () => {
    const { service, tx } = makeService();

    await service.deleteMe('u_1');

    expect(tx.auditLog.create.mock.calls[0][0].data.metadata.reason).toBeNull();
  });

  it('bounds the user agent', async () => {
    const { service, tx } = makeService();

    await service.deleteMe('u_1', { userAgent: 'x'.repeat(5000) });

    expect(tx.auditLog.create.mock.calls[0][0].data.metadata.userAgent).toHaveLength(200);
  });
});

describe('idempotency', () => {
  it('returns success for an already-deleted account instead of an error', async () => {
    const { service, tx } = makeService({
      user: { id: 'u_1', status: 'DELETED', memberships: [] },
    });

    const result = await service.deleteMe('u_1');

    // A client retrying after a dropped response must not be told its deletion failed.
    expect(result).toMatchObject({ status: 'DELETED', alreadyDeleted: true });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('does not re-anonymise or re-audit on a repeat call', async () => {
    const { service, tx } = makeService({
      user: { id: 'u_1', status: 'DELETED', memberships: [] },
    });

    await service.deleteMe('u_1');

    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
  });

  it('404s an unknown user', async () => {
    const { service } = makeService({ user: null });

    await expect(service.deleteMe('nope')).rejects.toBeInstanceOf(AppException);
  });
});

describe('organization owners', () => {
  const soleOwner = {
    id: 'u_1',
    status: 'ACTIVE',
    memberships: [{ organizationId: 'org_1', role: 'ORGANIZER_OWNER', status: 'ACTIVE' }],
  };

  it('refuses when the caller is the only active owner', async () => {
    const { service, tx } = makeService({
      user: soleOwner,
      ownerCounts: [{ organizationId: 'org_1', _count: { _all: 1 } }],
    });

    await expect(service.deleteMe('u_1')).rejects.toBeInstanceOf(AppException);
    // Nothing is touched — a customer-facing action must not half-dismantle a business.
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.refreshToken.deleteMany).not.toHaveBeenCalled();
  });

  it('allows deletion when another active owner remains', async () => {
    const { service, tx } = makeService({
      user: soleOwner,
      ownerCounts: [{ organizationId: 'org_1', _count: { _all: 2 } }],
    });

    await service.deleteMe('u_1');

    expect(tx.user.update).toHaveBeenCalled();
  });

  it('allows deletion for a non-owner member', async () => {
    const { service, tx } = makeService({
      user: {
        id: 'u_1',
        status: 'ACTIVE',
        memberships: [{ organizationId: 'org_1', role: 'ORGANIZER_MANAGER', status: 'ACTIVE' }],
      },
    });

    await service.deleteMe('u_1');

    expect(tx.user.update).toHaveBeenCalled();
  });

  it('ignores an inactive owner membership', async () => {
    const { service, tx } = makeService({
      user: {
        id: 'u_1',
        status: 'ACTIVE',
        memberships: [{ organizationId: 'org_1', role: 'ORGANIZER_OWNER', status: 'REMOVED' }],
      },
    });

    await service.deleteMe('u_1');

    expect(tx.user.update).toHaveBeenCalled();
  });

  it('blocks on ANY stranded organization when the user owns several', async () => {
    const { service } = makeService({
      user: {
        id: 'u_1',
        status: 'ACTIVE',
        memberships: [
          { organizationId: 'org_1', role: 'ORGANIZER_OWNER', status: 'ACTIVE' },
          { organizationId: 'org_2', role: 'ORGANIZER_OWNER', status: 'ACTIVE' },
        ],
      },
      // org_1 has a co-owner; org_2 does not.
      ownerCounts: [
        { organizationId: 'org_1', _count: { _all: 2 } },
        { organizationId: 'org_2', _count: { _all: 1 } },
      ],
    });

    await expect(service.deleteMe('u_1')).rejects.toBeInstanceOf(AppException);
  });
});

describe('atomicity', () => {
  it('performs every mutation inside one transaction', async () => {
    const { service, prisma } = makeService();

    await service.deleteMe('u_1');

    // A partial deletion — sessions gone but data intact, or the reverse — is worse
    // than either outcome.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
