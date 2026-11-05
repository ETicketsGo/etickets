import { OrganizationsService } from './organizations.service';

/**
 * Unit: what removeMember revokes, and what it must leave alone.
 *
 * The real-Postgres specs (member-removal-revokes.integration-postgres.spec.ts and
 * checkins/offline/member-removal-device-revocation.http.integration-postgres.spec.ts) prove the
 * rows end up right. This pins the QUERY the revocation runs, so a change that widens it (other
 * organizations' devices, devices the person only approved) or narrows it (forgets PENDING or
 * SUSPENDED, forgets assigned devices) fails here in milliseconds, without a database.
 */
const OWNER = { id: 'owner1', email: 'o@e.test', fullName: 'Owner', roles: ['CUSTOMER'] };
const MEMBER = {
  id: 'm1',
  organizationId: 'org1',
  userId: 'door1',
  role: 'CHECKIN_STAFF',
  status: 'ACTIVE',
  user: { id: 'door1', email: 'd@e.test', fullName: 'Door' },
};

function build(opts: {
  member?: Record<string, unknown>;
  devices?: { id: string }[];
  activations?: { id: string }[];
  otherSeats?: number;
  roles?: string[];
}) {
  const member = { ...MEMBER, ...(opts.member ?? {}) };
  const tx = {
    organizationMember: {
      update: jest.fn().mockResolvedValue({ ...member, status: 'REMOVED' }),
    },
    checkInDevice: {
      findMany: jest.fn().mockResolvedValue(opts.devices ?? []),
      updateMany: jest.fn().mockResolvedValue({ count: (opts.devices ?? []).length }),
    },
    offlineActivation: {
      findMany: jest.fn().mockResolvedValue(opts.activations ?? []),
      updateMany: jest.fn().mockResolvedValue({ count: (opts.activations ?? []).length }),
    },
    refreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
    // A pending invitation is withdrawn with the seat; these members have none.
    accountInvitation: {
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
    },
  };
  const prisma = {
    organizationMember: {
      findUnique: jest.fn().mockResolvedValue(member),
      count: jest.fn().mockResolvedValue(opts.otherSeats ?? 0),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ roles: opts.roles ?? ['CUSTOMER'] }) },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const access = { assertMember: jest.fn().mockResolvedValue(undefined) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const svc = new OrganizationsService(
    prisma as never,
    access as never,
    audit as never,
    {} as never,
    { get: () => 'LOCAL' } as never,
  );
  return { svc, tx, prisma, audit };
}

describe('removeMember revokes the member check-in devices', () => {
  it('revokes, in the removal transaction, only this org devices the member registered or holds', async () => {
    const { svc, tx } = build({ devices: [{ id: 'dev1' }, { id: 'dev2' }] });
    const res = await svc.removeMember(OWNER as never, 'org1', 'm1');

    expect(tx.checkInDevice.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org1',
        status: { in: ['PENDING', 'ACTIVE', 'SUSPENDED'] },
        OR: [{ createdByUserId: 'door1' }, { assignedStaffUserId: 'door1' }],
      },
      select: { id: true },
    });
    // Not approvedByUserId: a device they approved for a teammate is the teammate's phone.
    expect(JSON.stringify(tx.checkInDevice.findMany.mock.calls[0][0])).not.toContain(
      'approvedByUserId',
    );
    expect(tx.checkInDevice.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['dev1', 'dev2'] } },
      data: {
        status: 'REVOKED',
        revokedAt: expect.any(Date),
        revokeReason: 'MEMBER_REMOVED',
        revokeReasons: { push: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z MEMBER_REMOVED$/) },
      },
    });
    // Their devices already revoked for another reason keep it; this reason is appended.
    expect(tx.checkInDevice.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ status: 'REVOKED', id: { notIn: ['dev1', 'dev2'] } }),
      data: {
        revokeReasons: { push: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z MEMBER_REMOVED$/) },
      },
    });
    expect(tx.organizationMember.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'REMOVED' } }),
    );
    expect(res).toMatchObject({ revoked: { devices: 2 } });
  });

  it('writes one CHECKIN_DEVICE_REVOKED audit entry per device, naming the removal', async () => {
    const { svc, audit } = build({ devices: [{ id: 'dev1' }, { id: 'dev2' }] });
    await svc.removeMember(OWNER as never, 'org1', 'm1');
    const deviceEntries = audit.record.mock.calls
      .map((c) => c[0])
      .filter((e) => e.action === 'CHECKIN_DEVICE_REVOKED');
    expect(deviceEntries).toEqual([
      expect.objectContaining({
        actorUserId: 'owner1',
        organizationId: 'org1',
        entityType: 'CheckInDevice',
        entityId: 'dev1',
        metadata: { reason: 'MEMBER_REMOVED', memberId: 'm1' },
      }),
      expect.objectContaining({ entityId: 'dev2' }),
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'MEMBER_REMOVED',
        metadata: expect.objectContaining({ devicesRevoked: 2 }),
      }),
    );
  });

  it('revokes no device when the member has no live one (only appends to already-revoked ones)', async () => {
    const { svc, tx, audit } = build({ devices: [] });
    const res = await svc.removeMember(OWNER as never, 'org1', 'm1');
    for (const [arg] of tx.checkInDevice.updateMany.mock.calls) {
      expect(arg.where.status).toBe('REVOKED');
      expect(arg.data).not.toHaveProperty('status');
    }
    expect(audit.record.mock.calls.map((c) => c[0].action)).not.toContain('CHECKIN_DEVICE_REVOKED');
    expect(res).toMatchObject({ revoked: { devices: 0 } });
  });

  it('revokes devices even when the person keeps a seat elsewhere (only sessions are kept)', async () => {
    const { svc, tx } = build({ devices: [{ id: 'dev1' }], otherSeats: 1 });
    const res = await svc.removeMember(OWNER as never, 'org1', 'm1');
    expect(tx.checkInDevice.updateMany).toHaveBeenCalled();
    expect(tx.refreshToken.updateMany).not.toHaveBeenCalled();
    expect(res).toMatchObject({ revoked: { devices: 1, sessions: 0, signedOut: false } });
  });

  it('touches nothing when the member was already removed', async () => {
    const { svc, prisma, tx } = build({
      member: { status: 'REMOVED' },
      devices: [{ id: 'dev1' }],
    });
    await svc.removeMember(OWNER as never, 'org1', 'm1');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.checkInDevice.updateMany).not.toHaveBeenCalled();
  });
});
