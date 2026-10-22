import { AdminUsersService } from './admin-users.service';
import { AdminStaffService } from './admin-staff.service';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../common/decorators';

/**
 * The rules about WHOSE account, and the promise that an action the log cannot record is not
 * made. The over-the-wire behaviour (the target's next request and refresh refused) is
 * admin-users.http.integration-postgres.spec.ts.
 *
 * The prisma here is an in-memory stand-in whose `$transaction` really rolls back: writes are
 * staged and only applied when the callback returns, so "the audit write failed" can be shown
 * to leave the account exactly as it was.
 */
type UserRow = { id: string; email: string; roles: string[]; status: string };

function fakeDb(users: UserRow[], opts: { auditFails?: boolean } = {}) {
  const state = {
    users: new Map(users.map((u) => [u.id, { ...u }])),
    tokens: [
      { id: 't1', userId: 'cust', revokedAt: null as Date | null },
      { id: 't2', userId: 'cust', revokedAt: null as Date | null },
      { id: 't3', userId: 'other', revokedAt: null as Date | null },
    ],
    grants: new Map<string, string[]>(),
    audit: [] as Record<string, unknown>[],
  };
  const client = (staged: (() => void)[] | null) => {
    const apply = (fn: () => void) => (staged ? staged.push(fn) : fn());
    return {
      user: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          const u = state.users.get(where.id);
          return u
            ? {
                ...u,
                adminGrants: (state.grants.get(u.id) ?? []).map((permission) => ({ permission })),
              }
            : null;
        },
        update: async ({ where, data }: { where: { id: string }; data: { status: string } }) => {
          apply(() => Object.assign(state.users.get(where.id)!, data));
          return {};
        },
      },
      refreshToken: {
        updateMany: async ({ where }: { where: { userId: string } }) => {
          const hit = state.tokens.filter((t) => t.userId === where.userId && !t.revokedAt);
          apply(() => hit.forEach((t) => (t.revokedAt = new Date())));
          return { count: hit.length };
        },
      },
      adminGrant: {
        deleteMany: async ({ where }: { where: { userId: string } }) => {
          apply(() => state.grants.delete(where.userId));
          return { count: 0 };
        },
        createMany: async ({ data }: { data: { userId: string; permission: string }[] }) => {
          apply(() =>
            state.grants.set(
              data[0].userId,
              data.map((d) => d.permission),
            ),
          );
          return { count: data.length };
        },
      },
      auditLog: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          if (opts.auditFails) throw new Error('audit table unavailable');
          apply(() => state.audit.push(data));
          return {};
        },
      },
    };
  };
  const db = {
    ...client(null),
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const staged: (() => void)[] = [];
      const out = await fn(client(staged));
      staged.forEach((s) => s());
      return out;
    },
  };
  return { db, state };
}

const actor = (id: string, roles: string[] = ['ADMIN']): RequestUser =>
  ({ id, email: `${id}@t.test`, fullName: id, roles }) as RequestUser;

const USERS: UserRow[] = [
  { id: 'cust', email: 'c@t.test', roles: ['CUSTOMER'], status: 'ACTIVE' },
  { id: 'other', email: 'o@t.test', roles: ['CUSTOMER'], status: 'ACTIVE' },
  { id: 'desk', email: 'd@t.test', roles: ['ADMIN'], status: 'ACTIVE' },
  { id: 'boss', email: 'b@t.test', roles: ['ADMIN', 'SUPER_ADMIN'], status: 'ACTIVE' },
  { id: 'boss2', email: 'b2@t.test', roles: ['ADMIN', 'SUPER_ADMIN'], status: 'ACTIVE' },
];

function users(opts: { auditFails?: boolean } = {}) {
  const { db, state } = fakeDb(USERS, opts);
  const audit = new AuditService(db as never);
  return { state, service: new AdminUsersService(db as never, audit) };
}

describe('suspending an account', () => {
  it('suspends, revokes every session of that account only, and audits who, whom, why and where', async () => {
    const { service, state } = users();
    const out = await service.suspend(actor('desk'), 'cust', ' Chargeback fraud ', {
      ip: '203.0.113.7',
    });
    expect(out).toEqual({ userId: 'cust', status: 'SUSPENDED', sessionsRevoked: 2 });
    expect(state.users.get('cust')!.status).toBe('SUSPENDED');
    expect(state.tokens.filter((t) => t.userId === 'cust').every((t) => t.revokedAt)).toBe(true);
    expect(state.tokens.find((t) => t.userId === 'other')!.revokedAt).toBeNull();
    expect(state.audit).toEqual([
      expect.objectContaining({
        actorUserId: 'desk',
        action: 'USER_SUSPENDED',
        entityType: 'User',
        entityId: 'cust',
        ip: '203.0.113.7',
        metadata: expect.objectContaining({ reason: 'Chargeback fraud', previousStatus: 'ACTIVE' }),
      }),
    ]);
  });

  it('is not made at all when its audit row cannot be written', async () => {
    const { service, state } = users({ auditFails: true });
    await expect(service.suspend(actor('desk'), 'cust', 'fraud')).rejects.toThrow(/audit/);
    expect(state.users.get('cust')!.status).toBe('ACTIVE');
    expect(state.tokens.every((t) => t.revokedAt === null)).toBe(true);
  });

  it('refuses your own account', async () => {
    const { service, state } = users();
    await expect(service.suspend(actor('desk'), 'desk', 'oops')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(state.users.get('desk')!.status).toBe('ACTIVE');
    expect(state.audit).toEqual([]);
  });

  it('refuses a super admin to anybody who is not one, and allows it to one who is', async () => {
    const { service, state } = users();
    await expect(service.suspend(actor('desk'), 'boss', 'coup')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(state.users.get('boss')!.status).toBe('ACTIVE');
    await service.suspend(actor('boss2', ['ADMIN', 'SUPER_ADMIN']), 'boss', 'left the company');
    expect(state.users.get('boss')!.status).toBe('SUSPENDED');
  });

  it('needs a reason', async () => {
    const { service } = users();
    await expect(service.suspend(actor('desk'), 'cust', '   ')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('is idempotent: suspending a suspended account writes nothing', async () => {
    const { service, state } = users();
    await service.suspend(actor('desk'), 'cust', 'fraud');
    state.audit.length = 0;
    await expect(service.suspend(actor('desk'), 'cust', 'fraud')).resolves.toMatchObject({
      status: 'SUSPENDED',
      sessionsRevoked: 0,
    });
    expect(state.audit).toEqual([]);
  });
});

describe('reinstating and ending sessions', () => {
  it('reinstates a suspended account and audits it', async () => {
    const { service, state } = users();
    await service.suspend(actor('desk'), 'cust', 'fraud');
    await service.reinstate(actor('desk'), 'cust', 'cleared', { ip: '198.51.100.2' });
    expect(state.users.get('cust')!.status).toBe('ACTIVE');
    expect(state.audit.at(-1)).toMatchObject({
      action: 'USER_REINSTATED',
      actorUserId: 'desk',
      entityId: 'cust',
      ip: '198.51.100.2',
    });
  });

  it('refuses to reinstate an account that is not suspended', async () => {
    const { service } = users();
    await expect(service.reinstate(actor('desk'), 'cust', undefined)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('revoke-sessions revokes every refresh token of that account and leaves its status', async () => {
    const { service, state } = users();
    const out = await service.revokeSessions(actor('desk'), 'cust', 'lost phone');
    expect(out.sessionsRevoked).toBe(2);
    expect(state.tokens.filter((t) => t.userId === 'cust').every((t) => t.revokedAt)).toBe(true);
    expect(state.users.get('cust')!.status).toBe('ACTIVE');
    expect(state.audit).toEqual([
      expect.objectContaining({ action: 'USER_SESSIONS_REVOKED', actorUserId: 'desk' }),
    ]);
  });

  it('revoke-sessions is not made when its audit row cannot be written', async () => {
    const { service, state } = users({ auditFails: true });
    await expect(service.revokeSessions(actor('desk'), 'cust', undefined)).rejects.toThrow();
    expect(state.tokens.every((t) => t.revokedAt === null)).toBe(true);
  });

  it('revoke-sessions refuses your own account and a super admin to a non-super', async () => {
    const { service } = users();
    await expect(service.revokeSessions(actor('desk'), 'desk', undefined)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(service.revokeSessions(actor('desk'), 'boss', undefined)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('a staff manager cannot change their own duties', () => {
  function staff(opts: { auditFails?: boolean } = {}) {
    const { db, state } = fakeDb(USERS, opts);
    const audit = new AuditService(db as never);
    return { state, service: new AdminStaffService(db as never, audit, {} as never) };
  }

  it('refuses a self-grant, and nothing is written or read', async () => {
    const { service, state } = staff();
    await expect(
      service.setPermissions(actor('desk'), 'desk', ['REFUND_APPROVE', 'PAYOUT_EXECUTE'] as never),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(state.grants.get('desk')).toBeUndefined();
    expect(state.audit).toEqual([]);
  });

  it('refuses a self-removal too: a change to your own set needs a second person', async () => {
    const { service } = staff();
    await expect(service.setPermissions(actor('desk'), 'desk', [])).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('still lets them change ANOTHER account, audited in the same transaction', async () => {
    const { service, state } = staff();
    const other = { id: 'desk2', email: 'd2@t.test', roles: ['ADMIN'], status: 'ACTIVE' };
    state.users.set(other.id, other);
    await service.setPermissions(actor('desk'), 'desk2', ['REFUND_REVIEW'] as never, 'rota', {
      ip: '203.0.113.9',
    });
    expect(state.grants.get('desk2')).toEqual(['REFUND_REVIEW']);
    expect(state.audit).toEqual([
      expect.objectContaining({
        actorUserId: 'desk',
        action: 'ADMIN_PERMISSIONS_CHANGED',
        entityId: 'desk2',
        ip: '203.0.113.9',
        metadata: expect.objectContaining({ before: [], after: ['REFUND_REVIEW'] }),
      }),
    ]);
  });

  it('does not change the grants when the audit row cannot be written', async () => {
    const { service, state } = staff({ auditFails: true });
    state.users.set('desk2', {
      id: 'desk2',
      email: 'd2@t.test',
      roles: ['ADMIN'],
      status: 'ACTIVE',
    });
    state.grants.set('desk2', ['BOOKING_READ']);
    await expect(
      service.setPermissions(actor('desk'), 'desk2', ['REFUND_APPROVE'] as never),
    ).rejects.toThrow(/audit/);
    expect(state.grants.get('desk2')).toEqual(['BOOKING_READ']);
  });
});
