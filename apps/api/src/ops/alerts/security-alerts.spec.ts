import { Logger } from '@nestjs/common';
import { Role, UserStatus } from '@eticketsgo/shared-types';
import { AuditService, type AuditEntry } from '../../audit/audit.service';
import { AdminStaffService } from '../../admin/admin-staff.service';
import { AdminUsersService } from '../../admin/admin-users.service';
import { LoginBackoff } from '../../auth/login-backoff';
import type { RedisService } from '../../redis/redis.service';
import { OpsAlertService, type OpsAlert } from './ops-alert.service';
import { securityAlertForAudit } from './security-audit-alerts';

/**
 * Security signals that now reach a person: a replayed session token, a locked back-office
 * second factor, a change of who holds power, and many accounts made to wait at once.
 *
 * No real email is sent. The transport is a recording fake; Redis is an in-memory fake.
 */

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

function spyAlerts() {
  const seen: OpsAlert[] = [];
  return {
    seen,
    notify: jest.fn(async (a: OpsAlert) => {
      seen.push(a);
      return { raised: true, count: 1, delivered: 0 };
    }),
  };
}

function realAlerts(clock: () => number = () => Date.UTC(2026, 9, 22, 12)) {
  const sent: Array<{ subject: string; body: string }> = [];
  const transport = {
    name: 'ses',
    send: jest.fn(async (m: { subject: string; body: string }) => {
      sent.push(m);
      return { provider: 'ses' };
    }),
  };
  const config = {
    get: (k: string) => ({ OPS_ALERT_EMAILS: 'ops@eticketsgo.test', APP_ENV: 'QA' })[k],
  };
  const service = new OpsAlertService(config as never, transport as never, undefined, clock);
  return { service, sent };
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterAll(() => jest.restoreAllMocks());

describe('securityAlertForAudit', () => {
  it('maps a refresh token reuse to one grouped alert, with the account id only', () => {
    const alert = securityAlertForAudit({
      actorUserId: 'user_1',
      action: 'AUTH_TOKEN_REUSE_DETECTED',
      entityType: 'RefreshToken',
      entityId: 'rt_1',
      metadata: { familyRevoked: true },
      ip: '203.0.113.7',
    });
    expect(alert).toMatchObject({ kind: 'AUTH_REFRESH_TOKEN_REUSE', key: 'all' });
    expect(alert?.facts.userId).toBe('user_1');
    expect(JSON.stringify(alert)).not.toContain('203.0.113.7');
  });

  it('maps an MFA lockout, keyed by the locked account', () => {
    const alert = securityAlertForAudit({
      actorUserId: 'admin_1',
      action: 'MFA_LOCKED_OUT',
      entityType: 'User',
      entityId: 'admin_1',
      metadata: { minutes: 15 },
    });
    expect(alert).toMatchObject({ kind: 'ADMIN_MFA_LOCKOUT', key: 'admin_1' });
    expect(alert?.facts.lockedMinutes).toBe(15);
  });

  it('names the duties added and removed, never the email address in the entry', () => {
    const alert = securityAlertForAudit({
      actorUserId: 'boss_1',
      action: 'ADMIN_PERMISSIONS_CHANGED',
      entityType: 'User',
      entityId: 'staff_1',
      metadata: {
        email: 'staff@example.com',
        before: ['REFUND_REVIEW'],
        after: ['PAYOUT_EXECUTE', 'REFUND_APPROVE'],
        note: 'asked by asha@example.com',
      },
    });
    expect(alert).toMatchObject({ kind: 'ADMIN_ACCESS_CHANGED', key: 'staff_1' });
    expect(alert?.facts).toMatchObject({
      changedBy: 'boss_1',
      account: 'staff_1',
      added: 'PAYOUT_EXECUTE REFUND_APPROVE',
      removed: 'REFUND_REVIEW',
    });
    expect(JSON.stringify(alert)).not.toMatch(/@example\.com/);
  });

  it('alerts on a suspended member of staff, not on a suspended customer', () => {
    const base: AuditEntry = {
      actorUserId: 'support_1',
      action: 'USER_SUSPENDED',
      entityType: 'User',
      entityId: 'u_9',
      metadata: { email: 'x@example.com', reason: 'abuse' },
    };
    expect(securityAlertForAudit(base)).toBeNull();
    expect(
      securityAlertForAudit({ ...base, metadata: { ...base.metadata, backOffice: true } }),
    ).toMatchObject({ kind: 'ADMIN_ACCESS_CHANGED', facts: { action: 'USER_SUSPENDED' } });
  });

  it('ignores every ordinary action', () => {
    for (const action of ['AUTH_LOGIN', 'AUTH_LOGIN_FAILED', 'PAYMENT_AMOUNT_MISMATCH']) {
      expect(securityAlertForAudit({ action, entityType: 'User' })).toBeNull();
    }
  });
});

describe('AuditService raises security alerts', () => {
  const prisma = () => ({ auditLog: { create: jest.fn().mockResolvedValue({}) } });

  it('record() raises the alert for an alerting action', async () => {
    const alerts = spyAlerts();
    const audit = new AuditService(prisma() as never, alerts as never);
    await audit.record({
      actorUserId: 'user_1',
      action: 'AUTH_TOKEN_REUSE_DETECTED',
      entityType: 'RefreshToken',
    });
    expect(alerts.seen.map((a) => a.kind)).toEqual(['AUTH_REFRESH_TOKEN_REUSE']);
  });

  it('recordInTransaction() raises nothing: the transaction may still roll back', async () => {
    const alerts = spyAlerts();
    const audit = new AuditService(prisma() as never, alerts as never);
    await audit.recordInTransaction(prisma() as never, {
      actorUserId: 'boss_1',
      action: 'ADMIN_PERMISSIONS_CHANGED',
      entityType: 'User',
      entityId: 'staff_1',
    });
    expect(alerts.notify).not.toHaveBeenCalled();
  });

  it('a broken alert service cannot fail the audited action', async () => {
    const audit = new AuditService(
      prisma() as never,
      {
        notify: () => {
          throw new Error('boom');
        },
      } as never,
    );
    await expect(
      audit.record({ action: 'MFA_LOCKED_OUT', entityType: 'User', entityId: 'a1' }),
    ).resolves.toBeUndefined();
  });

  it('the email carries ids only: no address, no client IP, no typed reason', async () => {
    const { service, sent } = realAlerts();
    const audit = new AuditService(prisma() as never, service);
    audit.afterCommit({
      actorUserId: 'boss_1',
      action: 'USER_SUSPENDED',
      entityType: 'User',
      entityId: 'staff_1',
      metadata: {
        email: 'staff.member@example.com',
        reason: 'call +91 98765 43210',
        backOffice: true,
      },
      ip: '203.0.113.7',
    });
    await flush();
    expect(sent).toHaveLength(1);
    const text = `${sent[0].subject}\n${sent[0].body}`;
    expect(text).toContain('staff_1');
    expect(text).toContain('boss_1');
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('98765');
    expect(text).not.toContain('203.0.113.7');
  });

  it('a replay storm is one email per window, carrying the count', async () => {
    let now = Date.UTC(2026, 9, 22, 12);
    const { service, sent } = realAlerts(() => now);
    const audit = new AuditService(prisma() as never, service);
    for (let i = 0; i < 5; i++) {
      await audit.record({
        actorUserId: `user_${i}`,
        action: 'AUTH_TOKEN_REUSE_DETECTED',
        entityType: 'RefreshToken',
      });
      await flush();
    }
    expect(sent).toHaveLength(1);
    now += 16 * 60_000;
    await audit.record({
      actorUserId: 'user_9',
      action: 'AUTH_TOKEN_REUSE_DETECTED',
      entityType: 'RefreshToken',
    });
    await flush();
    expect(sent).toHaveLength(2);
    expect(sent[1].body).toContain('Occurrences: 5 since the last alert');
  });
});

describe('staff changes alert only after they commit', () => {
  const actor = { id: 'boss_1', roles: [Role.SUPER_ADMIN] } as never;

  function staffHarness(opts: { txFails?: boolean } = {}) {
    const alerts = spyAlerts();
    const tx = {
      adminGrant: { deleteMany: jest.fn(), createMany: jest.fn() },
      auditLog: { create: jest.fn() },
      user: { update: jest.fn() },
      refreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
    };
    const prisma = {
      auditLog: { create: jest.fn() },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'staff_1',
          email: 'staff@example.com',
          roles: [Role.CUSTOMER, Role.ADMIN],
          status: UserStatus.ACTIVE,
          adminGrants: [{ permission: 'REFUND_REVIEW' }],
        }),
      },
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => {
        const out = await fn(tx);
        if (opts.txFails) throw new Error('serialization failure');
        return out;
      }),
    };
    const audit = new AuditService(prisma as never, alerts as never);
    return { alerts, audit, prisma };
  }

  it('a duty change is mailed once it has committed', async () => {
    const { alerts, audit, prisma } = staffHarness();
    const staff = new AdminStaffService(prisma as never, audit, {} as never);
    await staff.setPermissions(actor, 'staff_1', ['REFUND_APPROVE'] as never);
    expect(alerts.seen).toHaveLength(1);
    expect(alerts.seen[0]).toMatchObject({
      kind: 'ADMIN_ACCESS_CHANGED',
      facts: { added: 'REFUND_APPROVE', removed: 'REFUND_REVIEW' },
    });
  });

  it('a duty change that rolled back is not mailed', async () => {
    const { alerts, audit, prisma } = staffHarness({ txFails: true });
    const staff = new AdminStaffService(prisma as never, audit, {} as never);
    await expect(
      staff.setPermissions(actor, 'staff_1', ['REFUND_APPROVE'] as never),
    ).rejects.toThrow('serialization failure');
    expect(alerts.notify).not.toHaveBeenCalled();
  });

  it('suspending a member of staff is mailed; the result is unchanged', async () => {
    const { alerts, audit, prisma } = staffHarness();
    const users = new AdminUsersService(prisma as never, audit);
    await expect(users.suspend(actor, 'staff_1', 'left the company')).resolves.toEqual({
      userId: 'staff_1',
      status: UserStatus.SUSPENDED,
      sessionsRevoked: 2,
    });
    expect(alerts.seen.map((a) => a.facts.action)).toEqual(['USER_SUSPENDED']);
  });

  it('suspending a customer is not mailed', async () => {
    const { alerts, audit, prisma } = staffHarness();
    prisma.user.findUnique.mockResolvedValue({
      id: 'cust_1',
      email: 'c@example.com',
      roles: [Role.CUSTOMER],
      status: UserStatus.ACTIVE,
    });
    const users = new AdminUsersService(prisma as never, audit);
    await users.suspend(actor, 'cust_1', 'chargeback abuse');
    expect(alerts.notify).not.toHaveBeenCalled();
  });
});

describe('LoginBackoff burst alert', () => {
  const settings = (over: Record<string, string> = {}) =>
    ({
      get: (k: string) =>
        ({
          LOGIN_BACKOFF_THRESHOLD: '2',
          LOGIN_BACKOFF_BURST_THRESHOLD: '3',
          LOGIN_BACKOFF_BURST_WINDOW_MINUTES: '15',
          ...over,
        })[k],
    }) as never;

  /** ioredis enough for the backoff script, INCR, PEXPIRE and PTTL, shared by "replicas". */
  function fakeRedis() {
    const counts = new Map<string, number>();
    const client = {
      eval: jest.fn(async (_s: string, _n: number, key: string, _w: string, threshold: string) => {
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return [n, n >= Number(threshold) ? 30_000 : 0];
      }),
      incr: jest.fn(async (key: string) => {
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return n;
      }),
      pexpire: jest.fn(async () => 1),
      pttl: jest.fn(async () => -2),
      del: jest.fn(async () => 1),
    };
    return { client } as unknown as RedisService;
  }

  async function failTimes(b: LoginBackoff, email: string, times: number) {
    for (let i = 0; i < times; i++) await b.recordFailure(email);
    await flush();
  }

  it('alerts once when enough DIFFERENT accounts start waiting, across replicas', async () => {
    const alerts = spyAlerts();
    const redis = fakeRedis();
    const replicaA = new LoginBackoff(redis, settings(), alerts as never);
    const replicaB = new LoginBackoff(redis, settings(), alerts as never);
    // One account hammering is counted once, however many more times it fails.
    await failTimes(replicaA, 'asha@example.com', 10);
    await failTimes(replicaB, 'ravi@example.com', 2);
    expect(alerts.notify).not.toHaveBeenCalled();
    await failTimes(replicaA, 'meera@example.com', 2);
    expect(alerts.seen).toHaveLength(1);
    expect(alerts.seen[0]).toMatchObject({
      kind: 'LOGIN_BACKOFF_BURST',
      facts: { accounts: 3, threshold: 3, windowMinutes: 15 },
    });
    // More accounts in the same window: still one alert.
    await failTimes(replicaB, 'dev@example.com', 2);
    await failTimes(replicaA, 'lee@example.com', 2);
    expect(alerts.seen).toHaveLength(1);
    expect(JSON.stringify(alerts.seen[0])).not.toContain('@example.com');
  });

  it('counts per window: the next window can alert again', async () => {
    const alerts = spyAlerts();
    let now = Date.UTC(2026, 9, 22, 12);
    const b = new LoginBackoff(undefined, settings(), alerts as never);
    b.now = () => now;
    for (const who of ['a', 'b', 'c']) await failTimes(b, `${who}@example.com`, 2);
    expect(alerts.seen).toHaveLength(1);
    now += 15 * 60_000;
    for (const who of ['d', 'e']) await failTimes(b, `${who}@example.com`, 2);
    expect(alerts.seen).toHaveLength(1);
    await failTimes(b, 'f@example.com', 2);
    expect(alerts.seen).toHaveLength(2);
    expect(alerts.seen[1].key).not.toBe(alerts.seen[0].key);
  });

  it('0 turns the alert off, and the backoff itself is unchanged', async () => {
    const alerts = spyAlerts();
    const b = new LoginBackoff(
      undefined,
      settings({ LOGIN_BACKOFF_BURST_THRESHOLD: '0' }),
      alerts as never,
    );
    for (const who of ['a', 'b', 'c', 'd']) await failTimes(b, `${who}@example.com`, 2);
    expect(alerts.notify).not.toHaveBeenCalled();
    expect(await b.waitFor('a@example.com')).toBeGreaterThan(0);
  });

  it('a Redis that fails on the burst counter does not touch sign-in', async () => {
    const alerts = spyAlerts();
    const redis = fakeRedis();
    (redis.client.incr as jest.Mock).mockRejectedValue(new Error('READONLY'));
    const b = new LoginBackoff(redis, settings(), alerts as never);
    await expect(b.recordFailure('a@example.com')).resolves.toBe(0);
    await expect(b.recordFailure('a@example.com')).resolves.toBe(30_000);
    await flush();
    expect(alerts.notify).not.toHaveBeenCalled();
  });
});
