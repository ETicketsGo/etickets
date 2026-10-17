import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { QrService } from '../../tickets/qr.service';
import { AllExceptionsFilter } from '../../common/all-exceptions.filter';
import { OfflineManifestService } from './offline-manifest.service';

/**
 * integration-real-postgres, whole app over HTTP, offline check-in ON: only an ACTIVE device
 * works the door offline, and only for the revocation window (H5).
 *
 * Before H5:
 *  - reconcile refused REVOKED devices only, so a PENDING or SUSPENDED device's queued scans
 *    were applied and spent tickets;
 *  - the ticket list (manifest) was not tied to a device: any team member could download one
 *    for any session, whatever state their phone was in, and it stayed valid for 6 hours.
 *
 * What this pins, over real HTTP and real rows:
 *  1. an ACTIVE device gets a list signed for it, valid for the window (45 min by default),
 *     and its scans made against that list are applied;
 *  2. a PENDING device gets no list and no delta, and its upload is refused with nothing kept;
 *  3. a SUSPENDED device gets no list, and its upload is refused: the scans are kept as
 *     DEVICE_NOT_ACTIVE evidence pending a manager's review, never applied, never duplicated;
 *  4. a REVOKED device: the same;
 *  5. a scan made on an expired list is held (MANIFEST_NOT_VALID), not applied;
 *  6. a list signed for device A does not admit for device B, and neither does no list;
 *  7. online check-in is untouched by any of it.
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
const WINDOW_MS = 45 * 60_000;

describe('integration-real-postgres: offline device status and revocation window (HTTP)', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let app: INestApplication | undefined;
  let base = '';
  let qr: QrService;
  let manifests: OfflineManifestService;
  let available = false;
  const previousFlag = process.env.OFFLINE_CHECKIN_ENABLED;
  const previousWindow = process.env.OFFLINE_REVOCATION_WINDOW_MINUTES;

  const suffix = `h5win-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  let orgId = '';
  let eventId = '';
  let sessionId = '';
  let otherEventId = '';
  const tickets: { id: string; nonce: string }[] = [];
  let ownerToken = '';

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

  const register = async (name: string, scope: { eventId?: string } = { eventId }) => {
    const reg = await http('POST', '/checkin/devices', ownerToken, {
      organizationId: orgId,
      ...scope,
      name,
    });
    expect(reg.status).toBe(201);
    expect(reg.data.status).toBe('PENDING');
    return reg.data.id as string;
  };
  const approve = async (id: string) => {
    const ok = await http('POST', `/checkin/devices/${id}/approve`, ownerToken);
    expect(ok.status).toBeLessThan(300);
    expect(ok.data.status).toBe('ACTIVE');
  };
  const activeDevice = async (name: string) => {
    const id = await register(name);
    await approve(id);
    return id;
  };

  const manifestFor = (deviceId?: string) =>
    http(
      'GET',
      `/checkin/manifest?eventSessionId=${sessionId}${deviceId ? `&deviceId=${deviceId}` : ''}`,
      ownerToken,
    );
  const deltaFor = (deviceId: string) =>
    http(
      'GET',
      `/checkin/deltas?eventSessionId=${sessionId}&sinceMs=0&deviceId=${deviceId}`,
      ownerToken,
    );
  /** One scan the phone made offline, as it uploads it. */
  const scan = (
    deviceId: string,
    i: number,
    proof: { manifestVersion?: number; manifestSignature?: string },
    checkedInAt = Date.now() - 1_000,
  ) => ({
    ticketId: tickets[i].id,
    deviceId,
    nonce: tickets[i].nonce,
    version: 1,
    eventSessionId: sessionId,
    checkedInAt,
    wasOverride: false,
    ...proof,
  });
  const upload = (deviceId: string, checkIns: unknown[]) =>
    http('POST', '/checkin/reconcile', ownerToken, { deviceId, checkIns });
  const proofOf = (m: { data: any }) => ({
    manifestVersion: m.data.meta.version as number,
    manifestSignature: m.data.signature as string,
  });
  const ticketStatus = async (i: number) =>
    (await db!.ticket.findUnique({ where: { id: tickets[i].id } })).status;
  const ledger = (deviceId: string) =>
    db!.offlineReconciliationRecord.findMany({
      where: { deviceId },
      orderBy: { createdAt: 'asc' },
      select: { ticketId: true, outcome: true, reviewState: true },
    });
  const setStatus = (id: string, action: 'suspend' | 'revoke') =>
    http('POST', `/checkin/devices/${id}/${action}`, ownerToken, { reason: 'Walk test' });

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
    process.env.ORGANIZER_WEB_URL = 'https://organizer.example.test';
    process.env.THROTTLE_LIMIT = '5000';
    process.env.AUTH_THROTTLE_LIMIT = '5000';
    // The feature this is about. Off by default (and on QA), where every /checkin route 404s.
    process.env.OFFLINE_CHECKIN_ENABLED = 'true';
    // Unset: the default window is what is being pinned.
    delete process.env.OFFLINE_REVOCATION_WINDOW_MINUTES;
    // Loaded only now: ConfigModule.forRoot reads process.env when app.module is first
    // imported, so a static import would freeze the flag at its .env value (off).
    const { AppModule } = await import('../../app.module');

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    qr = app.get(QrService);
    manifests = app.get(OfflineManifestService);

    const owner = await db!.user.create({
      data: {
        email: `owner-${suffix}@test.invalid`,
        fullName: 'Owner',
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        roles: ['CUSTOMER'],
      },
    });
    const org = await db!.organization.create({
      data: { name: `Walk H5 Org ${suffix}`, slug: `walk-h5-${suffix}`, status: 'APPROVED' },
    });
    orgId = org.id;
    await db!.organizationMember.create({
      data: { organizationId: orgId, userId: owner.id, role: 'ORGANIZER_OWNER', status: 'ACTIVE' },
    });
    const venue = await db!.venue.create({
      data: { organizationId: orgId, name: `Walk Venue ${suffix}`, city: 'Hyderabad' },
    });
    const mkEvent = (n: string) =>
      db!.event.create({
        data: {
          organizationId: orgId,
          venueId: venue.id,
          title: `Walk Show ${n} ${suffix}`,
          slug: `walk-show-${n}-${suffix}`,
          category: 'MUSIC',
        },
      });
    eventId = (await mkEvent('a')).id;
    otherEventId = (await mkEvent('b')).id;
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
        reference: `H5WIN-${suffix}`,
      },
    });
    for (let i = 0; i < 12; i++) {
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
    const login = await http('POST', '/auth/login', undefined, {
      email: owner.email,
      password: PASSWORD,
    });
    expect(login.status).toBeLessThan(300);
    ownerToken = login.data.accessToken;
  }, 180_000);

  afterAll(async () => {
    if (previousFlag === undefined) delete process.env.OFFLINE_CHECKIN_ENABLED;
    else process.env.OFFLINE_CHECKIN_ENABLED = previousFlag;
    if (previousWindow !== undefined)
      process.env.OFFLINE_REVOCATION_WINDOW_MINUTES = previousWindow;
    if (db && available) {
      const users = await db.user.findMany({
        where: { email: { contains: suffix } },
        select: { id: true },
      });
      const ids = users.map((u: { id: string }) => u.id);
      await db.offlineReconciliationRecord.deleteMany({ where: { organizationId: orgId } });
      await db.checkInManifest.deleteMany({ where: { organizationId: orgId } });
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

  maybe(
    '1. an ACTIVE device gets a list signed for it, valid for the window, and uploads',
    async () => {
      const dev = await activeDevice('Walk H5 gate 1');
      const m = await manifestFor(dev);
      expect(m.status).toBe(200);
      expect(m.data.meta.deviceId).toBe(dev);
      // The default window: 45 minutes, not the 6 hours it used to be.
      expect(m.data.meta.expiresAt - m.data.meta.validFrom).toBe(WINDOW_MS);
      expect(manifests.verify(m.data)).toBe(true);
      // The issued row records the device too.
      const row = await db!.checkInManifest.findFirst({
        where: { eventSessionId: sessionId, version: m.data.meta.version },
      });
      expect(row.deviceId).toBe(dev);

      const delta = await deltaFor(dev);
      expect(delta.status).toBe(200);
      expect(delta.data.deviceId).toBe(dev);

      const up = await upload(dev, [scan(dev, 0, proofOf(m))]);
      expect(up.status).toBeLessThan(300);
      expect(up.data).toEqual([{ ticketId: tickets[0].id, outcome: 'ACCEPTED' }]);
      expect(await ticketStatus(0)).toBe('CHECKED_IN');

      // A list is always for one device: asking without one is a bad request.
      const none = await manifestFor();
      expect(none.status).toBe(400);
    },
  );

  maybe('2. a PENDING device gets no list, no delta, and its upload is refused', async () => {
    const dev = await register('Walk H5 gate pending');
    for (const r of [await manifestFor(dev), await deltaFor(dev)]) {
      expect(r.status).toBe(403);
      expect(codeOf(r)).toBe('DEVICE_NOT_ACTIVE');
      expect(detailsOf(r).deviceStatus).toBe('PENDING');
    }
    const up = await upload(dev, [scan(dev, 1, {})]);
    expect(up.status).toBe(403);
    expect(codeOf(up)).toBe('DEVICE_NOT_ACTIVE');
    // Never approved, so it never held a list: nothing it sends is evidence of an admission.
    expect(detailsOf(up).heldForReview).toBe(0);
    expect(await ticketStatus(1)).toBe('ACTIVE');
    expect(await ledger(dev)).toEqual([]);
  });

  maybe('3. a SUSPENDED device: no list, upload refused, scans held for review', async () => {
    const dev = await activeDevice('Walk H5 gate suspended');
    // It synced while ACTIVE and scanned two people in, then lost signal...
    const m = await manifestFor(dev);
    expect(m.status).toBe(200);
    const queue = [scan(dev, 2, proofOf(m)), scan(dev, 3, proofOf(m))];
    // ...and a manager suspended it before it came back online.
    expect((await setStatus(dev, 'suspend')).status).toBeLessThan(300);

    for (const r of [await manifestFor(dev), await deltaFor(dev)]) {
      expect(r.status).toBe(403);
      expect(codeOf(r)).toBe('DEVICE_NOT_ACTIVE');
      expect(detailsOf(r).deviceStatus).toBe('SUSPENDED');
      expect(r.json?.error?.message ?? r.json?.message).toMatch(/suspended/i);
    }
    const up = await upload(dev, queue);
    expect(up.status).toBe(403);
    expect(codeOf(up)).toBe('DEVICE_NOT_ACTIVE');
    expect(detailsOf(up)).toMatchObject({ deviceStatus: 'SUSPENDED', heldForReview: 2 });
    // Never applied: both tickets are unspent and nobody is recorded as admitted.
    expect(await ticketStatus(2)).toBe('ACTIVE');
    expect(await ticketStatus(3)).toBe('ACTIVE');
    expect(
      await db!.checkIn.count({ where: { ticketId: { in: [tickets[2].id, tickets[3].id] } } }),
    ).toBe(0);
    // Kept as evidence, waiting for a manager.
    const held = [
      { ticketId: tickets[2].id, outcome: 'DEVICE_NOT_ACTIVE', reviewState: 'PENDING' },
      { ticketId: tickets[3].id, outcome: 'DEVICE_NOT_ACTIVE', reviewState: 'PENDING' },
    ];
    expect(await ledger(dev)).toEqual(held);
    // The phone retries: still refused, and the evidence is not written twice.
    expect((await upload(dev, queue)).status).toBe(403);
    expect(await ledger(dev)).toEqual(held);
    // The manager sees them in the reconciliation console as cases to review.
    const console_ = await http(
      'GET',
      `/checkin/reconciliation?organizationId=${orgId}&reviewState=PENDING&pageSize=50`,
      ownerToken,
    );
    expect(console_.status).toBe(200);
    const rows = (console_.data.items ?? console_.data.data ?? console_.data) as {
      deviceId: string;
      outcome: string;
    }[];
    expect(rows.filter((r) => r.deviceId === dev).map((r) => r.outcome)).toEqual([
      'DEVICE_NOT_ACTIVE',
      'DEVICE_NOT_ACTIVE',
    ]);
  });

  maybe('4. a REVOKED device: no list, upload refused, scans held for review', async () => {
    const dev = await activeDevice('Walk H5 gate revoked');
    const m = await manifestFor(dev);
    expect(m.status).toBe(200);
    expect((await setStatus(dev, 'revoke')).status).toBeLessThan(300);

    const r = await manifestFor(dev);
    expect(r.status).toBe(403);
    expect(detailsOf(r).deviceStatus).toBe('REVOKED');
    expect((await deltaFor(dev)).status).toBe(403);

    const up = await upload(dev, [scan(dev, 4, proofOf(m))]);
    expect(up.status).toBe(403);
    expect(detailsOf(up)).toMatchObject({ deviceStatus: 'REVOKED', heldForReview: 1 });
    expect(await ticketStatus(4)).toBe('ACTIVE');
    expect(await ledger(dev)).toEqual([
      { ticketId: tickets[4].id, outcome: 'DEVICE_NOT_ACTIVE', reviewState: 'PENDING' },
    ]);
  });

  maybe('5. a scan made on an expired list is held, not applied', async () => {
    const dev = await activeDevice('Walk H5 gate expired list');
    const m = await manifestFor(dev);
    expect(m.status).toBe(200);
    // The phone claims a scan an hour after its list ran out.
    const late = m.data.meta.expiresAt + 60 * 60_000;
    const up = await upload(dev, [scan(dev, 5, proofOf(m), late)]);
    expect(up.status).toBeLessThan(300);
    expect(up.data).toEqual([{ ticketId: tickets[5].id, outcome: 'MANIFEST_NOT_VALID' }]);
    expect(await ticketStatus(5)).toBe('ACTIVE');

    // Same, the way it really happens: the list it holds has run out by the time it scans.
    await db!.checkInManifest.updateMany({
      where: { eventSessionId: sessionId, version: m.data.meta.version },
      data: {
        validFrom: new Date(Date.now() - 2 * WINDOW_MS),
        expiresAt: new Date(Date.now() - WINDOW_MS),
      },
    });
    const stale = await upload(dev, [scan(dev, 6, proofOf(m))]);
    expect(stale.data).toEqual([{ ticketId: tickets[6].id, outcome: 'MANIFEST_NOT_VALID' }]);
    expect(await ticketStatus(6)).toBe('ACTIVE');
    expect(await ledger(dev)).toEqual([
      { ticketId: tickets[5].id, outcome: 'MANIFEST_NOT_VALID', reviewState: 'PENDING' },
      { ticketId: tickets[6].id, outcome: 'MANIFEST_NOT_VALID', reviewState: 'PENDING' },
    ]);
    const audit = await db!.auditLog.findFirst({
      where: {
        organizationId: orgId,
        action: 'OFFLINE_CHECKIN_RECONCILED',
        metadata: { path: ['ticketId'], equals: tickets[6].id },
      },
    });
    expect(audit?.metadata).toMatchObject({ manifestProblem: 'OUTSIDE_VALIDITY' });
  });

  maybe('6. a list signed for device A does not admit for device B', async () => {
    const a = await activeDevice('Walk H5 gate A');
    const b = await activeDevice('Walk H5 gate B');
    const ma = await manifestFor(a);
    expect(ma.status).toBe(200);
    // The signature covers the device: A's list does not verify as B's.
    expect(manifests.verify({ ...ma.data, meta: { ...ma.data.meta, deviceId: b } })).toBe(false);

    // B uploads a scan citing A's list, then one citing none at all.
    const up = await upload(b, [scan(b, 7, proofOf(ma)), scan(b, 8, {})]);
    expect(up.status).toBeLessThan(300);
    expect(up.data).toEqual([
      { ticketId: tickets[7].id, outcome: 'MANIFEST_NOT_VALID' },
      { ticketId: tickets[8].id, outcome: 'MANIFEST_NOT_VALID' },
    ]);
    expect(await ticketStatus(7)).toBe('ACTIVE');
    expect(await ticketStatus(8)).toBe('ACTIVE');
    const reasons = await db!.auditLog.findMany({
      where: {
        organizationId: orgId,
        action: 'OFFLINE_CHECKIN_RECONCILED',
        metadata: { path: ['deviceId'], equals: b },
      },
      select: { metadata: true },
    });
    expect(reasons.map((r: { metadata: any }) => r.metadata.manifestProblem).sort()).toEqual([
      'NO_MANIFEST',
      'OTHER_DEVICE',
    ]);
    // A forged signature on B's own version does not pass either.
    const mb = await manifestFor(b);
    const forged = await upload(b, [
      scan(b, 9, { ...proofOf(mb), manifestSignature: 'f'.repeat(64) }),
    ]);
    expect(forged.data).toEqual([{ ticketId: tickets[9].id, outcome: 'MANIFEST_NOT_VALID' }]);
    // B's own list does.
    const ok = await upload(b, [scan(b, 9, proofOf(mb))]);
    expect(ok.data).toEqual([{ ticketId: tickets[9].id, outcome: 'ACCEPTED' }]);

    // A device set up for another event gets no list for this one.
    const elsewhere = await register('Walk H5 gate other event', { eventId: otherEventId });
    await approve(elsewhere);
    expect((await manifestFor(elsewhere)).status).toBe(403);
  });

  maybe('7. online check-in is untouched', async () => {
    const r = await http('POST', '/checkins', ownerToken, {
      token: qr.sign({
        ticketId: tickets[10].id,
        eventSessionId: sessionId,
        nonce: tickets[10].nonce,
        version: 1,
      }),
    });
    expect(r.status).toBeLessThan(300);
    expect(JSON.stringify(r.json)).toContain('SUCCESS');
    expect(await ticketStatus(10)).toBe('CHECKED_IN');
  });
});
