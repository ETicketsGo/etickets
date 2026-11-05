import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { QrService } from '../../tickets/qr.service';
import { AllExceptionsFilter } from '../../common/all-exceptions.filter';
import { OrganizationLifecycleService } from '../../organizations/organization-lifecycle.service';

/**
 * integration-real-postgres, whole app over HTTP, offline check-in ON: a suspended organization
 * loses check-in authorization (owner decision, 2026-10-26).
 *
 *  1. a door phone is registered, approved, holds a signed ticket list (the offline lease) and
 *     an offline activation decision covers it;
 *  2. the admin suspends the organization: every check-in device of it reads REVOKED (with when
 *     and why), the activation is revoked, and both are on the audit log;
 *  3. while suspended, every door path is refused 403 ORGANIZATION_SUSPENDED: online scan,
 *     visual admission, ticket list, delta, device registration and approval;
 *  4. while suspended, a queued offline scan uploaded is NOT applied - the answer names each
 *     rejected scan and why, and the scan is held for review as evidence;
 *  5. reinstatement does not revive the old phone: it stays REVOKED, cannot fetch a list, its
 *     queue (scans made during the suspension on a list from before it) is refused and not
 *     applied, and approving it again is refused;
 *  6. a phone registered and approved after reinstatement works;
 *  7. the lease is bounded: a scan claimed after its list expired is never applied, and no list
 *     lives longer than 45 minutes even when 60 is configured (owner decision 2026-10-26);
 *  8. a phone already revoked (reported lost) keeps LOST as its reason; the suspension is
 *     appended to its reason history, never dropped and never overwriting it.
 *
 * Every row is created here and deleted after. Skips (never fabricates a pass) without a DB.
 */
function loadDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const p of ['../../../../../.env', '../../../../../../.env']) {
    try {
      const txt = readFileSync(resolve(__dirname, p), 'utf8');
      const m = txt.match(/^DATABASE_URL=(.*)$/m);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    } catch {
      /* try next */
    }
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PrismaClient } = require('@prisma/client');
type Client = InstanceType<typeof PrismaClient>;

const PASSWORD = 'Vermilion-Lantern-4821!';

describe('integration-real-postgres: suspending an organization revokes check-in (HTTP)', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let app: INestApplication | undefined;
  let base = '';
  let qr: QrService;
  let lifecycle: OrganizationLifecycleService;
  let available = false;
  const previousFlag = process.env.OFFLINE_CHECKIN_ENABLED;
  let previousWindow: string | undefined;

  const suffix = `suspdev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  let orgId = '';
  let eventId = '';
  let sessionId = '';
  let adminId = '';
  const tickets: { id: string; nonce: string }[] = [];
  let ownerToken = '';
  let doorToken = '';
  /** The phone at the door before the suspension, and one left PENDING. */
  const door = { deviceId: '', pendingId: '', activationId: '', lostId: '' };
  let suspendedAt = 0;

  async function http(method: string, path: string, token?: string, body?: unknown) {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json, data: json?.data ?? json };
  }
  const codeOf = (r: { json: any }) => r.json?.error?.code ?? r.json?.code;
  const detailsOf = (r: { json: any }) => r.json?.error?.details ?? r.json?.details ?? {};

  const login = async (email: string) => {
    const r = await http('POST', '/auth/login', undefined, { email, password: PASSWORD });
    expect(r.status).toBeLessThan(300);
    return r.data.accessToken as string;
  };

  const register = (token: string, name: string) =>
    http('POST', '/checkin/devices', token, {
      organizationId: orgId,
      eventId,
      eventSessionId: sessionId,
      name,
    });

  const proof = new Map<
    string,
    { manifestVersion: number; manifestSignature: string; expiresAt: number }
  >();
  const sync = async (token: string, deviceId: string) => {
    const r = await http(
      'GET',
      `/checkin/manifest?eventSessionId=${sessionId}&deviceId=${deviceId}`,
      token,
    );
    if (r.status === 200) {
      proof.set(deviceId, {
        manifestVersion: r.data.meta.version,
        manifestSignature: r.data.signature,
        expiresAt: r.data.meta.expiresAt,
      });
    }
    return r;
  };
  const scanToken = (i: number) =>
    qr.sign({
      ticketId: tickets[i].id,
      eventSessionId: sessionId,
      nonce: tickets[i].nonce,
      version: 1,
    });
  /** What the phone sends when it comes back online with a scan it made offline at `at`. */
  const upload = (token: string, deviceId: string, i: number, at: number) => {
    const p = proof.get(deviceId);
    return http('POST', '/checkin/reconcile', token, {
      deviceId,
      checkIns: [
        {
          ticketId: tickets[i].id,
          deviceId,
          nonce: tickets[i].nonce,
          version: 1,
          eventSessionId: sessionId,
          checkedInAt: at,
          wasOverride: false,
          ...(p
            ? { manifestVersion: p.manifestVersion, manifestSignature: p.manifestSignature }
            : {}),
        },
      ],
    });
  };
  const scanOnline = (i: number) => http('POST', '/checkins', doorToken, { token: scanToken(i) });
  const deviceRow = (id: string) => db!.checkInDevice.findUnique({ where: { id } });
  const ticketStatus = async (i: number) =>
    (await db!.ticket.findUnique({ where: { id: tickets[i].id } })).status;
  const adminUser = () =>
    ({ id: adminId, email: `admin-${suffix}@test.invalid`, roles: ['ADMIN'] }) as never;

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED -- no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db!.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED -- DB unavailable');
      return;
    }
    process.env.DATABASE_URL = url;
    process.env.APP_ENV = process.env.APP_ENV ?? 'LOCAL';
    process.env.THROTTLE_LIMIT = '5000';
    process.env.AUTH_THROTTLE_LIMIT = '5000';
    process.env.OFFLINE_CHECKIN_ENABLED = 'true';
    // Configured LONGER than the owner's 45-minute maximum: issued lists must still be clamped.
    previousWindow = process.env.OFFLINE_REVOCATION_WINDOW_MINUTES;
    process.env.OFFLINE_REVOCATION_WINDOW_MINUTES = '60';
    // Loaded only now: ConfigModule.forRoot reads process.env when app.module is first imported.
    const { AppModule } = await import('../../app.module');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    qr = app.get(QrService);
    lifecycle = app.get(OrganizationLifecycleService);

    const hash = await bcrypt.hash(PASSWORD, 10);
    const mk = (who: string, roles: string[] = ['CUSTOMER']) =>
      db!.user.create({
        data: { email: `${who}-${suffix}@test.invalid`, fullName: who, passwordHash: hash, roles },
      });
    const owner = await mk('owner');
    const staff = await mk('door');
    adminId = (await mk('admin', ['ADMIN'])).id;
    const org = await db!.organization.create({
      data: { name: `Susp Door Org ${suffix}`, slug: `susp-door-${suffix}`, status: 'APPROVED' },
    });
    orgId = org.id;
    await db!.organizationMember.createMany({
      data: [
        { organizationId: orgId, userId: owner.id, role: 'ORGANIZER_OWNER', status: 'ACTIVE' },
        { organizationId: orgId, userId: staff.id, role: 'CHECKIN_STAFF', status: 'ACTIVE' },
      ],
    });
    const venue = await db!.venue.create({
      data: { organizationId: orgId, name: `Susp Venue ${suffix}`, city: 'Hyderabad' },
    });
    const event = await db!.event.create({
      data: {
        organizationId: orgId,
        venueId: venue.id,
        title: `Susp Show ${suffix}`,
        slug: `susp-show-${suffix}`,
        category: 'MUSIC',
      },
    });
    eventId = event.id;
    const session = await db!.eventSession.create({
      data: {
        eventId,
        startsAt: new Date(Date.now() - 10 * 60_000),
        endsAt: new Date(Date.now() + 2 * 3_600_000),
      },
    });
    sessionId = session.id;
    const tt = await db!.ticketType.create({
      data: { eventSessionId: sessionId, name: 'GA', priceMinor: 0, quantityTotal: 50 },
    });
    const booking = await db!.booking.create({
      data: {
        organizationId: orgId,
        eventId,
        eventSessionId: sessionId,
        status: 'CONFIRMED',
        buyerName: 'Buyer',
        buyerEmail: 'buyer@test.invalid',
        currency: 'INR',
        subtotalMinor: 0,
        totalMinor: 0,
        holdExpiresAt: new Date(Date.now() + 3_600_000),
        reference: `SUSPDEV-${suffix}`,
      },
    });
    for (let i = 0; i < 8; i++) {
      const t = await db!.ticket.create({
        data: {
          bookingId: booking.id,
          ticketTypeId: tt.id,
          eventSessionId: sessionId,
          organizationId: orgId,
          serial: `TKT-${i}-${suffix}`,
          nonce: `n-${i}-${suffix}`,
          status: 'ACTIVE',
          holderName: `Holder ${i}`,
        },
      });
      tickets.push({ id: t.id, nonce: t.nonce });
    }
    ownerToken = await login(owner.email);
    doorToken = await login(staff.email);
  }, 180_000);

  afterAll(async () => {
    if (previousFlag === undefined) delete process.env.OFFLINE_CHECKIN_ENABLED;
    else process.env.OFFLINE_CHECKIN_ENABLED = previousFlag;
    if (previousWindow === undefined) delete process.env.OFFLINE_REVOCATION_WINDOW_MINUTES;
    else process.env.OFFLINE_REVOCATION_WINDOW_MINUTES = previousWindow;
    if (db && available) {
      const users = await db.user.findMany({
        where: { email: { contains: suffix } },
        select: { id: true },
      });
      const ids = users.map((u: { id: string }) => u.id);
      await db.offlineReconciliationRecord.deleteMany({ where: { organizationId: orgId } });
      await db.checkInManifest.deleteMany({ where: { organizationId: orgId } });
      await db.offlineActivation.deleteMany({ where: { organizationId: orgId } });
      await db.checkInDevice.deleteMany({ where: { organizationId: orgId } });
      await db.checkIn.deleteMany({ where: { eventSessionId: sessionId } });
      await db.booking.deleteMany({ where: { organizationId: orgId } });
      await db.auditLog.deleteMany({
        where: { OR: [{ organizationId: orgId }, { actorUserId: { in: ids } }] },
      });
      await db.organizationMember.deleteMany({ where: { organizationId: orgId } });
      await db.event.deleteMany({ where: { organizationId: orgId } });
      await db.venue.deleteMany({ where: { organizationId: orgId } });
      await db.organization.deleteMany({ where: { id: orgId } });
      await db.refreshToken.deleteMany({ where: { userId: { in: ids } } });
      await db.user.deleteMany({ where: { id: { in: ids } } });
      await db.$disconnect();
    }
    if (app) await app.close();
  }, 120_000);

  const maybe = (name: string, fn: () => Promise<void>, timeout = 60_000) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  maybe('1. before suspension the door phone is approved, synced and covered', async () => {
    const reg = await register(doorToken, 'Gate 1 phone');
    expect(reg.status).toBe(201);
    door.deviceId = reg.data.id;
    const ok = await http('POST', `/checkin/devices/${door.deviceId}/approve`, ownerToken);
    expect(ok.status).toBeLessThan(300);
    const pending = await register(doorToken, 'Gate 2 phone, never approved');
    door.pendingId = pending.data.id;

    const list = await sync(doorToken, door.deviceId);
    expect(list.status).toBe(200);
    // The offline lease: the list carries its own expiry, bounded by the revocation window.
    // 60 is configured above; the owner's maximum is 45 minutes and the list must say so.
    expect(list.data.meta.expiresAt - list.data.meta.validFrom).toBeLessThanOrEqual(45 * 60_000);

    // A third phone, approved and then reported lost BEFORE the suspension.
    const lost = await register(doorToken, 'Gate 3 phone, lost');
    door.lostId = lost.data.id;
    expect(
      (await http('POST', `/checkin/devices/${door.lostId}/approve`, ownerToken)).status,
    ).toBeLessThan(300);
    const lostRes = await http('POST', `/checkin/devices/${door.lostId}/report-lost`, ownerToken, {
      reason: 'Left on the bus',
    });
    expect(lostRes.status).toBeLessThan(300);
    const lostRow = await deviceRow(door.lostId);
    expect(lostRow.revokeReason).toBe('LOST');
    expect(lostRow.revokeReasons).toEqual([expect.stringMatching(/Z LOST$/)]);

    const activation = await db!.offlineActivation.create({
      data: {
        organizationId: orgId,
        eventId,
        eventSessionId: sessionId,
        deviceIds: [door.deviceId],
        reason: 'test',
        evidenceSnapshot: {},
        approvedByUserId: adminId,
      },
    });
    door.activationId = activation.id;
    expect((await scanOnline(0)).status).toBeLessThan(300);
  });

  maybe('2. suspending the organization revokes every device and the activation', async () => {
    suspendedAt = Date.now();
    await lifecycle.setSuspended(adminUser(), orgId, true, 'Compliance request unanswered');

    for (const id of [door.deviceId, door.pendingId]) {
      const row = await deviceRow(id);
      expect(row.status).toBe('REVOKED');
      expect(row.revokedAt).toBeInstanceOf(Date);
      expect(row.revokeReason).toBe('ORGANIZATION_SUSPENDED');
      expect(row.revokeReasons).toEqual([expect.stringMatching(/Z ORGANIZATION_SUSPENDED$/)]);
      const audit = await db!.auditLog.findFirst({
        where: { entityId: id, action: 'CHECKIN_DEVICE_REVOKED' },
      });
      expect(audit?.metadata).toMatchObject({ reason: 'ORGANIZATION_SUSPENDED' });
    }
    // The lost phone keeps its FIRST reason; the suspension is appended to its history.
    const lostRow = await deviceRow(door.lostId);
    expect(lostRow.status).toBe('REVOKED');
    expect(lostRow.revokeReason).toBe('LOST');
    expect(lostRow.revokeReasons).toEqual([
      expect.stringMatching(/Z LOST$/),
      expect.stringMatching(/Z ORGANIZATION_SUSPENDED$/),
    ]);
    const act = await db!.offlineActivation.findUnique({ where: { id: door.activationId } });
    expect(act.state).toBe('REVOKED');
    expect(act.revokedAt).toBeInstanceOf(Date);
    const suspended = await db!.auditLog.findFirst({
      where: { entityId: orgId, action: 'ORGANIZATION_SUSPENDED' },
    });
    expect(suspended?.metadata).toMatchObject({
      checkInDevicesRevoked: 2,
      offlineActivationsRevoked: 1,
    });
  });

  maybe('3. while suspended every door path answers 403 ORGANIZATION_SUSPENDED', async () => {
    const reg = await register(doorToken, 'Gate 3 phone');
    for (const r of [
      await scanOnline(1),
      await http('POST', '/checkins/visual', doorToken, { ticketId: tickets[1].id }),
      await sync(doorToken, door.deviceId),
      await http(
        'GET',
        `/checkin/deltas?eventSessionId=${sessionId}&sinceMs=0&deviceId=${door.deviceId}`,
        doorToken,
      ),
      reg,
      await http('POST', `/checkin/devices/${door.pendingId}/approve`, ownerToken),
    ]) {
      expect(r.status).toBe(403);
      expect(codeOf(r)).toBe('ORGANIZATION_SUSPENDED');
    }
    expect(await ticketStatus(1)).toBe('ACTIVE');
  });

  maybe('4. while suspended a queued offline scan is rejected, named, and held', async () => {
    // Made offline BEFORE the suspension, on a valid list - uploaded after it.
    const up = await upload(doorToken, door.deviceId, 2, suspendedAt - 1_000);
    expect(up.status).toBe(403);
    expect(codeOf(up)).toBe('ORGANIZATION_SUSPENDED');
    expect(detailsOf(up)).toMatchObject({
      heldForReview: 1,
      rejected: [{ ticketId: tickets[2].id, reason: 'ORGANIZATION_SUSPENDED' }],
    });
    expect(await ticketStatus(2)).toBe('ACTIVE');
    const held = await db!.offlineReconciliationRecord.findMany({
      where: { deviceId: door.deviceId, ticketId: tickets[2].id },
    });
    expect(
      held.map((r: { outcome: string; reviewState: string }) => [r.outcome, r.reviewState]),
    ).toEqual([['DEVICE_NOT_ACTIVE', 'PENDING']]);
  });

  maybe('5. reinstatement does not revive the old phone or apply its queue', async () => {
    await lifecycle.setSuspended(adminUser(), orgId, false);
    expect((await deviceRow(door.deviceId)).status).toBe('REVOKED');

    const list = await sync(doorToken, door.deviceId);
    expect(list.status).toBe(403);
    expect(codeOf(list)).toBe('DEVICE_NOT_ACTIVE');
    expect(detailsOf(list)).toMatchObject({
      deviceStatus: 'REVOKED',
      revokeReason: 'ORGANIZATION_SUSPENDED',
    });

    // A scan made DURING the suspension on the list from before it, uploaded after reinstatement.
    const up = await upload(doorToken, door.deviceId, 3, Date.now() - 1_000);
    expect(up.status).toBe(403);
    expect(codeOf(up)).toBe('DEVICE_NOT_ACTIVE');
    expect(detailsOf(up)).toMatchObject({
      rejected: [{ ticketId: tickets[3].id, reason: 'DEVICE_NOT_ACTIVE' }],
    });
    expect(await ticketStatus(3)).toBe('ACTIVE');

    const again = await http('POST', `/checkin/devices/${door.deviceId}/approve`, ownerToken);
    expect(again.status).toBe(409);
    expect((await deviceRow(door.deviceId)).status).toBe('REVOKED');
  });

  let freshId = '';
  maybe('6. a phone registered and approved after reinstatement works', async () => {
    const reg = await register(doorToken, 'Gate 1 phone, new');
    expect(reg.status).toBe(201);
    freshId = reg.data.id;
    expect(
      (await http('POST', `/checkin/devices/${freshId}/approve`, ownerToken)).status,
    ).toBeLessThan(300);
    expect((await sync(doorToken, freshId)).status).toBe(200);
    const up = await upload(doorToken, freshId, 4, Date.now() - 1_000);
    expect(up.status).toBeLessThan(300);
    expect(up.data).toEqual([{ ticketId: tickets[4].id, outcome: 'ACCEPTED' }]);
    expect(await ticketStatus(4)).toBe('CHECKED_IN');
  });

  maybe('7. a scan claimed after the lease ran out is never applied', async () => {
    const lease = proof.get(freshId)!;
    const up = await upload(doorToken, freshId, 5, lease.expiresAt + 10 * 60_000);
    expect(up.status).toBeLessThan(300);
    expect(up.data).toEqual([{ ticketId: tickets[5].id, outcome: 'MANIFEST_NOT_VALID' }]);
    expect(await ticketStatus(5)).toBe('ACTIVE');
  });
});
