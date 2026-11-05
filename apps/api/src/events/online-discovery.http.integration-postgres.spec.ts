import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

/**
 * integration-real-postgres, over HTTP: online events in city discovery (PROD, 2026-11-05).
 *
 * An online US event was missing for a buyer who chose Meridian: its venue city is "Online",
 * which never equals "Meridian". Online events are now listed in every city of their own
 * country and never in another country's cities; in-person events still need their city.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PrismaClient } = require('@prisma/client');
type Client = InstanceType<typeof PrismaClient>;

describe('integration-real-postgres: online events in city discovery', () => {
  const url = process.env.DATABASE_URL;
  let db: Client | undefined;
  let app: INestApplication | undefined;
  let base = '';
  let available = false;
  const savedEnv = { ...process.env };
  const suffix = `onl-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const orgIds: string[] = [];
  const titles: Record<string, string> = {};

  const list = async (q: string) => {
    const res = await fetch(`${base}/api/public/events?${q}&pageSize=100`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await res.json();
    const data = (json?.data ?? json).data ?? json.data ?? [];
    return (data as { title: string; attendanceMode?: string }[]).filter((e) =>
      e.title.includes(suffix),
    );
  };

  async function event(
    label: string,
    venue: { city: string; country: string; tz: string },
    mode: string,
  ) {
    const v = await db!.venue.create({
      data: {
        organizationId: orgIds[0],
        name: venue.city === 'Online' ? 'Online' : `${label} Hall`,
        city: venue.city,
        country: venue.country,
        timezone: venue.tz,
      },
    });
    const title = `QA-TEST ${label} ${suffix}`;
    const e = await db!.event.create({
      data: {
        organizationId: orgIds[0],
        venueId: v.id,
        title,
        slug: `${label.toLowerCase()}-${suffix}`,
        category: 'Community',
        status: 'PUBLISHED',
        publishedAt: new Date(),
        isFree: true,
        attendanceMode: mode,
      },
    });
    const start = Date.now() + 5 * 86_400_000;
    const s = await db!.eventSession.create({
      data: { eventId: e.id, startsAt: new Date(start), endsAt: new Date(start + 3_600_000) },
    });
    await db!.ticketType.create({
      data: {
        eventSessionId: s.id,
        name: 'General',
        priceMinor: 0,
        currency: venue.country === 'India' ? 'INR' : 'USD',
        quantityTotal: 10,
      },
    });
    titles[label] = title;
  }

  beforeAll(async () => {
    if (!url) return;
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db!.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      return;
    }
    process.env.APP_ENV = 'LOCAL';
    process.env.ORGANIZER_WEB_URL = 'https://organizer.example.test';
    process.env.ADMIN_WEB_URL = 'https://admin.example.test';
    process.env.THROTTLE_LIMIT = '100000';
    process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-for-online-spec-0123456789abcdef';
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-for-online-spec-0123456789';
    process.env.QR_SIGNING_SECRET ??= 'test-qr-secret-for-online-spec-0123456789';
    process.env.PAYMENT_WEBHOOK_SECRET ??= 'test-webhook-secret-for-online-spec-0123456789';
    const { AppModule } = await import('../app.module');
    const { AllExceptionsFilter } = await import('../common/all-exceptions.filter');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    const org = await db!.organization.create({
      data: { name: `QA-TEST Online ${suffix}`, slug: `online-${suffix}`, status: 'APPROVED' },
    });
    orgIds.push(org.id);
    await event(
      'UsOnline',
      { city: 'Online', country: 'United States', tz: 'America/Boise' },
      'ONLINE',
    );
    await event(
      'UsHybrid',
      { city: 'Boise', country: 'United States', tz: 'America/Boise' },
      'HYBRID',
    );
    await event(
      'BoiseInPerson',
      { city: 'Boise', country: 'United States', tz: 'America/Boise' },
      'IN_PERSON',
    );
    await event('InOnline', { city: 'Online', country: 'India', tz: 'Asia/Kolkata' }, 'ONLINE');
  }, 180_000);

  afterAll(async () => {
    if (db && available) {
      const where = { event: { organizationId: { in: orgIds } } };
      await db.ticketType.deleteMany({ where: { eventSession: where } });
      await db.eventSession.deleteMany({ where });
      await db.event.deleteMany({ where: { organizationId: { in: orgIds } } });
      await db.venue.deleteMany({ where: { organizationId: { in: orgIds } } });
      await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      await db.$disconnect();
    }
    if (app) await app.close();
    process.env = savedEnv;
  });

  const names = (rows: { title: string }[]) => rows.map((r) => r.title).sort();

  it('Meridian, US: the US online and hybrid events, not the Boise in-person one, not India', async () => {
    if (!available) return;
    const rows = await list('city=Meridian&cityCountry=US');
    expect(names(rows)).toEqual([titles.UsHybrid, titles.UsOnline].sort());
    expect(rows.find((r) => r.title === titles.UsOnline)?.attendanceMode).toBe('ONLINE');
  });

  it('Boise, US: its in-person event as well as the online ones', async () => {
    if (!available) return;
    const rows = await list('city=Boise&cityCountry=US');
    expect(names(rows)).toEqual([titles.BoiseInPerson, titles.UsHybrid, titles.UsOnline].sort());
  });

  it('Hyderabad, India: only the India online event; no US event leaks in', async () => {
    if (!available) return;
    const rows = await list('city=Hyderabad&cityCountry=IN');
    expect(names(rows)).toEqual([titles.InOnline]);
  });

  it('All cities in the US: every US event, nothing from India', async () => {
    if (!available) return;
    const rows = await list('country=US');
    expect(names(rows)).toEqual([titles.BoiseInPerson, titles.UsHybrid, titles.UsOnline].sort());
  });
});
