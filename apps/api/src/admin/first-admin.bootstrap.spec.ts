import { Role } from '@prisma/client';
import { FirstAdminBootstrap } from './first-admin.bootstrap';

/**
 * This grants the highest privilege in the system, so what it REFUSES is the whole test.
 */
function harness(opts: {
  email?: string;
  existingAdmins?: number;
  user?: { id: string; email: string; roles: Role[] } | null;
}) {
  const updates: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const prisma = {
    user: {
      count: jest.fn().mockResolvedValue(opts.existingAdmins ?? 0),
      findUnique: jest.fn().mockResolvedValue(opts.user ?? null),
      update: jest.fn(async (args: Record<string, unknown>) => {
        updates.push(args);
        return {};
      }),
    },
  };
  const config = { get: jest.fn().mockReturnValue(opts.email) };
  const audit = { record: jest.fn(async (e: Record<string, unknown>) => void audits.push(e)) };
  const svc = new FirstAdminBootstrap(prisma as never, config as never, audit as never);
  return { svc, prisma, updates, audits };
}

const somebody = { id: 'u1', email: 'owner@eticketsgo.com', roles: [Role.CUSTOMER] };

describe('FirstAdminBootstrap', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('does nothing when the variable is unset', async () => {
    const h = harness({ email: undefined, user: somebody });
    await h.svc.onModuleInit();
    expect(h.prisma.user.count).not.toHaveBeenCalled();
    expect(h.updates).toHaveLength(0);
  });

  it('does nothing once the environment already has an administrator', async () => {
    /*
      The condition that makes this safe. Once any admin exists - including the one it just made -
      it is inert for ever, so it cannot be used to add a second administrator later.
    */
    const h = harness({ email: 'owner@eticketsgo.com', existingAdmins: 1, user: somebody });
    await h.svc.onModuleInit();
    expect(h.updates).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it('never creates an account for an address that has none', async () => {
    // Minting a login here would mean handing out a password the holder never chose.
    const h = harness({ email: 'nobody@eticketsgo.com', existingAdmins: 0, user: null });
    await h.svc.onModuleInit();
    expect(h.updates).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it('promotes the named account when the environment has no administrator', async () => {
    const h = harness({ email: 'owner@eticketsgo.com', existingAdmins: 0, user: somebody });
    await h.svc.onModuleInit();
    expect(h.updates).toHaveLength(1);
    const roles = (h.updates[0].data as { roles: { set: Role[] } }).roles.set;
    expect(roles).toContain(Role.ADMIN);
    expect(roles).toContain(Role.SUPER_ADMIN);
    // The role it already had is kept, not replaced.
    expect(roles).toContain(Role.CUSTOMER);
  });

  it('records it in the audit log with no actor, because no human did it', async () => {
    const h = harness({ email: 'owner@eticketsgo.com', existingAdmins: 0, user: somebody });
    await h.svc.onModuleInit();
    expect(h.audits[0]).toMatchObject({
      action: 'ADMIN_ROLE_GRANTED',
      entityType: 'User',
      entityId: 'u1',
    });
    expect(h.audits[0].actorUserId).toBeUndefined();
  });

  it('does not duplicate a role the account already holds', async () => {
    const h = harness({
      email: 'owner@eticketsgo.com',
      existingAdmins: 0,
      user: { id: 'u1', email: 'owner@eticketsgo.com', roles: [Role.ADMIN] },
    });
    await h.svc.onModuleInit();
    const roles = (h.updates[0].data as { roles: { set: Role[] } }).roles.set;
    expect(roles.filter((r) => r === Role.ADMIN)).toHaveLength(1);
  });

  it('never refuses to serve when the database is unreachable', async () => {
    // A back-office role is not worth taking a storefront down over.
    const h = harness({ email: 'owner@eticketsgo.com', existingAdmins: 0, user: somebody });
    h.prisma.user.count.mockRejectedValue(new Error('connection refused'));
    await expect(h.svc.onModuleInit()).resolves.toBeUndefined();
  });
});
