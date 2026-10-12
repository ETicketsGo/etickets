import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ADMIN_PRESETS } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Payout bank-account safeguards, through the WHOLE application on a real database.
 *
 * ── WHAT THESE PROVE ───────────────────────────────────────────────────────────────
 *  1. Every save is a new, masked version; nothing is overwritten without a record.
 *  2. Maker-checker: the person who saved, and any member of the organization, cannot verify
 *     or reject - refused with 403, audited, and nothing changed. The database itself refuses
 *     a row verified by its own maker.
 *  3. A verification names the version it checked; details changed since are refused (409).
 *  4. Owners are notified on save, verify and reject, with masked content only.
 *  5. Full account numbers appear nowhere but the encrypted column and the audited reveal
 *     response: not in history, audit metadata, notification payloads, or process output.
 *
 * Real HTTP with real signed tokens. Fixtures carry a unique suffix and are removed afterwards:
 * the database is shared.
 */

function loadEnvValue(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  for (const p of ['../../../.env', '../../../../.env']) {
    try {
      const m = readFileSync(resolve(__dirname, p), 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    } catch {
      /* try next */
    }
  }
  return undefined;
}

async function infrastructureReachable(databaseUrl: string, redisUrl: string): Promise<boolean> {
  const { PrismaClient } = require('@prisma/client');
  const IORedis = require('ioredis');
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const redis = new IORedis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await db.$queryRaw`SELECT 1`;
    await redis.connect();
    await redis.ping();
    return true;
  } catch {
    return false;
  } finally {
    await db.$disconnect().catch(() => undefined);
    redis.disconnect();
  }
}

// The reply is whatever the API sent; each test asserts the shape it cares about.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = { status: number; body: any };

type Actor =
  | 'ownerA'
  | 'ownerA2'
  | 'managerA'
  | 'checkinA'
  | 'ownerB'
  | 'finance1'
  | 'finance2'
  | 'support'
  | 'memberStaff'
  | 'ownerStaff';

const NUMBER_1 = '501001234567';
const NUMBER_2 = '998877665544';

describe('integration-real-postgres: payout bank account safeguards', () => {
  let app: INestApplication | undefined;
  let prisma: PrismaService;
  let base = '';
  const suffix = `pas${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  const ids = {} as Record<Actor, string>;
  const tokens = {} as Record<Actor, string>;
  let orgA = '';
  let orgB = '';
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    const url = loadEnvValue('DATABASE_URL');
    const redis = loadEnvValue('REDIS_URL');
    if (!url || !redis || !(await infrastructureReachable(url, redis))) {
      console.warn('[integration-real-postgres] SKIPPED - PostgreSQL/Redis not reachable');
      return;
    }
    Object.assign(process.env, {
      DATABASE_URL: url,
      REDIS_URL: redis,
      APP_ENV: 'LOCAL',
      PAYMENT_PROVIDER_NAME: 'mock',
      THROTTLE_LIMIT: '100000',
      PAYOUT_BANK_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    });
    if (!process.env.JWT_ACCESS_SECRET) {
      process.env.JWT_ACCESS_SECRET = loadEnvValue('JWT_ACCESS_SECRET');
    }

    const { AppModule } = require('../app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);

    const jwt = new JwtService({ secret: process.env.JWT_ACCESS_SECRET });
    const makeUser = async (key: Actor, roles: string[], grants: string[] = []) => {
      const user = await prisma.user.create({
        data: {
          email: `${key.toLowerCase()}-${suffix}@pas.test`,
          passwordHash: 'x',
          fullName: `${key} ${suffix}`,
          roles: roles as never,
        },
      });
      for (const permission of grants) {
        await prisma.adminGrant.create({ data: { userId: user.id, permission } });
      }
      ids[key] = user.id;
      tokens[key] = jwt.sign(
        { sub: user.id, email: user.email, name: user.fullName, roles },
        { expiresIn: '30m' },
      );
    };
    await makeUser('ownerA', ['CUSTOMER', 'ORGANIZER_OWNER']);
    await makeUser('ownerA2', ['CUSTOMER', 'ORGANIZER_OWNER']);
    await makeUser('managerA', ['CUSTOMER', 'ORGANIZER_MANAGER']);
    await makeUser('checkinA', ['CUSTOMER', 'CHECKIN_STAFF']);
    await makeUser('ownerB', ['CUSTOMER', 'ORGANIZER_OWNER']);
    const payoutManage = [...ADMIN_PRESETS.FINANCE.grants, 'BANK_VERIFY', 'PAYOUT_EXECUTE'];
    await makeUser('finance1', ['ADMIN'], payoutManage);
    await makeUser('finance2', ['ADMIN'], payoutManage);
    await makeUser('support', ['ADMIN'], [...ADMIN_PRESETS.SUPPORT.grants]);
    // Staff who is ALSO a manager in organization A: holds PAYOUT_MANAGE, but is inside the org.
    await makeUser('memberStaff', ['ADMIN', 'ORGANIZER_MANAGER'], payoutManage);
    // Staff who owns organization B and can therefore save a bank account there.
    await makeUser('ownerStaff', ['ADMIN', 'ORGANIZER_OWNER'], payoutManage);

    orgA = (
      await prisma.organization.create({
        data: { name: `Org A ${suffix}`, slug: `org-a-${suffix}`, legalName: 'Org A Legal' },
      })
    ).id;
    orgB = (
      await prisma.organization.create({
        data: { name: `Org B ${suffix}`, slug: `org-b-${suffix}` },
      })
    ).id;
    const members: [Actor, string, string][] = [
      ['ownerA', orgA, 'ORGANIZER_OWNER'],
      ['ownerA2', orgA, 'ORGANIZER_OWNER'],
      ['managerA', orgA, 'ORGANIZER_MANAGER'],
      ['checkinA', orgA, 'CHECKIN_STAFF'],
      ['memberStaff', orgA, 'ORGANIZER_MANAGER'],
      ['ownerB', orgB, 'ORGANIZER_OWNER'],
      ['ownerStaff', orgB, 'ORGANIZER_OWNER'],
    ];
    for (const [key, organizationId, role] of members) {
      await prisma.organizationMember.create({
        data: { organizationId, userId: ids[key], role: role as never, status: 'ACTIVE' },
      });
    }
  }, 180_000);

  afterAll(async () => {
    if (prisma) {
      const userIds = Object.values(ids);
      const orgIds = [orgA, orgB].filter(Boolean);
      await prisma.auditLog.deleteMany({
        where: { OR: [{ actorUserId: { in: userIds } }, { organizationId: { in: orgIds } }] },
      });
      await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await app?.close();
    process.env = originalEnv;
  }, 60_000);

  async function call(
    actor: Actor,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Reply> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${tokens[actor]}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    return { status: res.status, body: parsed as never };
  }

  const bank = (accountNumber: string, extra: Record<string, unknown> = {}) => ({
    organizationId: orgA,
    currency: 'INR',
    holderName: 'Org A Legal',
    bankName: 'HDFC Bank',
    bankCode: 'HDFC0001234',
    accountNumber,
    ...extra,
  });

  const accountRow = () =>
    prisma.organizerPayoutAccount.findUniqueOrThrow({
      where: { organizationId_currency: { organizationId: orgA, currency: 'INR' } },
    });

  const skip = () => {
    if (!app) {
      console.warn('[integration-real-postgres] skipped: infrastructure unavailable');
      return true;
    }
    return false;
  };

  // The tests share one account in organization A and run in order: each step is the state the
  // next one starts from, as it would be for a real organizer.

  it('the first save is version 1, pending, recorded in history and audited with the correlation id', async () => {
    if (skip()) return;
    const written: string[] = [];
    const out = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    const err = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    let res;
    try {
      res = await call('ownerA', 'POST', '/payouts/accounts', bank(NUMBER_1), {
        'x-correlation-id': `corr-save-${suffix}`,
      });
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'PENDING_VERIFICATION', version: 1 });
    expect(JSON.stringify(res.body)).not.toContain(NUMBER_1);
    // Nothing the process printed while saving contains the number.
    expect(written.join('')).not.toContain(NUMBER_1);

    const history = await prisma.organizerPayoutAccountVersion.findMany({
      where: { organizationId: orgA },
    });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      version: 1,
      status: 'PENDING_VERIFICATION',
      accountLast4: '4567',
      changedFields: ['initial'],
      savedByUserId: ids.ownerA,
    });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { organizationId: orgA, action: 'PAYOUT_ACCOUNT_SAVED' },
    });
    expect(audit.correlationId).toBe(`corr-save-${suffix}`);
    expect(audit.actorUserId).toBe(ids.ownerA);
    expect(audit.metadata).toMatchObject({ outcome: 'SUCCESS', version: 1 });
  });

  it('notifies EVERY owner on a change, with a masked summary and no number', async () => {
    if (skip()) return;
    const rows = await prisma.notification.findMany({
      where: { type: 'PAYOUT_ACCOUNT_UPDATED', userId: { in: [ids.ownerA, ids.ownerA2] } },
    });
    expect([...new Set(rows.map((r) => r.userId))].sort()).toEqual(
      [ids.ownerA, ids.ownerA2].sort(),
    );
    // The manager and check-in staff are not owners and are not told.
    expect(
      await prisma.notification.count({
        where: { type: 'PAYOUT_ACCOUNT_UPDATED', userId: { in: [ids.managerA, ids.checkinA] } },
      }),
    ).toBe(0);
    const text = JSON.stringify(rows.map((r) => r.payload));
    expect(text).toContain('4567');
    expect(text).not.toContain(NUMBER_1);
    expect(text).not.toContain('accountCipher');
  });

  it('only the organization can read the history, and it is masked', async () => {
    if (skip()) return;
    for (const actor of ['ownerA', 'managerA'] as const) {
      const res = await call(actor, 'GET', `/payouts/accounts/history?organizationId=${orgA}`);
      expect(res.status).toBe(200);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(NUMBER_1);
      expect(text).not.toMatch(/cipher/i);
      expect(res.body[0]).toMatchObject({ version: 1, accountLast4: '4567' });
    }
    // Check-in staff, another organization's owner, and a customer-only token are refused.
    expect(
      (await call('checkinA', 'GET', `/payouts/accounts/history?organizationId=${orgA}`)).status,
    ).toBe(403);
    expect(
      (await call('ownerB', 'GET', `/payouts/accounts/history?organizationId=${orgA}`)).status,
    ).toBe(403);
  });

  it('only the owner may change the account: a manager is refused and nothing is written', async () => {
    if (skip()) return;
    const res = await call('managerA', 'POST', '/payouts/accounts', bank(NUMBER_2));
    expect(res.status).toBe(403);
    expect((await accountRow()).version).toBe(1);
  });

  it('identical details saved again change nothing: no new version, no email', async () => {
    if (skip()) return;
    const before = await prisma.notification.count({
      where: { type: 'PAYOUT_ACCOUNT_UPDATED', userId: ids.ownerA },
    });
    const res = await call('ownerA', 'POST', '/payouts/accounts', bank(NUMBER_1));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ version: 1 });
    expect(
      await prisma.organizerPayoutAccountVersion.count({ where: { organizationId: orgA } }),
    ).toBe(1);
    expect(
      await prisma.notification.count({
        where: { type: 'PAYOUT_ACCOUNT_UPDATED', userId: ids.ownerA },
      }),
    ).toBe(before);
    const audit = await prisma.auditLog.findMany({
      where: { organizationId: orgA, action: 'PAYOUT_ACCOUNT_SAVED' },
      orderBy: { createdAt: 'asc' },
    });
    expect((audit[audit.length - 1].metadata as { outcome: string }).outcome).toBe('NO_CHANGE');
  });

  // ── maker-checker ──────────────────────────────────────────────────────────────────

  it('refuses verification without PAYOUT_MANAGE, and from an organizer', async () => {
    if (skip()) return;
    const row = await accountRow();
    for (const actor of ['support', 'ownerA', 'managerA'] as const) {
      const res = await call(actor, 'POST', `/admin/payouts/accounts/${row.id}/verified`, {
        version: row.version,
      });
      expect(res.status).toBe(403);
    }
    expect((await accountRow()).verifiedAt).toBeNull();
  });

  it('refuses staff who belong to the organization, audits the refusal, changes nothing', async () => {
    if (skip()) return;
    const row = await accountRow();
    const res = await call('memberStaff', 'POST', `/admin/payouts/accounts/${row.id}/verified`, {
      version: row.version,
    });
    expect(res.status).toBe(403);
    expect((await accountRow()).verifiedAt).toBeNull();
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { actorUserId: ids.memberStaff, action: 'PAYOUT_ACCOUNT_VERIFIED' },
    });
    expect(audit.metadata).toMatchObject({ outcome: 'REFUSED', reasonCode: 'ORGANIZATION_MEMBER' });
  });

  it('refuses the person who saved the details even once they have left the organization', async () => {
    if (skip()) return;
    // ownerStaff owns org B, saves its account, then (membership removed) tries to verify it.
    const save = await call('ownerStaff', 'POST', '/payouts/accounts', {
      ...bank(NUMBER_1),
      organizationId: orgB,
    });
    expect(save.status).toBe(201);
    const row = await prisma.organizerPayoutAccount.findFirstOrThrow({
      where: { organizationId: orgB },
    });
    await prisma.organizationMember.deleteMany({
      where: { organizationId: orgB, userId: ids.ownerStaff },
    });
    const res = await call('ownerStaff', 'POST', `/admin/payouts/accounts/${row.id}/verified`, {
      version: row.version,
    });
    expect(res.status).toBe(403);
    expect(
      (await prisma.organizerPayoutAccount.findUniqueOrThrow({ where: { id: row.id } })).verifiedAt,
    ).toBeNull();
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { actorUserId: ids.ownerStaff, action: 'PAYOUT_ACCOUNT_VERIFIED' },
    });
    expect(audit.metadata).toMatchObject({ outcome: 'REFUSED', reasonCode: 'SAME_PERSON' });
  });

  it('the database itself refuses a row verified by the person who saved it', async () => {
    if (skip()) return;
    const row = await accountRow();
    await expect(
      prisma.organizerPayoutAccount.update({
        where: { id: row.id },
        data: { verifiedAt: new Date(), verifiedByUserId: row.updatedByUserId },
      }),
    ).rejects.toThrow(/checker_not_maker|constraint/i);
    expect((await accountRow()).verifiedAt).toBeNull();
  });

  it('refuses a verification that does not name the version, or names a stale one', async () => {
    if (skip()) return;
    const row = await accountRow();
    expect(
      (await call('finance1', 'POST', `/admin/payouts/accounts/${row.id}/verified`)).status,
    ).toBe(400);
    const stale = await call('finance1', 'POST', `/admin/payouts/accounts/${row.id}/verified`, {
      version: row.version + 1,
    });
    expect(stale.status).toBe(409);
    expect((await accountRow()).verifiedAt).toBeNull();
  });

  it('independent PAYOUT_MANAGE staff verifies: version VERIFIED, audited, owners told', async () => {
    if (skip()) return;
    const row = await accountRow();
    const res = await call(
      'finance1',
      'POST',
      `/admin/payouts/accounts/${row.id}/verified`,
      { version: row.version },
      { 'x-correlation-id': `corr-verify-${suffix}` },
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'VERIFIED' });
    const after = await accountRow();
    expect(after.verifiedByUserId).toBe(ids.finance1);
    expect(after.updatedByUserId).toBe(ids.ownerA);
    const hv = await prisma.organizerPayoutAccountVersion.findUniqueOrThrow({
      where: { accountId_version: { accountId: row.id, version: 1 } },
    });
    expect(hv).toMatchObject({ status: 'VERIFIED', decidedByUserId: ids.finance1 });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { actorUserId: ids.finance1, action: 'PAYOUT_ACCOUNT_VERIFIED' },
    });
    expect(audit.correlationId).toBe(`corr-verify-${suffix}`);
    expect(audit.metadata).toMatchObject({ outcome: 'SUCCESS', version: 1 });
    const told = await prisma.notification.findMany({
      where: { type: 'PAYOUT_ACCOUNT_UPDATED', userId: { in: [ids.ownerA, ids.ownerA2] } },
    });
    expect(
      told.filter((n) => (n.payload as { change: string }).change === 'VERIFIED').length,
    ).toBeGreaterThanOrEqual(2);
    // Deciding twice is a conflict, not a second verification.
    expect(
      (await call('finance2', 'POST', `/admin/payouts/accounts/${row.id}/verified`, { version: 1 }))
        .status,
    ).toBe(409);
  });

  it('a change after verification is a new version: verification is cleared, history keeps both', async () => {
    if (skip()) return;
    const res = await call('ownerA', 'POST', '/payouts/accounts', bank(NUMBER_2));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      version: 2,
      status: 'PENDING_VERIFICATION',
      verifiedAt: null,
    });
    const after = await accountRow();
    expect(after).toMatchObject({ verifiedAt: null, verifiedByUserId: null, version: 2 });
    const hist = await call('ownerA', 'GET', `/payouts/accounts/history?organizationId=${orgA}`);
    expect(
      hist.body.map((h: { version: number; status: string }) => [h.version, h.status]),
    ).toEqual([
      [2, 'PENDING_VERIFICATION'],
      [1, 'VERIFIED'],
    ]);
    expect(hist.body[0]).toMatchObject({ changedFields: ['accountNumber'], accountLast4: '5544' });
    expect(JSON.stringify(hist.body)).not.toContain(NUMBER_2);
    // The owners were told about THIS change.
    const owners = await prisma.notification.findMany({
      where: { type: 'PAYOUT_ACCOUNT_UPDATED', userId: ids.ownerA },
    });
    const saved = owners.filter(
      (n) =>
        (n.payload as { change: string; version: number }).change === 'SAVED' &&
        (n.payload as { version: number }).version === 2,
    );
    // One per channel (email and the in-app inbox) for this version.
    expect(saved.map((n) => n.channel).sort()).toEqual(['email', 'in_app']);
    expect(JSON.stringify(saved.map((n) => n.payload))).not.toContain(NUMBER_2);
  });

  it('a verification of the OLD version cannot be applied to the new details', async () => {
    if (skip()) return;
    const row = await accountRow();
    const res = await call('finance1', 'POST', `/admin/payouts/accounts/${row.id}/verified`, {
      version: 1,
    });
    expect(res.status).toBe(409);
    expect((await accountRow()).verifiedAt).toBeNull();
  });

  it('reveal is audited with outcome and correlation id, and refuses a reason that carries a number', async () => {
    if (skip()) return;
    const row = await accountRow();
    const bad = await call('finance1', 'POST', `/admin/payouts/accounts/${row.id}/reveal`, {
      reason: `checking ${NUMBER_2}`,
    });
    expect(bad.status).toBe(400);
    expect(
      await prisma.auditLog.count({
        where: { actorUserId: ids.finance1, action: 'PAYOUT_ACCOUNT_REVEALED' },
      }),
    ).toBe(0);

    const written: string[] = [];
    const out = jest.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      written.push(String(c));
      return true;
    });
    let ok;
    try {
      ok = await call(
        'finance1',
        'POST',
        `/admin/payouts/accounts/${row.id}/reveal`,
        { reason: 'Verification call' },
        { 'x-correlation-id': `corr-reveal-${suffix}` },
      );
    } finally {
      out.mockRestore();
    }
    expect(ok.status).toBe(201);
    expect(ok.body.accountNumber).toBe(NUMBER_2);
    expect(written.join('')).not.toContain(NUMBER_2);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { actorUserId: ids.finance1, action: 'PAYOUT_ACCOUNT_REVEALED' },
    });
    expect(audit.correlationId).toBe(`corr-reveal-${suffix}`);
    expect(audit.metadata).toMatchObject({
      outcome: 'SUCCESS',
      version: 2,
      status: 'PENDING_VERIFICATION',
    });
    expect(JSON.stringify(audit.metadata)).not.toContain(NUMBER_2);
    // An organizer cannot reveal.
    expect(
      (await call('ownerA', 'POST', `/admin/payouts/accounts/${row.id}/reveal`, { reason: 'x' }))
        .status,
    ).toBe(403);
  });

  it('reject needs a clean reason and the right version; the owner is told why; the account stays unverified', async () => {
    if (skip()) return;
    const row = await accountRow();
    const url = `/admin/payouts/accounts/${row.id}/reject`;
    expect(
      (await call('finance1', 'POST', url, { reason: `bad ${NUMBER_2}`, version: 2 })).status,
    ).toBe(400);
    expect(
      (await call('finance1', 'POST', url, { reason: 'Name does not match', version: 1 })).status,
    ).toBe(409);
    expect(
      (await call('memberStaff', 'POST', url, { reason: 'Name does not match', version: 2 }))
        .status,
    ).toBe(403);
    const ok = await call('finance2', 'POST', url, {
      reason: 'Name does not match the legal name',
      version: 2,
    });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'Name does not match the legal name',
    });
    const after = await accountRow();
    expect(after.verifiedAt).toBeNull();
    expect(after.rejectedByUserId).toBe(ids.finance2);
    const hv = await prisma.organizerPayoutAccountVersion.findUniqueOrThrow({
      where: { accountId_version: { accountId: row.id, version: 2 } },
    });
    expect(hv).toMatchObject({
      status: 'REJECTED',
      decisionNote: 'Name does not match the legal name',
    });
    const told = await prisma.notification.findMany({
      where: { type: 'PAYOUT_ACCOUNT_UPDATED', userId: ids.ownerA2 },
    });
    expect(
      told.some(
        (n) =>
          (n.payload as { change: string; reason?: string }).change === 'REJECTED' &&
          (n.payload as { reason?: string }).reason === 'Name does not match the legal name',
      ),
    ).toBe(true);
    // A rejected account cannot then be verified; the owner must save again.
    expect(
      (await call('finance1', 'POST', `/admin/payouts/accounts/${row.id}/verified`, { version: 2 }))
        .status,
    ).toBe(409);
    const resave = await call(
      'ownerA',
      'POST',
      '/payouts/accounts',
      bank(NUMBER_2, { holderName: 'Org A Legal Pvt Ltd' }),
    );
    expect(resave.body).toMatchObject({
      version: 3,
      status: 'PENDING_VERIFICATION',
      rejectedAt: null,
    });
    const statuses = (await call('finance1', 'GET', `/admin/payouts/accounts/${row.id}/history`))
      .body as unknown as { version: number; status: string; changedFields: string[] }[];
    expect(statuses.map((s) => [s.version, s.status])).toEqual([
      [3, 'PENDING_VERIFICATION'],
      [2, 'REJECTED'],
      [1, 'VERIFIED'],
    ]);
    expect(statuses[0].changedFields).toEqual(['holderName']);
  });

  it('the admin list shows who saved each account and its status, masked', async () => {
    if (skip()) return;
    const res = await call('finance1', 'GET', '/admin/payouts/accounts');
    expect(res.status).toBe(200);
    const mine = (
      res.body as unknown as {
        organization: { id: string };
        savedBy: { id: string } | null;
        status: string;
      }[]
    ).find((r) => r.organization.id === orgA)!;
    expect(mine.savedBy?.id).toBe(ids.ownerA);
    expect(mine.status).toBe('PENDING_VERIFICATION');
    expect(JSON.stringify(res.body)).not.toContain(NUMBER_2);
  });

  it('no audit row for this organization contains a full account number', async () => {
    if (skip()) return;
    const rows = await prisma.auditLog.findMany({
      where: { organizationId: { in: [orgA, orgB] } },
    });
    expect(rows.length).toBeGreaterThan(5);
    const text = JSON.stringify(rows);
    expect(text).not.toContain(NUMBER_1);
    expect(text).not.toContain(NUMBER_2);
  });

  it('an unrelated organization cannot read or change this one (tenant isolation)', async () => {
    if (skip()) return;
    expect((await call('ownerB', 'GET', `/payouts/accounts?organizationId=${orgA}`)).status).toBe(
      403,
    );
    expect((await call('ownerB', 'POST', '/payouts/accounts', bank(NUMBER_1))).status).toBe(403);
  });
});
