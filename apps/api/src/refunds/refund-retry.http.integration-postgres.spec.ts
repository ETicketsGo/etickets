import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../app.module';
import { AllExceptionsFilter } from '../common/all-exceptions.filter';
import { MockPaymentProvider } from '../payments/provider/mock-payment.provider';

/**
 * integration-real-postgres - refund retries over HTTP, against the whole app.
 *
 * The admin console's own routes, the real refund, orchestrator and mock-provider code, and a
 * real database. The mock provider is the one QA runs; its `#refundlost` and `#refundunknown`
 * scenarios lose the answer to a refund call the way a timeout does. NO real payment provider is
 * called by this spec.
 *
 *   1. A FAILED refund that the provider refused is tried again from the admin route and paid,
 *      under this refund's own key, and a second try is refused.
 *   2. An approval whose answer is lost is settled by asking the provider: one create call.
 *   3. An approval whose answer is lost and cannot be looked up is held for a person: the
 *      retry-check says so, and the retry route refuses to send it without the dashboard check.
 *
 * Every row is created under a unique suffix and removed afterwards. Skips (never fabricates a
 * pass) when no database is reachable.
 */
function loadDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const p of ['../../../.env', '../../../../.env']) {
    try {
      const m = readFileSync(resolve(__dirname, p), 'utf8').match(/^DATABASE_URL=(.*)$/m);
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

const PASSWORD = 'Copper-Kestrel-7315!';

describe('integration-real-postgres: refund retry over HTTP', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let app: INestApplication | undefined;
  let base = '';
  let available = false;
  let token = '';
  let mockRefund: jest.SpyInstance | undefined;

  const suffix = `rretry-http-${Date.now()}`;
  const ids = { org: '', venue: '', event: '', session: '', ticketType: '', admin: '' };
  const bookings: string[] = [];

  async function http(method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json: json?.data ?? json };
  }

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

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    mockRefund = jest.spyOn(app.get(MockPaymentProvider), 'refund');

    const admin = await db!.user.create({
      data: {
        email: `admin-${suffix}@test.invalid`,
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        fullName: 'Refund Admin',
        roles: ['SUPER_ADMIN'],
      },
    });
    ids.admin = admin.id;
    const org = await db!.organization.create({
      data: { name: `Refunds ${suffix}`, slug: `refunds-${suffix}`, status: 'APPROVED' },
    });
    ids.org = org.id;
    const venue = await db!.venue.create({
      data: { organizationId: org.id, name: `Hall ${suffix}`, city: 'Bengaluru', country: 'India' },
    });
    ids.venue = venue.id;
    const event = await db!.event.create({
      data: {
        organizationId: org.id,
        venueId: venue.id,
        title: `Show ${suffix}`,
        slug: `show-${suffix}`,
        category: 'MUSIC',
      },
    });
    ids.event = event.id;
    const session = await db!.eventSession.create({
      data: { eventId: event.id, startsAt: new Date('2099-01-01'), endsAt: new Date('2099-01-02') },
    });
    ids.session = session.id;
    const tt = await db!.ticketType.create({
      data: { eventSessionId: session.id, name: 'General', priceMinor: 5000, quantityTotal: 100 },
    });
    ids.ticketType = tt.id;

    const login = await http('POST', '/auth/login', {
      email: `admin-${suffix}@test.invalid`,
      password: PASSWORD,
    });
    expect(login.status).toBeLessThan(300);
    token = login.json.accessToken;
  }, 180_000);

  afterAll(async () => {
    if (db && available) {
      const where = { bookingId: { in: bookings } };
      const refundIds = (await db.refund.findMany({ where, select: { id: true } })).map(
        (r: { id: string }) => r.id,
      );
      await db.notification
        .deleteMany({ where: { booking: { id: { in: bookings } } } })
        .catch(() => undefined);
      await db.receipt.deleteMany({ where }).catch(() => undefined);
      await db.auditLog
        .deleteMany({
          where: {
            OR: [
              { entityId: { in: refundIds } },
              { organizationId: ids.org },
              { actorUserId: ids.admin },
            ],
          },
        })
        .catch(() => undefined);
      await db.refund.deleteMany({ where }).catch(() => undefined);
      await db.ticket.deleteMany({ where }).catch(() => undefined);
      await db.payment.deleteMany({ where }).catch(() => undefined);
      await db.booking.deleteMany({ where: { id: { in: bookings } } }).catch(() => undefined);
      await db.ticketType.deleteMany({ where: { id: ids.ticketType } }).catch(() => undefined);
      await db.eventSession.deleteMany({ where: { id: ids.session } }).catch(() => undefined);
      await db.event.deleteMany({ where: { id: ids.event } }).catch(() => undefined);
      await db.venue.deleteMany({ where: { id: ids.venue } }).catch(() => undefined);
      await db.organization.deleteMany({ where: { id: ids.org } }).catch(() => undefined);
      await db.refreshToken?.deleteMany({ where: { userId: ids.admin } }).catch(() => undefined);
      await db.user.deleteMany({ where: { id: ids.admin } }).catch(() => undefined);
      await db.$disconnect();
    }
    if (app) await app.close();
  }, 120_000);

  const maybe = (name: string, fn: () => Promise<void>) =>
    it(
      name,
      async () => {
        if (!available) return;
        mockRefund?.mockClear();
        await fn();
      },
      60_000,
    );

  /** A paid mock-provider booking with one ticket and a refund in `status`. */
  async function booking(n: number, paymentRef: string, status: 'REQUESTED' | 'FAILED') {
    const b = await db!.booking.create({
      data: {
        organizationId: ids.org,
        eventId: ids.event,
        eventSessionId: ids.session,
        buyerName: 'Buyer',
        buyerEmail: `buyer-${n}-${suffix}@test.invalid`,
        status: 'CONFIRMED',
        currency: 'INR',
        subtotalMinor: 5000,
        totalMinor: 5000,
        holdExpiresAt: new Date('2099-01-01'),
      },
    });
    bookings.push(b.id);
    await db!.payment.create({
      data: {
        bookingId: b.id,
        provider: 'mock',
        status: 'SUCCEEDED',
        amountMinor: 5000,
        currency: 'INR',
        providerRef: paymentRef,
      },
    });
    const ticket = await db!.ticket.create({
      data: {
        bookingId: b.id,
        ticketTypeId: ids.ticketType,
        eventSessionId: ids.session,
        organizationId: ids.org,
        serial: `${suffix}-${n}`,
        nonce: 'n',
      },
    });
    const refund = await db!.refund.create({
      data: {
        bookingId: b.id,
        organizationId: ids.org,
        amountMinor: 5000,
        reason: 'HTTP retry test',
        ticketIds: [ticket.id],
        status,
      },
    });
    return { bookingId: b.id, ticketId: ticket.id, refundId: refund.id };
  }

  maybe('a refused refund is tried again from the admin route and paid, once', async () => {
    const f = await booking(1, `pay_${suffix}_1`, 'FAILED');
    // What a definite refusal leaves on the refund's history.
    await db!.auditLog.create({
      data: {
        organizationId: ids.org,
        action: 'REFUND_FAILED',
        entityType: 'Refund',
        entityId: f.refundId,
        metadata: { providerRef: 'mock_refused' },
      },
    });

    const check = await http('GET', `/admin/refunds/${f.refundId}/retry-check`);
    expect(check.status).toBe(200);
    expect(check.json).toMatchObject({ allowed: true, action: 'SEND', lastAnswer: 'REFUSED' });

    const r = await http('POST', `/admin/refunds/${f.refundId}/retry`, {});
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ outcome: 'COMPLETED', recorded: false });
    expect(mockRefund).toHaveBeenCalledTimes(1);
    expect(mockRefund!.mock.calls[0][0]).toMatchObject({ idempotencyKey: `etg-rf-${f.refundId}` });

    const row = await db!.refund.findUnique({ where: { id: f.refundId } });
    expect(row).toMatchObject({ status: 'COMPLETED', providerCallCount: 1 });
    expect((await db!.ticket.findUnique({ where: { id: f.ticketId } })).status).toBe('REFUNDED');
    const attempts = await db!.refundProviderAttempt.findMany({ where: { refundId: f.refundId } });
    expect(attempts).toEqual([
      expect.objectContaining({ attemptNo: 1, trigger: 'ADMIN_RETRY', outcome: 'ACCEPTED' }),
    ]);

    // A second click: refused, and nothing reaches the provider.
    const again = await http('POST', `/admin/refunds/${f.refundId}/retry`, {});
    expect(again.status).toBe(409);
    expect(mockRefund).toHaveBeenCalledTimes(1);
  });

  maybe('an approval whose answer is lost is settled by asking the provider', async () => {
    const f = await booking(2, `pay_${suffix}_2#refundlost`, 'REQUESTED');
    const r = await http('POST', `/refunds/${f.refundId}/process`, { decision: 'APPROVE' });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ status: 'COMPLETED' });
    expect(mockRefund).toHaveBeenCalledTimes(1);
    expect((await db!.ticket.findUnique({ where: { id: f.ticketId } })).status).toBe('REFUNDED');
  });

  maybe('an answer that is lost and cannot be looked up is held for a person', async () => {
    const f = await booking(3, `pay_${suffix}_3#refundunknown`, 'REQUESTED');
    const r = await http('POST', `/refunds/${f.refundId}/process`, { decision: 'APPROVE' });
    expect(r.status).toBe(502);
    expect(mockRefund).toHaveBeenCalledTimes(1);

    const row = await db!.refund.findUnique({ where: { id: f.refundId } });
    expect(row.status).toBe('FAILED');
    expect(row.manualReviewReason).toMatch(/could not be asked/);

    const check = await http('GET', `/admin/refunds/${f.refundId}/retry-check`);
    expect(check.json).toMatchObject({
      allowed: false,
      needsConfirmation: true,
      manualReviewReason: expect.stringMatching(/could not be asked/),
      providerLookup: { kind: 'UNAVAILABLE' },
    });
    const refused = await http('POST', `/admin/refunds/${f.refundId}/retry`, {});
    expect(refused.status).toBe(409);
    expect(mockRefund).toHaveBeenCalledTimes(1);

    // The detail route carries the reason, which is what the console shows.
    const detail = await http('GET', `/admin/refunds/${f.refundId}`);
    expect(detail.json.manualReviewReason).toMatch(/could not be asked/);
  });
});
