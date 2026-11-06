import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { FeeRule } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { scheduleFingerprint } from '../pricing/fee-schedule-fingerprint';

/**
 * Maker-checker on booking-fee schedules, end to end.
 *
 * Real HTTP, real signed tokens, the real guards, a real database with the real triggers.
 * Before this change one PLATFORM_CONFIG holder (or any super admin) drafted and published a
 * schedule alone; the "maker cannot approve" and "publish is refused" tests fail on that code.
 *
 * Uses AED, which no other suite prices with, and puts the AED bands back exactly as they were.
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

type Actor = 'maker' | 'maker2' | 'checker' | 'superA' | 'superB' | 'reader' | 'editorOnly';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = { status: number; body: any };

const CURRENCY = 'AED';

describe('integration-real-postgres: fee schedule maker-checker', () => {
  let app: INestApplication | undefined;
  let prisma: PrismaService;
  let base = '';
  const suffix = `fsa${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  const ids = {} as Record<Actor, string>;
  const tokens = {} as Record<Actor, string>;
  const originalEnv = { ...process.env };
  let originalRules: FeeRule[] = [];
  const draftIds = new Set<string>();

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

    // Leave nothing open for AED from an earlier run, and start from one known band.
    originalRules = await prisma.feeRule.findMany({ where: { currency: CURRENCY } });
    await prisma.feeRule.updateMany({
      where: { currency: CURRENCY, deletedAt: null },
      data: { active: false, deletedAt: new Date() },
    });
    await prisma.feeScheduleDraft.updateMany({
      where: { currency: CURRENCY, status: 'OPEN' },
      data: { status: 'DISCARDED' },
    });
    await prisma.feeRule.create({
      data: {
        label: 'test band',
        currency: CURRENCY,
        minMinor: 0,
        maxMinor: null,
        feeMinor: 500,
        feeType: 'FLAT',
        country: 'United Arab Emirates',
        region: '*',
        active: true,
      },
    });

    const jwt = new JwtService({ secret: process.env.JWT_ACCESS_SECRET });
    const makeUser = async (key: Actor, roles: string[], grants: string[] = []) => {
      const user = await prisma.user.create({
        data: {
          email: `${key}-${suffix}@fsa.test`.toLowerCase(),
          passwordHash: 'x',
          fullName: `${key} ${suffix}`,
          roles: roles as never,
        },
      });
      for (const permission of new Set(grants)) {
        await prisma.adminGrant.create({ data: { userId: user.id, permission } });
      }
      ids[key] = user.id;
      tokens[key] = jwt.sign(
        { sub: user.id, email: user.email, name: user.fullName, roles },
        { expiresIn: '30m' },
      );
    };
    await makeUser('maker', ['ADMIN'], ['PLATFORM_CONFIG', 'PLATFORM_CONFIG_READ']);
    await makeUser('maker2', ['ADMIN'], ['PLATFORM_CONFIG', 'PLATFORM_CONFIG_READ']);
    await makeUser('checker', ['ADMIN'], ['FEE_SCHEDULE_APPROVE', 'PLATFORM_CONFIG_READ']);
    await makeUser('superA', ['ADMIN', 'SUPER_ADMIN']);
    await makeUser('superB', ['ADMIN', 'SUPER_ADMIN']);
    await makeUser('reader', ['ADMIN'], ['PLATFORM_CONFIG_READ']);
    await makeUser('editorOnly', ['ADMIN'], ['PLATFORM_CONFIG', 'PLATFORM_CONFIG_READ']);
  }, 180_000);

  afterAll(async () => {
    if (prisma) {
      const userIds = Object.values(ids);
      // Published drafts and decisions are protected by triggers; a test database owner may
      // switch triggers off for its own cleanup. If it may not, the rows stay (AED only).
      const mine = [...draftIds];
      if (mine.length) {
        try {
          await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
            await tx.feeScheduleDecision.deleteMany({ where: { draftId: { in: mine } } });
            await tx.feeScheduleDraft.deleteMany({ where: { id: { in: mine } } });
          });
        } catch (err) {
          console.warn(`[fee-schedule-approval] could not remove test drafts: ${err}`);
        }
      }
      // Put the AED bands back exactly as they were.
      await prisma.feeRule.deleteMany({
        where: { currency: CURRENCY, id: { notIn: originalRules.map((r) => r.id) } },
      });
      for (const r of originalRules) {
        const { id, ...data } = r;
        await prisma.feeRule.update({ where: { id }, data });
      }
      await prisma.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
      await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.adminGrant.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await app?.close();
    process.env = originalEnv;
  }, 60_000);

  async function call(actor: Actor, method: string, path: string, body?: unknown): Promise<Reply> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${tokens[actor]}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
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
    return { status: res.status, body: parsed };
  }
  const skip = () => {
    if (!app) {
      console.warn('[integration-real-postgres] skipped: infrastructure unavailable');
      return true;
    }
    return false;
  };

  // What checkout fingerprints (PricingService.loadTiers): every ACTIVE band of the currency.
  const checkoutFingerprint = async () =>
    scheduleFingerprint(
      await prisma.feeRule.findMany({
        where: { active: true, currency: CURRENCY },
        orderBy: { minMinor: 'asc' },
      }),
    );
  const liveFee = async () =>
    (await prisma.feeRule.findMany({ where: { currency: CURRENCY, deletedAt: null } })).map(
      (r) => r.feeMinor,
    );

  /** A draft (by `who`) that changes the one band's fee to `fee`, saved, not submitted. */
  async function draftWithFee(who: Actor, fee: number) {
    const opened = await call(who, 'POST', '/admin/fee-schedules/drafts', { currency: CURRENCY });
    expect(opened.status).toBe(201);
    draftIds.add(opened.body.id);
    const bands = opened.body.bands.map((b: Record<string, unknown>) => ({ ...b, feeMinor: fee }));
    const saved = await call(who, 'PUT', `/admin/fee-schedules/drafts/${opened.body.id}`, {
      bands,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.validation.valid).toBe(true);
    return opened.body.id as string;
  }

  it('the old one-person publish is refused and changes nothing', async () => {
    if (skip()) return;
    const id = await draftWithFee('superA', 650);
    const res = await call('superA', 'POST', `/admin/fee-schedules/drafts/${id}/publish`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('FEE_SCHEDULE_APPROVAL_REQUIRED');
    expect(await liveFee()).toEqual([500]);
    // Clean up: discard so the next test starts a fresh draft.
    expect((await call('superA', 'DELETE', `/admin/fee-schedules/drafts/${id}`)).status).toBe(200);
  });

  it('a super admin who submitted a draft cannot approve it; another super admin can', async () => {
    if (skip()) return;
    const id = await draftWithFee('superA', 700);
    expect(
      (await call('superA', 'POST', `/admin/fee-schedules/drafts/${id}/submit`, {})).status,
    ).toBe(201);
    const self = await call('superA', 'POST', `/admin/fee-schedules/drafts/${id}/approve`, {});
    expect(self.status).toBe(403);
    expect(self.body.details.reason).toBe('NOT_INDEPENDENT');
    expect(await liveFee()).toEqual([500]);
    const refused = await prisma.auditLog.findFirst({
      where: { actorUserId: ids.superA, action: 'FEE_SCHEDULE_APPROVAL_REFUSED', entityId: id },
    });
    expect(refused).not.toBeNull();

    const ok = await call('superB', 'POST', `/admin/fee-schedules/drafts/${id}/approve`, {
      note: 'matches the signed-off pricing',
    });
    expect(ok.status).toBe(201);
    expect(await liveFee()).toEqual([700]);
    const row = await prisma.feeScheduleDraft.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      status: 'PUBLISHED',
      submittedByUserId: ids.superA,
      approvedByUserId: ids.superB,
      publishedByUserId: ids.superB,
    });
  });

  it('checkout prices with the live schedule only: a pending draft charges nothing new', async () => {
    if (skip()) return;
    const before = await liveFee();
    const id = await draftWithFee('maker', 9_900);
    await call('maker', 'POST', `/admin/fee-schedules/drafts/${id}/submit`, {});
    expect(await liveFee()).toEqual(before);
    const fp = await checkoutFingerprint();
    // Reject it: still nothing changed, and the fingerprint a quote carries did not move.
    const rej = await call('checker', 'POST', `/admin/fee-schedules/drafts/${id}/reject`, {
      note: 'far too high',
    });
    expect(rej.status).toBe(201);
    expect(rej.body.status).toBe('OPEN');
    expect(await checkoutFingerprint()).toBe(fp);
    expect((await call('maker', 'DELETE', `/admin/fee-schedules/drafts/${id}`)).status).toBe(200);
  });

  it('capabilities: a reader cannot submit, an editor without the duty cannot approve', async () => {
    if (skip()) return;
    const id = await draftWithFee('maker', 800);
    expect(
      (await call('reader', 'POST', `/admin/fee-schedules/drafts/${id}/submit`, {})).status,
    ).toBe(403);
    await call('maker', 'POST', `/admin/fee-schedules/drafts/${id}/submit`, {});
    expect(
      (await call('editorOnly', 'POST', `/admin/fee-schedules/drafts/${id}/approve`, {})).status,
    ).toBe(403);
    // A second editor who never touched it still lacks the approval duty.
    expect(
      (await call('maker2', 'POST', `/admin/fee-schedules/drafts/${id}/approve`, {})).status,
    ).toBe(403);
    const ok = await call('checker', 'POST', `/admin/fee-schedules/drafts/${id}/approve`, {});
    expect(ok.status).toBe(201);
    expect(await liveFee()).toEqual([800]);
  });

  it('the database refuses to rewrite a decision or a published version', async () => {
    if (skip()) return;
    const decision = await prisma.feeScheduleDecision.findFirstOrThrow({
      where: { draftId: { in: [...draftIds] }, action: 'APPROVED' },
    });
    await expect(
      prisma.feeScheduleDecision.update({ where: { id: decision.id }, data: { note: 'edited' } }),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.feeScheduleDecision.delete({ where: { id: decision.id } })).rejects.toThrow(
      /append-only/,
    );
    await expect(
      prisma.feeScheduleDraft.update({
        where: { id: decision.draftId },
        data: { approvalNote: 'rewritten' },
      }),
    ).rejects.toThrow(/published version/);
  });

  it('a pending draft cannot have its bands changed, even by direct SQL', async () => {
    if (skip()) return;
    const id = await draftWithFee('maker', 850);
    await call('maker', 'POST', `/admin/fee-schedules/drafts/${id}/submit`, {});
    await expect(
      prisma.feeScheduleDraft.update({ where: { id }, data: { bands: [] } }),
    ).rejects.toThrow(/waiting for approval/);
    expect((await call('maker', 'POST', `/admin/fee-schedules/drafts/${id}/withdraw`)).status).toBe(
      201,
    );
    expect((await call('maker', 'DELETE', `/admin/fee-schedules/drafts/${id}`)).status).toBe(200);
  });

  it('emergency rollback restores an earlier version alone, and notifies the other approvers', async () => {
    if (skip()) return;
    const overview = await call('reader', 'GET', `/admin/fee-schedules/${CURRENCY}`);
    const liveVersion = overview.body.liveVersion as number;
    expect(liveVersion).toBeGreaterThanOrEqual(2);
    const target = liveVersion - 1;
    const short = await call(
      'superB',
      'POST',
      `/admin/fee-schedules/${CURRENCY}/emergency-rollback`,
      {
        version: target,
        reason: 'too short',
      },
    );
    expect(short.status).toBe(400);
    // The duty alone is not enough: it also needs PLATFORM_CONFIG.
    const noConfig = await call(
      'checker',
      'POST',
      `/admin/fee-schedules/${CURRENCY}/emergency-rollback`,
      { version: target, reason: 'live fee is wrong and buyers are being overcharged now' },
    );
    expect(noConfig.status).toBe(403);
    const res = await call(
      'superB',
      'POST',
      `/admin/fee-schedules/${CURRENCY}/emergency-rollback`,
      { version: target, reason: 'live fee is wrong and buyers are being overcharged now' },
    );
    expect(res.status).toBe(201);
    draftIds.add(res.body.id);
    expect(res.body).toMatchObject({ version: liveVersion + 1, restoredVersion: target });
    expect(await liveFee()).toEqual([700]);
    const notified = await prisma.notification.findMany({
      where: { type: 'FEE_SCHEDULE_AWAITING_APPROVAL', userId: { in: Object.values(ids) } },
      select: { userId: true, payload: true },
    });
    const rollbackNotices = notified.filter(
      (n) => (n.payload as { kind?: string }).kind === 'EMERGENCY_ROLLBACK',
    );
    const told = new Set(rollbackNotices.map((n) => n.userId));
    expect(told.has(ids.superB)).toBe(false);
    expect(told.has(ids.checker)).toBe(true);
  });

  it('submission notifies approvers but never the maker, and the decision reaches the maker', async () => {
    if (skip()) return;
    const id = await draftWithFee('maker', 720);
    await call('maker', 'POST', `/admin/fee-schedules/drafts/${id}/submit`, {});
    const asks = await prisma.notification.findMany({
      where: { type: 'FEE_SCHEDULE_AWAITING_APPROVAL', userId: { in: Object.values(ids) } },
    });
    const forThis = asks.filter((n) => (n.payload as { draftId?: string }).draftId === id);
    const recipients = new Set(forThis.map((n) => n.userId));
    expect(recipients.has(ids.maker)).toBe(false);
    expect(recipients.has(ids.checker)).toBe(true);
    await call('checker', 'POST', `/admin/fee-schedules/drafts/${id}/approve`, {});
    const decided = await prisma.notification.findMany({
      where: { type: 'FEE_SCHEDULE_DECIDED', userId: ids.maker },
    });
    expect(decided.some((n) => (n.payload as { draftId?: string }).draftId === id)).toBe(true);
  });
});
