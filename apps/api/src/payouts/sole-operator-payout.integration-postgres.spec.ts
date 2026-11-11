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
 * Founder-operated payouts: the one exception to "the verifier may not pay"
 * (docs/go-live/FOUNDER-OPERATED-CONTROLS.md), with SOLE_OPERATOR_MODE=on.
 *
 * Real HTTP, real signed tokens, the real guards, a real database. The 48-hour wait is
 * simulated by moving `verifiedAt` back in the database; every other step goes through the API.
 * MFA step-up is dormant on APP_ENV=LOCAL and is proven on QA instead.
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

type Actor = 'owner1' | 'owner2' | 'owner3' | 'founder' | 'both' | 'verifierA' | 'payerB';
type Org = 'o1' | 'o2' | 'o3';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = { status: number; body: any };

const NUMBER_1 = '501001234567';
const NUMBER_2 = '501009876543';
const CODE = 'HDFC0001234';
const HOURS_49 = 49 * 60 * 60 * 1000;

// Each test makes many real HTTP calls; under a full parallel run 5 s is not enough.
jest.setTimeout(60_000);

describe('integration-real-postgres: sole-operator payouts', () => {
  let app: INestApplication | undefined;
  let prisma: PrismaService;
  let base = '';
  const suffix = `solo${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  const ids = {} as Record<Actor, string>;
  const tokens = {} as Record<Actor, string>;
  const orgs = {} as Record<Org, string>;
  const owners: Record<Org, Actor> = { o1: 'owner1', o2: 'owner2', o3: 'owner3' };
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
      SOLE_OPERATOR_MODE: 'on',
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
          email: `${key}-${suffix}@solo.test`.toLowerCase(),
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
    await makeUser('owner1', ['CUSTOMER', 'ORGANIZER_OWNER']);
    await makeUser('owner2', ['CUSTOMER', 'ORGANIZER_OWNER']);
    await makeUser('owner3', ['CUSTOMER', 'ORGANIZER_OWNER']);
    await makeUser('founder', ['ADMIN', 'SUPER_ADMIN']);
    // An ADMIN given both duties: the exception is for the super admin only.
    await makeUser(
      'both',
      ['ADMIN'],
      [...ADMIN_PRESETS.FINANCE_VERIFIER.grants, ...ADMIN_PRESETS.FINANCE_PAYER.grants],
    );
    await makeUser('verifierA', ['ADMIN'], [...ADMIN_PRESETS.FINANCE_VERIFIER.grants]);
    await makeUser('payerB', ['ADMIN'], [...ADMIN_PRESETS.FINANCE_PAYER.grants]);
    for (const o of ['o1', 'o2', 'o3'] as Org[]) {
      orgs[o] = (
        await prisma.organization.create({
          data: { name: `Org ${o} ${suffix}`, slug: `org-${o}-${suffix}` },
        })
      ).id;
      await prisma.organizationMember.create({
        data: {
          organizationId: orgs[o],
          userId: ids[owners[o]],
          role: 'ORGANIZER_OWNER',
          status: 'ACTIVE',
        },
      });
    }
  }, 180_000);

  afterAll(async () => {
    if (prisma) {
      const userIds = Object.values(ids);
      const orgIds = Object.values(orgs);
      await prisma.auditLog.deleteMany({
        where: { OR: [{ actorUserId: { in: userIds } }, { organizationId: { in: orgIds } }] },
      });
      await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.payout.deleteMany({ where: { organizationId: { in: orgIds } } });
      await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
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
  const newPayout = (o: Org, netMinor = 10_000) =>
    prisma.payout.create({
      data: { organizationId: orgs[o], currency: 'INR', netMinor, grossMinor: netMinor },
    });
  const payoutRow = (id: string) => prisma.payout.findUniqueOrThrow({ where: { id } });
  const account = (o: Org) =>
    prisma.organizerPayoutAccount.findUniqueOrThrow({
      where: { organizationId_currency: { organizationId: orgs[o], currency: 'INR' } },
    });
  const save = (o: Org, accountNumber: string) =>
    call(owners[o], 'POST', '/payouts/accounts', {
      organizationId: orgs[o],
      currency: 'INR',
      holderName: 'Org Legal',
      bankName: 'HDFC Bank',
      bankCode: CODE,
      accountNumber,
    });
  const verify = async (actor: Actor, o: Org, evidence = true) => {
    const acc = await account(o);
    return call(actor, 'POST', `/admin/payouts/accounts/${acc.id}/verified`, {
      version: acc.version,
      ...(evidence
        ? {
            method: 'PENNY_DROP',
            evidenceReference: 'PD-UTR-REF-A',
            accountLast4: acc.accountLast4,
          }
        : {}),
    });
  };
  const confirm = async (o: Org, accountNumber: string, actor: Actor = owners[o]) => {
    const acc = await account(o);
    return call(actor, 'POST', `/payouts/accounts/${acc.id}/confirm`, {
      version: acc.version,
      accountNumber,
      bankCode: CODE,
    });
  };
  const dispute = async (o: Org) => {
    const acc = await account(o);
    return call(owners[o], 'POST', `/payouts/accounts/${acc.id}/dispute`, {
      version: acc.version,
      reason: 'This is not our account',
    });
  };
  /** The 48 hours, simulated: verification moved back in time. Nothing else changes. */
  const age = async (o: Org) => {
    const acc = await account(o);
    await prisma.organizerPayoutAccount.update({
      where: { id: acc.id },
      data: { verifiedAt: new Date(Date.now() - HOURS_49) },
    });
  };
  const soloPay = (
    id: string,
    over: Partial<{
      reference: string;
      amountConfirmedMinor: number;
      soleOperatorAttestation: boolean;
    }> = {},
    actor: Actor = 'founder',
  ) =>
    call(actor, 'POST', `/admin/payouts/${id}/pay`, {
      reference: 'UTR-SOLO-1',
      amountConfirmedMinor: 10_000,
      soleOperatorAttestation: true,
      ...over,
    });

  it('o1: refused until the organizer confirms and 48 hours pass; then paid, marked, audited', async () => {
    if (skip()) return;
    expect((await save('o1', NUMBER_1)).status).toBe(201);
    expect((await verify('founder', 'o1')).status).toBe(201);
    const acc = await account('o1');
    expect(acc.verifiedByUserId).toBe(ids.founder);
    expect(acc.verificationMethod).toBe('PENNY_DROP');
    const p = await newPayout('o1');

    // No organizer confirmation, and the 48 hours have not passed.
    let res = await soloPay(p.id);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SEPARATION_OF_DUTIES');
    expect(res.body.details.rule).toBe('VERIFIER_CANNOT_PAY');
    expect(res.body.details.soleOperator.available).toBe(true);
    expect(res.body.details.soleOperator.unmet).toEqual(
      expect.arrayContaining(['NOT_CONFIRMED_BY_ORGANIZER', 'WAITING_PERIOD']),
    );

    // The list says so before anyone clicks: held for the founder, with the reasons.
    let row = (await call('founder', 'GET', '/admin/payouts')).body.find(
      (x: { id: string }) => x.id === p.id,
    );
    expect(row.hold.code).toBe('VERIFIER_CANNOT_PAY');
    expect(row.hold.unmet).toEqual(['NOT_CONFIRMED_BY_ORGANIZER', 'WAITING_PERIOD']);
    // Anyone who did not verify it sees it payable.
    row = (await call('payerB', 'GET', '/admin/payouts')).body.find(
      (x: { id: string }) => x.id === p.id,
    );
    expect(row.hold).toBeNull();

    // The organizer cannot confirm with the wrong number; staff cannot confirm at all.
    expect((await confirm('o1', NUMBER_2)).status).toBe(400);
    expect((await confirm('o1', NUMBER_1, 'founder')).status).toBe(403);
    expect((await confirm('o1', NUMBER_1, 'owner2')).status).toBe(403);
    expect((await confirm('o1', NUMBER_1)).status).toBe(201);
    expect((await account('o1')).ownerConfirmedVersion).toBe(acc.version);

    // Confirmed, but inside the 48 hours.
    res = await soloPay(p.id);
    expect(res.status).toBe(403);
    expect(res.body.details.soleOperator.unmet).toEqual(['WAITING_PERIOD']);

    await age('o1');
    // Missing bank reference, missing attestation, wrong amount: each refused, nothing paid.
    res = await soloPay(p.id, { reference: '' });
    expect(res.status).toBe(403);
    expect(res.body.details.soleOperator.unmet).toEqual(['BANK_REFERENCE_REQUIRED']);
    res = await soloPay(p.id, { soleOperatorAttestation: false });
    expect(res.body.details.soleOperator.unmet).toEqual(['ATTESTATION_REQUIRED']);
    res = await call('founder', 'POST', `/admin/payouts/${p.id}/pay`, {
      reference: 'UTR-SOLO-1',
      soleOperatorAttestation: true,
    });
    expect(res.body.details.soleOperator.unmet).toEqual(['AMOUNT_NOT_CONFIRMED']);
    res = await soloPay(p.id, { amountConfirmedMinor: 9_999 });
    expect(res.status).toBe(400);
    expect(res.body.details.reason).toBe('AMOUNT_MISMATCH');
    expect((await payoutRow(p.id)).status).toBe('PENDING');

    // Everything known before the dialog is met: the founder's row offers Mark paid.
    row = (await call('founder', 'GET', '/admin/payouts')).body.find(
      (x: { id: string }) => x.id === p.id,
    );
    expect(row.hold).toBeNull();

    // Everything met.
    res = await soloPay(p.id);
    expect(res.status).toBe(201);
    const paid = await payoutRow(p.id);
    expect(paid.status).toBe('PAID');
    expect(paid.soleOperator).toBe(true);
    expect(paid.paidReference).toBe('UTR-SOLO-1');
    const audit = await prisma.auditLog.findFirst({
      where: { entityId: p.id, action: 'PAYOUT_PAID_SOLE_OPERATOR' },
    });
    expect(audit?.actorUserId).toBe(ids.founder);
    expect(audit?.metadata).toMatchObject({
      rule: 'VERIFIER_CANNOT_PAY',
      verificationMethod: 'PENNY_DROP',
      accountVersion: acc.version,
    });

    // Paying it again is refused: the duplicate-payment claim is untouched.
    res = await soloPay(p.id);
    expect(res.status).toBe(409);

    // The admin list carries the indicator.
    const list = await call('founder', 'GET', '/admin/payouts');
    expect(list.body.find((x: { id: string }) => x.id === p.id).soleOperator).toBe(true);
  });

  it('o1: a change of bank details clears confirmation and restarts verification and the wait', async () => {
    if (skip()) return;
    expect((await save('o1', NUMBER_2)).status).toBe(201);
    let acc = await account('o1');
    expect(acc.ownerConfirmedAt).toBeNull();
    expect(acc.verifiedAt).toBeNull();
    expect(acc.verificationMethod).toBeNull();
    const p = await newPayout('o1');
    // Not verified: held for everyone.
    let res = await soloPay(p.id);
    expect(res.status).toBe(409);
    expect(res.body.details.hold).toBe('DESTINATION_PENDING_VERIFICATION');

    expect((await verify('founder', 'o1')).status).toBe(201);
    await age('o1');
    res = await soloPay(p.id);
    expect(res.status).toBe(403);
    expect(res.body.details.soleOperator.unmet).toEqual(['NOT_CONFIRMED_BY_ORGANIZER']);
    // The old number no longer confirms anything.
    expect((await confirm('o1', NUMBER_1)).status).toBe(400);
    expect((await confirm('o1', NUMBER_2)).status).toBe(201);
    // A fresh verification restarts the 48 hours: simulate it by setting verifiedAt to now.
    acc = await account('o1');
    await prisma.organizerPayoutAccount.update({
      where: { id: acc.id },
      data: { verifiedAt: new Date() },
    });
    res = await soloPay(p.id);
    expect(res.body.details.soleOperator.unmet).toEqual(['WAITING_PERIOD']);
    expect((await payoutRow(p.id)).status).toBe('PENDING');
  });

  it('o1: an organizer dispute blocks payment at once, for every payer, and clears only by a new save', async () => {
    if (skip()) return;
    await age('o1');
    const p = await newPayout('o1');
    expect((await dispute('o1')).status).toBe(201);
    const acc = await account('o1');
    expect(acc.disputedAt).not.toBeNull();
    expect(acc.ownerConfirmedAt).toBeNull();

    let res = await soloPay(p.id);
    expect(res.status).toBe(409);
    expect(res.body.details.hold).toBe('DESTINATION_DISPUTED');
    // The two-person path is held too: a dispute is not a sole-operator rule.
    res = await call('payerB', 'POST', `/admin/payouts/${p.id}/pay`, {
      reference: 'UTR-B',
      amountConfirmedMinor: 10_000,
    });
    expect(res.status).toBe(409);
    expect(res.body.details.hold).toBe('DESTINATION_DISPUTED');
    // A disputed account cannot be confirmed.
    expect((await confirm('o1', NUMBER_2)).status).toBe(409);
    const list = await call('founder', 'GET', '/admin/payouts');
    expect(list.body.find((x: { id: string }) => x.id === p.id).hold.code).toBe(
      'DESTINATION_DISPUTED',
    );
    expect((await payoutRow(p.id)).status).toBe('PENDING');

    // Saving the same details again starts a new version and ends the dispute.
    expect((await save('o1', NUMBER_2)).status).toBe(201);
    const after = await account('o1');
    expect(after.version).toBe(acc.version + 1);
    expect(after.disputedAt).toBeNull();
    expect(after.verifiedAt).toBeNull();
  });

  it('o2: the founder belonging to the organization blocks the exception', async () => {
    if (skip()) return;
    expect((await save('o2', NUMBER_1)).status).toBe(201);
    expect((await verify('founder', 'o2')).status).toBe(201);
    expect((await confirm('o2', NUMBER_1)).status).toBe(201);
    await age('o2');
    // The founder joins the organization after verifying (any status counts).
    await prisma.organizationMember.create({
      data: { organizationId: orgs.o2, userId: ids.founder, role: 'ORGANIZER_MANAGER' },
    });
    const p = await newPayout('o2');
    const res = await soloPay(p.id);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SEPARATION_OF_DUTIES');
    expect(res.body.details.soleOperator).toEqual({
      available: false,
      unmet: ['ORGANIZATION_MEMBER'],
    });
    expect((await payoutRow(p.id)).status).toBe('PENDING');
    await prisma.organizationMember.deleteMany({
      where: { organizationId: orgs.o2, userId: ids.founder },
    });
  });

  it('o3: an admin who is not the super admin never gets the exception; the two-person path still pays', async () => {
    if (skip()) return;
    expect((await save('o3', NUMBER_1)).status).toBe(201);
    expect((await verify('both', 'o3')).status).toBe(201);
    expect((await confirm('o3', NUMBER_1)).status).toBe(201);
    await age('o3');
    const p = await newPayout('o3');
    let res = await soloPay(p.id, {}, 'both');
    expect(res.status).toBe(403);
    expect(res.body.details.soleOperator).toEqual({
      available: false,
      unmet: ['NOT_SUPER_ADMIN'],
    });
    // Someone else pays, as before: no sole-operator mark.
    res = await call('payerB', 'POST', `/admin/payouts/${p.id}/pay`, {
      reference: 'UTR-TWO-PERSON',
      amountConfirmedMinor: 10_000,
    });
    expect(res.status).toBe(201);
    const paid = await payoutRow(p.id);
    expect(paid.status).toBe('PAID');
    expect(paid.soleOperator).toBe(false);
  });

  it('maker-checker refusals carry SEPARATION_OF_DUTIES, missing duties stay FORBIDDEN', async () => {
    if (skip()) return;
    // R2: the founder as a member of o2 may not verify its account.
    expect((await save('o2', NUMBER_2)).status).toBe(201);
    await prisma.organizationMember.create({
      data: { organizationId: orgs.o2, userId: ids.founder, role: 'ORGANIZER_MANAGER' },
    });
    const res = await verify('founder', 'o2');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SEPARATION_OF_DUTIES');
    expect(res.body.details).toMatchObject({
      rule: 'BANK_VERIFIER_INDEPENDENT',
      reason: 'ORGANIZATION_MEMBER',
    });
    await prisma.organizationMember.deleteMany({
      where: { organizationId: orgs.o2, userId: ids.founder },
    });
    // Missing duty: the verifier cannot pay at all.
    const p = await newPayout('o3');
    const missing = await call('verifierA', 'POST', `/admin/payouts/${p.id}/pay`, {
      reference: 'X',
    });
    expect(missing.status).toBe(403);
    expect(missing.body.code).toBe('FORBIDDEN');
  });
});
