import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { QrService } from '../../tickets/qr.service';
import { AllExceptionsFilter } from '../../common/all-exceptions.filter';

/**
 * integration-real-postgres, whole app over HTTP, offline check-in ON: taking somebody off the
 * team takes their door phone off the door.
 *
 * PR #406 made removeMember revoke the check-in devices the member registered or was handed.
 * It could not be walked on QA, where OFFLINE_CHECKIN_ENABLED is off and every /checkin route
 * answers 404, so this proves it end to end against real rows instead:
 *
 *  1. a member registers a device, the owner approves it, and it syncs a signed manifest,
 *     admits a ticket online and uploads a queued offline scan;
 *  2. the owner removes the member: the device reads REVOKED, the member's held session is
 *     refused on sync, scan and upload (401 ACCESS_REMOVED), their refresh token is dead, and
 *     the phone's queue uploaded by somebody still on the team is refused (403
 *     DEVICE_NOT_ACTIVE) with the ticket left unspent and the scan held for review (H5);
 *  3. another member's device is untouched and keeps working;
 *  4. inviting the member back does not bring the old device back - not by the invitation, and
 *     not by approving it again (that used to work: `approve` set any status to ACTIVE);
 *  5. changing a member's role keeps the membership and keeps their devices (there is no
 *     role-less membership: the three seat roles are all door roles).
 *
 * The tests run in order and share one organization, like a real evening at the door.
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
/** iat is whole seconds: step past the second a token was minted in before a removal. */
const nextSecond = () => new Promise((r) => setTimeout(r, 1100));

describe('integration-real-postgres: removing a member revokes their check-in devices (HTTP)', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let app: INestApplication | undefined;
  let base = '';
  let qr: QrService;
  let available = false;
  const previousFlag = process.env.OFFLINE_CHECKIN_ENABLED;

  const suffix = `devrev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const doorEmail = `door-${suffix}@test.invalid`;
  const otherEmail = `other-${suffix}@test.invalid`;
  const shiftEmail = `shift-${suffix}@test.invalid`;
  let orgId = '';
  let eventId = '';
  let sessionId = '';
  const tickets: { id: string; nonce: string }[] = [];
  let ownerToken = '';

  // Carried between the ordered tests below.
  const door = { memberId: '', access: '', refresh: '', deviceId: '' };
  const other = { memberId: '', access: '', deviceId: '' };

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

  const login = async (email: string) => {
    const r = await http('POST', '/auth/login', undefined, { email, password: PASSWORD });
    expect(r.status).toBeLessThan(300);
    return { access: r.data.accessToken as string, refresh: r.data.refreshToken as string };
  };

  /** Invite over HTTP as the owner, accept the emailed link over HTTP, sign in. */
  async function inviteAndAccept(email: string, role: string) {
    const inv = await http('POST', `/organizations/${orgId}/members`, ownerToken, { email, role });
    expect(inv.status).toBe(201);
    const inviteToken = String(inv.data.inviteUrl).split('/').pop()!;
    const acc = await http('POST', `/public/invitations/${inviteToken}/accept`, undefined, {
      password: PASSWORD,
      fullName: 'Door Person',
    });
    expect(acc.status).toBeLessThan(300);
    return { memberId: inv.data.id as string, ...(await login(email)) };
  }

  /** Register as the member, approve as the owner: the two steps a gate phone goes through. */
  async function registeredAndApproved(token: string, name: string) {
    const reg = await http('POST', '/checkin/devices', token, {
      organizationId: orgId,
      eventId,
      eventSessionId: sessionId,
      name,
    });
    expect(reg.status).toBe(201);
    expect(reg.data.status).toBe('PENDING');
    const ok = await http('POST', `/checkin/devices/${reg.data.id}/approve`, ownerToken);
    expect(ok.status).toBeLessThan(300);
    expect(ok.data.status).toBe('ACTIVE');
    return reg.data.id as string;
  }

  /*
    H5: a ticket list is issued to one ACTIVE device, and an uploaded scan cites the list it was
    made against. `proof` keeps the last list each device synced, as the phone would.
  */
  const proof = new Map<string, { manifestVersion: number; manifestSignature: string }>();
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
      });
    }
    return r;
  };
  const scanOnline = (token: string, i: number) =>
    http('POST', '/checkins', token, {
      token: qr.sign({
        ticketId: tickets[i].id,
        eventSessionId: sessionId,
        nonce: tickets[i].nonce,
        version: 1,
      }),
    });
  /** What the phone sends when it comes back online with a scan it made offline. */
  const upload = (token: string, deviceId: string, i: number) =>
    http('POST', '/checkin/reconcile', token, {
      deviceId,
      checkIns: [
        {
          ticketId: tickets[i].id,
          deviceId,
          nonce: tickets[i].nonce,
          version: 1,
          eventSessionId: sessionId,
          checkedInAt: Date.now() - 1_000,
          wasOverride: false,
          ...proof.get(deviceId),
        },
      ],
    });
  const deviceRow = (id: string) => db!.checkInDevice.findUnique({ where: { id } });
  const ticketStatus = async (i: number) =>
    (await db!.ticket.findUnique({ where: { id: tickets[i].id } })).status;

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

    const hash = await bcrypt.hash(PASSWORD, 10);
    const owner = await db!.user.create({
      data: {
        email: `owner-${suffix}@test.invalid`,
        fullName: 'Owner',
        passwordHash: hash,
        roles: ['CUSTOMER'],
      },
    });
    const org = await db!.organization.create({
      data: { name: `Walk Door Org ${suffix}`, slug: `walk-door-${suffix}`, status: 'APPROVED' },
    });
    orgId = org.id;
    await db!.organizationMember.create({
      data: { organizationId: orgId, userId: owner.id, role: 'ORGANIZER_OWNER', status: 'ACTIVE' },
    });
    const venue = await db!.venue.create({
      data: { organizationId: orgId, name: `Walk Venue ${suffix}`, city: 'Hyderabad' },
    });
    const event = await db!.event.create({
      data: {
        organizationId: orgId,
        venueId: venue.id,
        title: `Walk Show ${suffix}`,
        slug: `walk-show-${suffix}`,
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
        reference: `DEVREV-${suffix}`,
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
    ownerToken = (await login(owner.email)).access;
  }, 180_000);

  afterAll(async () => {
    if (previousFlag === undefined) delete process.env.OFFLINE_CHECKIN_ENABLED;
    else process.env.OFFLINE_CHECKIN_ENABLED = previousFlag;
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
      await db.accountInvitation.deleteMany({ where: { userId: { in: ids } } });
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

  maybe('1. a member registers a device, it is approved, and it syncs and scans', async () => {
    Object.assign(door, await inviteAndAccept(doorEmail, 'CHECKIN_STAFF'));
    door.deviceId = await registeredAndApproved(door.access, 'Walk Gate 1 phone');
    Object.assign(other, await inviteAndAccept(otherEmail, 'CHECKIN_STAFF'));
    other.deviceId = await registeredAndApproved(other.access, 'Walk Gate 2 phone');

    const manifest = await sync(door.access, door.deviceId);
    expect(manifest.status).toBe(200);
    expect(manifest.data.meta.deviceId).toBe(door.deviceId);
    expect((await sync(other.access, other.deviceId)).status).toBe(200);
    expect(manifest.data.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.data.entries.map((e: { ticketId: string }) => e.ticketId)).toContain(
      tickets[0].id,
    );

    const online = await scanOnline(door.access, 0);
    expect(online.status).toBeLessThan(300);
    expect(JSON.stringify(online.json)).toContain('SUCCESS');

    const queued = await upload(door.access, door.deviceId, 1);
    expect(queued.status).toBeLessThan(300);
    expect(queued.data).toEqual([{ ticketId: tickets[1].id, outcome: 'ACCEPTED' }]);
    expect(await ticketStatus(1)).toBe('CHECKED_IN');
  });

  maybe('2. the owner removes the member, and the device is revoked and refused', async () => {
    await nextSecond();
    const removed = await http(
      'DELETE',
      `/organizations/${orgId}/members/${door.memberId}`,
      ownerToken,
    );
    expect(removed.status).toBeLessThan(300);
    expect(removed.data.status).toBe('REMOVED');
    expect(removed.data.revoked).toMatchObject({ devices: 1, signedOut: true });

    // Status: what the owner's devices page reads, and what is stored.
    const list = await http('GET', `/checkin/devices?organizationId=${orgId}`, ownerToken);
    expect(list.status).toBe(200);
    const listed = (list.data as { id: string; status: string }[]).find(
      (d) => d.id === door.deviceId,
    );
    expect(listed?.status).toBe('REVOKED');
    expect((await deviceRow(door.deviceId)).status).toBe('REVOKED');
    // And the device's own audit trail says why.
    const audit = await db!.auditLog.findFirst({
      where: { entityId: door.deviceId, action: 'CHECKIN_DEVICE_REVOKED' },
    });
    expect(audit?.metadata).toMatchObject({ reason: 'MEMBER_REMOVED', memberId: door.memberId });

    // The phone's own session is ended: sync, online scan and upload are all refused with the
    // code the console turns into "You no longer have access to ...".
    for (const r of [
      await sync(door.access, door.deviceId),
      await scanOnline(door.access, 2),
      await upload(door.access, door.deviceId, 3),
      await http(
        'GET',
        `/checkin/deltas?eventSessionId=${sessionId}&sinceMs=0&deviceId=${door.deviceId}`,
        door.access,
      ),
    ]) {
      expect(r.status).toBe(401);
      expect(codeOf(r)).toBe('ACCESS_REMOVED');
    }
    // ...and it cannot quietly mint a new one.
    const refresh = await http('POST', '/auth/refresh', undefined, { refreshToken: door.refresh });
    expect(refresh.status).toBe(401);

    // The device id itself is unusable: a teammate who picks the phone up and uploads its queue
    // under their own still-valid session is refused, and the ticket is not spent. The scan is
    // kept as evidence for a manager (H5), never applied.
    const pickedUp = await upload(other.access, door.deviceId, 3);
    expect(pickedUp.status).toBe(403);
    expect(codeOf(pickedUp)).toBe('DEVICE_NOT_ACTIVE');
    expect(await ticketStatus(3)).toBe('ACTIVE');
    const held = await db!.offlineReconciliationRecord.findMany({
      where: { deviceId: door.deviceId, ticketId: tickets[3].id },
    });
    expect(
      held.map((r: { outcome: string; reviewState: string }) => [r.outcome, r.reviewState]),
    ).toEqual([['DEVICE_NOT_ACTIVE', 'PENDING']]);

    // Signing in again starts a fresh session, but with no seat: the door stays shut (403).
    await nextSecond();
    const fresh = await login(doorEmail);
    expect((await sync(fresh.access, door.deviceId)).status).toBe(403);
    expect((await upload(fresh.access, door.deviceId, 3)).status).toBe(403);
    expect((await scanOnline(fresh.access, 2)).status).toBe(403);
    expect(await ticketStatus(2)).toBe('ACTIVE');
    door.access = fresh.access;
  });

  maybe('3. a device registered by another member is untouched and keeps working', async () => {
    const row = await deviceRow(other.deviceId);
    expect(row.status).toBe('ACTIVE');
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());

    expect((await sync(other.access, other.deviceId)).status).toBe(200);
    const queued = await upload(other.access, other.deviceId, 4);
    expect(queued.status).toBeLessThan(300);
    expect(queued.data).toEqual([{ ticketId: tickets[4].id, outcome: 'ACCEPTED' }]);
    expect(await ticketStatus(4)).toBe('CHECKED_IN');
  });

  maybe('4. inviting the member back does not revive the old device', async () => {
    // Back as a MANAGER this time, so they could try to approve their old phone themselves.
    const inv = await http('POST', `/organizations/${orgId}/members`, ownerToken, {
      email: doorEmail,
      role: 'ORGANIZER_MANAGER',
    });
    expect(inv.status).toBe(201);
    expect(inv.data.id).toBe(door.memberId); // the same seat row, reused
    expect((await deviceRow(door.deviceId)).status).toBe('REVOKED');

    const inviteToken = String(inv.data.inviteUrl).split('/').pop()!;
    const acc = await http('POST', `/public/invitations/${inviteToken}/accept`, undefined, {});
    expect(acc.status).toBeLessThan(300);
    await nextSecond();
    const back = await login(doorEmail);

    // On the team again: their new session works (on a teammate's ACTIVE phone)...
    expect((await sync(back.access, other.deviceId)).status).toBe(200);
    // ...but not for the old phone, which cannot get a new list (H5).
    const oldSync = await sync(back.access, door.deviceId);
    expect(oldSync.status).toBe(403);
    expect(codeOf(oldSync)).toBe('DEVICE_NOT_ACTIVE');
    // ...but the old phone is still revoked, and its queue is still refused.
    expect((await deviceRow(door.deviceId)).status).toBe('REVOKED');
    const old = await upload(back.access, door.deviceId, 5);
    expect(old.status).toBe(403);
    expect(await ticketStatus(5)).toBe('ACTIVE');

    // Approving it again does not bring it back either - not by them, not by the owner.
    // A revoked device is gone for good; a new phone is registered and approved as new.
    for (const token of [back.access, ownerToken]) {
      const again = await http('POST', `/checkin/devices/${door.deviceId}/approve`, token);
      expect(again.status).toBe(409);
      expect(codeOf(again)).toBe('CONFLICT');
    }
    expect((await deviceRow(door.deviceId)).status).toBe('REVOKED');

    const fresh = await registeredAndApproved(back.access, 'Walk Gate 1 new phone');
    expect(fresh).not.toBe(door.deviceId);
    expect((await sync(back.access, fresh)).status).toBe(200);
    const ok = await upload(back.access, fresh, 5);
    expect(ok.data).toEqual([{ ticketId: tickets[5].id, outcome: 'ACCEPTED' }]);
  });

  maybe('5. changing a role keeps the membership and keeps the devices', async () => {
    // There is no "no role" seat: a role change picks one of OWNER / MANAGER / CHECKIN_STAFF,
    // and all three may work the door. So a demotion keeps the person's phone working and only
    // takes away what the new role cannot do (here: approving devices).
    const shift = await inviteAndAccept(shiftEmail, 'ORGANIZER_MANAGER');
    const phone = await registeredAndApproved(shift.access, 'Walk Gate 3 phone');

    const demoted = await http(
      'PATCH',
      `/organizations/${orgId}/members/${shift.memberId}`,
      ownerToken,
      {
        role: 'CHECKIN_STAFF',
      },
    );
    expect(demoted.status).toBeLessThan(300);
    expect(demoted.data).toMatchObject({ role: 'CHECKIN_STAFF', status: 'ACTIVE' });

    expect((await deviceRow(phone)).status).toBe('ACTIVE');
    expect((await sync(shift.access, phone)).status).toBe(200);
    const ok = await upload(shift.access, phone, 6);
    expect(ok.data).toEqual([{ ticketId: tickets[6].id, outcome: 'ACCEPTED' }]);

    // Lost with the role: approving a device (a manager's call).
    const reg = await http('POST', '/checkin/devices', shift.access, {
      organizationId: orgId,
      eventId,
      name: 'Walk Gate 3 spare',
    });
    expect(reg.status).toBe(201);
    expect(
      (await http('POST', `/checkin/devices/${reg.data.id}/approve`, shift.access)).status,
    ).toBe(403);
    // A role is never "nothing": the API refuses anything outside the three seat roles.
    const none = await http(
      'PATCH',
      `/organizations/${orgId}/members/${shift.memberId}`,
      ownerToken,
      {
        role: 'CUSTOMER',
      },
    );
    expect(none.status).toBe(400);
    expect((await deviceRow(phone)).status).toBe('ACTIVE');
  });
});
