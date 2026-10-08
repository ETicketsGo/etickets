import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { currencyForCountry } from '@eticketsgo/shared-types';
import { createVenueSchema } from '@eticketsgo/validation';
import { spaceTimezone } from './space-owner';
import { VenuesService } from '../venues/venues.service';
import { CinemasService } from '../cinemas/cinemas.service';

/**
 * integration-real-postgres - four countries, four answers, and no hidden India.
 *
 * -- WHY THIS GATE EXISTS -----------------------------------------------------------------
 * `Venue.country` defaulted to 'India' and `Venue.timezone` to 'Asia/Kolkata', in the column
 * AND in the create schema. A venue nobody had asked still answered, so every bug in this
 * family looked identical to correct behaviour from inside India - which is why both of the
 * ones this platform has had were found by a non-India fixture and nothing else:
 *
 *   a Chicago show filed under an Indian venue,
 *   a Sydney cinema's 00:30 show stored and reported as 06:00.
 *
 * The defaults are gone. This asserts, against a real database, that what an organizer
 * supplies is what comes back - for the United States, India, Canada and Australia - and that
 * a venue which supplies nothing says NOTHING rather than claiming the launch market.
 *
 * Sydney is here permanently. It is the fixture that caught the regression, and it is the
 * only one of these four where the wrong answer is a plausible-looking time rather than an
 * obviously foreign one.
 */
function loadDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const p of ['../../../.env', '../../../../.env']) {
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

const ORGANIZER = { id: 'itest-mc', email: 'mc@t.test', fullName: 'M', roles: [] } as never;
const allowAll = { assertMember: async () => undefined } as never;

/** One row per market we claim to serve, plus the one that caught the bug. */
const MARKETS = [
  {
    key: 'US',
    city: 'Boise',
    country: 'United States',
    region: 'Idaho',
    timezone: 'America/Boise',
    currency: 'USD',
  },
  {
    key: 'IN',
    city: 'Hyderabad',
    country: 'India',
    region: 'Telangana',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
  },
  {
    key: 'CA',
    city: 'Montreal',
    country: 'Canada',
    region: 'Ontario',
    timezone: 'America/Toronto',
    currency: 'CAD',
  },
  {
    key: 'AU',
    city: 'Sydney',
    country: 'Australia',
    region: 'New South Wales',
    timezone: 'Australia/Sydney',
    currency: 'AUD',
  },
];

describe('integration-real-postgres: a venue is where the organizer said it is', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let venues: VenuesService;
  let cinemas: CinemasService;

  const suffix = `mc-${Date.now()}`;
  let orgId = '';
  const made: Record<string, { cinemaId: string; venueId: string; spaceId: string }> = {};

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db!.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - DB unavailable');
      return;
    }
    venues = new VenuesService(db as never, allowAll);
    cinemas = new CinemasService(db as never, allowAll);

    const org = await db!.organization.create({
      data: { name: `MC ${suffix}`, slug: `mc-${suffix}` },
    });
    orgId = org.id;

    for (const m of MARKETS) {
      /* The canonical cinema path creates the authoritative Venue; bypassing it hid the bug. */
      const cinema = await cinemas.create(ORGANIZER, orgId, {
        name: `${m.key} Cinema ${suffix}`,
        city: m.city,
        country: m.country,
        region: m.region,
        timezone: m.timezone,
      } as never);
      const space = await cinemas.addScreen(ORGANIZER, cinema.id, {
        name: 'Main',
        screenType: '2D',
        capacity: 100,
      } as never);
      made[m.key] = { cinemaId: cinema.id, venueId: cinema.venueId!, spaceId: space.id };
    }
  }, 180_000);

  afterAll(async () => {
    if (!db || !available) return;
    await db.screen.deleteMany({ where: { venue: { organizationId: orgId } } });
    await db.cinema.deleteMany({ where: { organizationId: orgId } });
    await db.venue.deleteMany({ where: { organizationId: orgId } });
    await db.organization.deleteMany({ where: { id: orgId } });
    await db.$disconnect();
  }, 120_000);

  const maybe = (name: string, fn: () => Promise<void>, timeout?: number) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  for (const m of MARKETS) {
    maybe(
      `${m.key}: cinema creation stores ${m.country} / ${m.timezone} on its Venue`,
      async () => {
        const row = await db!.venue.findUnique({ where: { id: made[m.key].venueId } });
        expect(row.country).toBe(m.country);
        expect(row.region).toBe(m.region);
        expect(row.timezone).toBe(m.timezone);
      },
    );

    maybe(`${m.key}: a space in it reckons time in ${m.timezone}`, async () => {
      /*
        Through `spaceTimezone`, which is what every showtime, ticket face and reminder uses.
        A space with no cinema has only its venue to ask, so this is the venue's answer
        arriving intact at the place it is actually consumed.
      */
      const space = await db!.screen.findUnique({
        where: { id: made[m.key].spaceId },
        select: {
          venue: { select: { timezone: true } },
          cinema: { select: { timezone: true } },
        },
      });
      expect(spaceTimezone(space)).toBe(m.timezone);
    });

    maybe(`${m.key}: prices in ${m.currency}`, async () => {
      // Currency follows the VENUE's country on this platform, never the visitor's.
      const row = await db!.venue.findUnique({ where: { id: made[m.key].venueId } });
      expect(currencyForCountry(row.country)).toBe(m.currency);
    });
  }

  maybe('a venue that was not asked says NOTHING, rather than claiming India', async () => {
    /*
      The assertion the whole change is for. Before it, this venue would have come back as
      India / Asia/Kolkata and been indistinguishable from one in Hyderabad.

      THROUGH `createVenueSchema`, deliberately. There were TWO India defaults - the column
      and the validation schema - and an earlier version of this test called the service
      directly with a plain object, so it proved only that the COLUMN default was gone.
      Restoring the schema default left it green. Parsing here is what makes it a guard over
      both, which is what the request actually goes through.
    */
    const parsed = createVenueSchema.parse({ name: `Unasked ${suffix}`, city: 'Somewhere' });
    // jest's `expect` takes no message argument; the describe text carries the meaning.
    expect(parsed.country).toBeUndefined();

    const v = await venues.create(ORGANIZER, orgId, parsed as never);
    const row = await db!.venue.findUnique({ where: { id: v.id } });

    expect(row.country).toBeNull();
    expect(row.timezone).toBeNull();
    // And nothing downstream invents one.
    expect(currencyForCountry(row.country)).toBeNull();
    expect(spaceTimezone({ venue: row, cinema: null })).toBeNull();
  });

  maybe('Sydney: the regression case, kept permanently', async () => {
    /*
      A cinema in Sydney whose venue was never given a zone. This is the exact shape that
      stored a 00:30 show as 06:00: the venue claimed Asia/Kolkata by default and shadowed the
      zone the operator had actually chosen.

      Now the venue answers null and the cinema's real zone comes through.
    */
    const venue = await venues.create(ORGANIZER, orgId, {
      name: `Sydney Unasked ${suffix}`,
      city: 'Sydney',
    } as never);
    const cinema = await db!.cinema.create({
      data: {
        organizationId: orgId,
        venueId: venue.id,
        name: `Sydney Cinema ${suffix}`,
        city: 'Sydney',
        timezone: 'Australia/Sydney',
      },
    });
    const screen = await db!.screen.create({
      data: { venueId: venue.id, cinemaId: cinema.id, name: 'S1', capacity: 50 },
    });

    try {
      const space = await db!.screen.findUnique({
        where: { id: screen.id },
        select: {
          venue: { select: { timezone: true } },
          cinema: { select: { timezone: true } },
        },
      });
      expect(spaceTimezone(space)).toBe('Australia/Sydney');
      // Said explicitly: the launch market must not appear anywhere in this answer.
      expect(spaceTimezone(space)).not.toBe('Asia/Kolkata');
    } finally {
      await db!.screen.delete({ where: { id: screen.id } }).catch(() => undefined);
      await db!.cinema.delete({ where: { id: cinema.id } }).catch(() => undefined);
    }
  });
});
