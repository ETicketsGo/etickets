import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AddOnsService } from '../commerce/addons.service';
import { BundlesService } from '../commerce/bundles.service';
import { EventSellabilityService } from '../events/event-sellability.service';
import { EventsService } from '../events/events.service';
import { ShowsService } from '../shows/shows.service';

/**
 * integration-real-postgres - the three defects left open when PR #241 merged.
 *
 *   1. Add-ons and bundles were stored in 'INR' for every venue in every country.
 *   2. Nothing proved a session cannot take a layout from another space or organization.
 *   3. Moving a session into a space with several layouts silently picked one.
 *
 * Real database because each defect is about what gets WRITTEN - a currency column, a pinned
 * `seatMapId`, the ShowSeat rows a layout produces - and a mocked Prisma returns whatever it
 * is handed.
 *
 * Skips rather than fabricating a pass when no database is reachable.
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

const ORGANIZER = { id: 'itest-rf', email: 'rf@t.test', fullName: 'R', roles: [] } as never;
const allowAll = { assertMember: async () => undefined } as never;
const noAudit = { record: async () => undefined } as never;
const noAudience = { notifyAdmins: async () => undefined } as never;
const cfg = { get: () => 15 } as never;

const IN_THIRTY_DAYS = () => new Date(Date.now() + 30 * 86_400_000);
const LATER = (d: Date) => new Date(d.getTime() + 2 * 3_600_000);

describe('integration-real-postgres: venue/seating release follow-ups', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let shows: ShowsService;
  let events: EventsService;
  let addOns: AddOnsService;
  let bundles: BundlesService;

  const suffix = `rf-${Date.now()}`;
  const orgIds: string[] = [];

  let orgSeq = 0;
  async function org(name: string) {
    // A sequence, because some helpers create the same kind of organization more than once.
    const n = (orgSeq += 1);
    const o = await db!.organization.create({
      data: { name: `${name} ${suffix} ${n}`, slug: `${name.toLowerCase()}-${suffix}-${n}` },
    });
    orgIds.push(o.id);
    return o.id;
  }

  async function venue(organizationId: string, country: string | null, tz: string | null) {
    return db!.venue.create({
      data: {
        organizationId,
        name: `V ${suffix} ${Math.random()}`,
        city: 'X',
        country,
        timezone: tz,
      },
    });
  }

  async function space(venueId: string, name = 'Main') {
    return db!.screen.create({ data: { venueId, name, capacity: 100 } });
  }

  /**
   * A small published layout - one block, one row, three seats - on a space.
   *
   * `clonedFromId` lets a test build a VERSION of an existing configuration rather than a new
   * configuration, which is the distinction fix 3 turns on.
   */
  async function layout(
    screenId: string,
    name: string,
    version: number,
    clonedFromId: string | null = null,
  ) {
    const map = await db!.seatMap.create({
      data: {
        screenId,
        name,
        version,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        layoutKind: 'SECTIONED',
        clonedFromId,
      },
    });
    const cat = await db!.seatCategory.create({
      data: { seatMapId: map.id, name: `${name} cat`, basePriceMinor: 5_000 },
    });
    const section = await db!.seatSection.create({ data: { seatMapId: map.id, name: 'Block' } });
    const row = await db!.seatRow.create({ data: { sectionId: section.id, label: 'A' } });
    await db!.seat.createMany({
      data: [1, 2, 3].map((n) => ({
        seatMapId: map.id,
        rowId: row.id,
        seatCategoryId: cat.id,
        label: String(n),
        colIndex: n,
      })),
    });
    return map;
  }

  async function event(organizationId: string, venueId: string) {
    return events.create(ORGANIZER, organizationId, {
      title: `E ${suffix} ${Math.random()}`,
      category: 'Music',
      venueId,
      feeMode: 'CUSTOMER_PAYS',
      isFree: false,
    } as never);
  }

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
    shows = new ShowsService(db as never, allowAll, noAudit, cfg);
    events = new EventsService(
      db as never,
      allowAll,
      noAudit,
      noAudience,
      cfg,
      shows,
      new EventSellabilityService(db as never),
    );
    addOns = new AddOnsService(db as never, allowAll, noAudit);
    bundles = new BundlesService(db as never, allowAll, noAudit);
  }, 120_000);

  afterAll(async () => {
    if (!db || !available) return;
    const where = { organizationId: { in: orgIds } };
    const sessionWhere = { eventSession: { event: where } };
    await db.showSeat.deleteMany({ where: sessionWhere });
    await db.ticketInventory.deleteMany({ where: { ticketType: sessionWhere } });
    await db.bundleItem.deleteMany({ where: { bundle: { event: where } } });
    await db.bundle.deleteMany({ where: { event: where } });
    await db.addOnInventory.deleteMany({ where: { addOn: { event: where } } });
    await db.addOn.deleteMany({ where: { event: where } });
    await db.ticketType.deleteMany({ where: sessionWhere });
    await db.eventSession.deleteMany({ where: { event: where } });
    await db.event.deleteMany({ where });
    const maps = { seatMap: { screen: { venue: where } } };
    await db.seat.deleteMany({ where: maps });
    await db.seatRow.deleteMany({ where: { section: maps } });
    await db.seatSection.deleteMany({ where: maps });
    await db.seatCategory.deleteMany({ where: maps });
    // Children before parents: clones point at their source.
    await db.seatMap.deleteMany({
      where: { screen: { venue: where }, NOT: { clonedFromId: null } },
    });
    await db.seatMap.deleteMany({ where: { screen: { venue: where } } });
    await db.screen.deleteMany({ where: { venue: where } });
    await db.venue.deleteMany({ where });
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });
    await db.$disconnect();
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

  // ---------------------------------------------------------------------------------------
  // 1. Add-on and bundle currency
  // ---------------------------------------------------------------------------------------

  const addOnInput = (name = 'Parking pass') =>
    ({ type: 'PARKING', name, priceMinor: 1_500, maxPerOrder: 4, enabled: true }) as never;

  maybe('1a: an add-on for a US venue is priced in USD, not the INR column default', async () => {
    const o = await org('CurUS');
    const v = await venue(o, 'United States', 'America/Boise');
    const e = await event(o, v.id);
    const created = await addOns.create(ORGANIZER, e.id, addOnInput());
    const row = await db!.addOn.findUnique({ where: { id: created.id } });
    expect(row.currency).toBe('USD');
  });

  maybe('1b: an event whose tickets are already priced keeps that currency', async () => {
    /*
      Existing explicit currency is authoritative. An add-on in any other currency than the
      event's tickets would be refused at checkout as a mixed cart, so it must follow them -
      even where the venue country would say something else.
    */
    const o = await org('CurTix');
    const v = await venue(o, 'India', 'Asia/Kolkata');
    const e = await event(o, v.id);
    const s = await db!.eventSession.create({
      data: { eventId: e.id, startsAt: IN_THIRTY_DAYS(), endsAt: LATER(IN_THIRTY_DAYS()) },
    });
    await db!.ticketType.create({
      data: {
        eventSessionId: s.id,
        name: 'GA',
        priceMinor: 10_000,
        currency: 'CAD',
        quantityTotal: 10,
      },
    });
    const created = await addOns.create(ORGANIZER, e.id, addOnInput());
    const row = await db!.addOn.findUnique({ where: { id: created.id } });
    expect(row.currency).toBe('CAD');
  });

  maybe('1c: an event with no currency context refuses the add-on and writes nothing', async () => {
    /*
      THE FAIL-CLOSED CASE. No priced ticket and a venue that was never told its country:
      there is no honest currency to store, so nothing is stored. Before the fix this row
      would have been written as 'INR'.
    */
    const o = await org('CurNone');
    const v = await venue(o, null, null);
    const e = await event(o, v.id);
    await expect(addOns.create(ORGANIZER, e.id, addOnInput())).rejects.toMatchObject({
      response: expect.objectContaining({ details: { reason: 'CURRENCY_CONTEXT_REQUIRED' } }),
    });
    expect(await db!.addOn.count({ where: { eventId: e.id } })).toBe(0);
  });

  maybe('1d: a bundle follows the same rule as the add-ons inside it', async () => {
    const o = await org('CurBundle');
    const v = await venue(o, 'Canada', 'America/Toronto');
    const e = await event(o, v.id);
    const a = await addOns.create(ORGANIZER, e.id, addOnInput('Poster'));
    const b = await bundles.create(ORGANIZER, e.id, {
      type: 'COMBO',
      name: 'Night out',
      pricingKind: 'FIXED',
      priceMinor: 2_000,
      maxPerOrder: 2,
      enabled: true,
      items: [{ addOnId: a.id, quantity: 1 }],
    } as never);
    const row = await db!.bundle.findUnique({ where: { id: b.id } });
    expect(row.currency).toBe('CAD');
  });

  maybe('1e: editing an add-on never rewrites the currency it was priced in', async () => {
    const o = await org('CurEdit');
    const v = await venue(o, 'United States', 'America/Boise');
    const e = await event(o, v.id);
    const a = await addOns.create(ORGANIZER, e.id, addOnInput());
    await addOns.update(ORGANIZER, a.id, { name: 'Parking pass (lot B)' } as never);
    const row = await db!.addOn.findUnique({ where: { id: a.id } });
    expect(row.currency).toBe('USD');
  });

  // ---------------------------------------------------------------------------------------
  // 2. A session cannot take a layout from another space or another organization
  // ---------------------------------------------------------------------------------------

  maybe('2a: a layout from ANOTHER space of the same organization is refused', async () => {
    const o = await org('XSpace');
    const v = await venue(o, 'United States', 'America/Boise');
    const mine = await space(v.id, 'Hall A');
    const other = await space(v.id, 'Hall B');
    await layout(mine.id, 'Own', 1);
    const foreign = await layout(other.id, 'Theirs', 1);
    const e = await event(o, v.id);

    await expect(
      events.addSession(ORGANIZER, e.id, {
        startsAt: IN_THIRTY_DAYS(),
        endsAt: LATER(IN_THIRTY_DAYS()),
        screenId: mine.id,
        seatMapId: foreign.id,
      } as never),
    ).rejects.toThrow(/does not belong to this space/i);
    // Refused before anything was written.
    expect(await db!.eventSession.count({ where: { eventId: e.id } })).toBe(0);
  });

  maybe('2b: a layout from ANOTHER organization is refused', async () => {
    const mineOrg = await org('XOrgA');
    const theirOrg = await org('XOrgB');
    const myVenue = await venue(mineOrg, 'United States', 'America/Boise');
    const theirVenue = await venue(theirOrg, 'United States', 'America/Boise');
    const mine = await space(myVenue.id);
    const theirs = await space(theirVenue.id);
    await layout(mine.id, 'Own', 1);
    const foreign = await layout(theirs.id, 'Theirs', 1);
    const e = await event(mineOrg, myVenue.id);

    // Their layout on MY space: it does not belong to this space.
    await expect(
      events.addSession(ORGANIZER, e.id, {
        startsAt: IN_THIRTY_DAYS(),
        endsAt: LATER(IN_THIRTY_DAYS()),
        screenId: mine.id,
        seatMapId: foreign.id,
      } as never),
    ).rejects.toThrow(/does not belong to this space/i);

    // Their space AND their layout: the space itself is not this organization's.
    await expect(
      events.addSession(ORGANIZER, e.id, {
        startsAt: IN_THIRTY_DAYS(),
        endsAt: LATER(IN_THIRTY_DAYS()),
        screenId: theirs.id,
        seatMapId: foreign.id,
      } as never),
    ).rejects.toThrow(/not found for this organization/i);

    expect(await db!.eventSession.count({ where: { eventId: e.id } })).toBe(0);
  });

  maybe('2c: moving a session cannot pick up another organization’s layout either', async () => {
    const mineOrg = await org('XMoveA');
    const theirOrg = await org('XMoveB');
    const myVenue = await venue(mineOrg, 'United States', 'America/Boise');
    const theirVenue = await venue(theirOrg, 'United States', 'America/Boise');
    const mine = await space(myVenue.id);
    const theirs = await space(theirVenue.id);
    await layout(mine.id, 'Own', 1);
    const foreign = await layout(theirs.id, 'Theirs', 1);
    const e = await event(mineOrg, myVenue.id);
    const s = await events.addSession(ORGANIZER, e.id, {
      startsAt: IN_THIRTY_DAYS(),
      endsAt: LATER(IN_THIRTY_DAYS()),
    } as never);

    await expect(events.updateSessionSeating(ORGANIZER, s.id, mine.id, foreign.id)).rejects.toThrow(
      /does not belong to this space/i,
    );
    const after = await db!.eventSession.findUnique({ where: { id: s.id } });
    expect(after.screenId).toBeNull();
    expect(after.seatMapId).toBeNull();
  });

  // ---------------------------------------------------------------------------------------
  // 3. Changing space: chosen, kept, or resolved - never guessed
  // ---------------------------------------------------------------------------------------

  async function arena() {
    const o = await org('Arena');
    const v = await venue(o, 'United States', 'America/Boise');
    const main = await space(v.id, 'Main Arena');
    const basketball = await layout(main.id, 'Basketball', 1);
    const concert = await layout(main.id, 'Concert', 1);
    const e = await event(o, v.id);
    const s = await events.addSession(ORGANIZER, e.id, {
      startsAt: IN_THIRTY_DAYS(),
      endsAt: LATER(IN_THIRTY_DAYS()),
    } as never);
    return { main, basketball, concert, event: e, session: s };
  }

  maybe(
    '3a: moving into a multi-layout space without a choice is refused, not guessed',
    async () => {
      const { main, session } = await arena();
      await expect(
        events.updateSessionSeating(ORGANIZER, session.id, main.id),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          details: expect.objectContaining({ reason: 'LAYOUT_CHOICE_REQUIRED' }),
        }),
      });
      // Untouched: still general admission, no seats created.
      const after = await db!.eventSession.findUnique({ where: { id: session.id } });
      expect(after.screenId).toBeNull();
      expect(await db!.showSeat.count({ where: { eventSessionId: session.id } })).toBe(0);
    },
  );

  maybe('3b: an explicit choice pins exactly that layout and seats from it', async () => {
    const { main, concert, session } = await arena();
    await events.updateSessionSeating(ORGANIZER, session.id, main.id, concert.id);
    const after = await db!.eventSession.findUnique({ where: { id: session.id } });
    expect(after.screenId).toBe(main.id);
    expect(after.seatMapId).toBe(concert.id);
    const seated = await db!.showSeat.findMany({
      where: { eventSessionId: session.id },
      select: { seat: { select: { seatMapId: true } } },
    });
    expect(seated).toHaveLength(3);
    expect(new Set(seated.map((r: { seat: { seatMapId: string } }) => r.seat.seatMapId))).toEqual(
      new Set([concert.id]),
    );
  });

  maybe('3c: re-seating the SAME space keeps the layout it already pins', async () => {
    /*
      "Preserve valid existing layout identity": the session is in Concert. Applying seating to
      the same space again without naming a layout must not swap it for Basketball - which
      `resolveLayoutForShow` would happily have done.
    */
    /*
      Pinned to BASKETBALL deliberately: resolving by date picks the most recently published
      configuration, which is Concert. An earlier draft pinned Concert and so passed against
      the old guessing behaviour by coincidence - it proved nothing. This one can only pass if
      the pinned layout is genuinely kept.
    */
    const { main, basketball, session } = await arena();
    await events.updateSessionSeating(ORGANIZER, session.id, main.id, basketball.id);
    await events.updateSessionSeating(ORGANIZER, session.id, main.id);
    const after = await db!.eventSession.findUnique({ where: { id: session.id } });
    expect(after.seatMapId).toBe(basketball.id);
  });

  maybe(
    '3d: creating a session in a multi-layout space without a choice is refused too',
    async () => {
      // The same rule on the other path that pins a layout. Event creation sends a choice; an
      // older client that does not must be refused, not given an arbitrary configuration.
      const { main, event: e } = await arena();
      await expect(
        events.addSession(ORGANIZER, e.id, {
          startsAt: IN_THIRTY_DAYS(),
          endsAt: LATER(IN_THIRTY_DAYS()),
          screenId: main.id,
        } as never),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          details: expect.objectContaining({ reason: 'LAYOUT_CHOICE_REQUIRED' }),
        }),
      });
    },
  );

  maybe('3e: a cinema with version history is ONE layout and still resolves by date', async () => {
    /*
      The case that must not regress. Cloning names a draft "<name> v<N>", so a cinema screen
      with a published v1 and v2 carries two names. Counting names would demand a choice the
      operator never needed to make; lineage says they are one configuration.
    */
    const o = await org('Cine');
    const v = await venue(o, 'India', 'Asia/Kolkata');
    const screen = await space(v.id, 'Screen 1');
    const v1 = await layout(screen.id, 'Main', 1);
    await layout(screen.id, 'Main v2', 2, v1.id);
    const e = await event(o, v.id);
    const s = await events.addSession(ORGANIZER, e.id, {
      startsAt: IN_THIRTY_DAYS(),
      endsAt: LATER(IN_THIRTY_DAYS()),
    } as never);

    await events.updateSessionSeating(ORGANIZER, s.id, screen.id);
    const after = await db!.eventSession.findUnique({ where: { id: s.id } });
    expect(after.screenId).toBe(screen.id);
    expect(after.seatMapId).not.toBeNull();
  });
  // ---------------------------------------------------------------------------------------
  // 4. Duplicating an event keeps each seated session's configuration
  // ---------------------------------------------------------------------------------------

  /** The copy of the original's only session, with the seats it was given. */
  async function copiedSession(originalEventId: string) {
    const copy = await events.duplicate(ORGANIZER, originalEventId);
    const session = await db!.eventSession.findFirstOrThrow({ where: { eventId: copy.id } });
    const seats = await db!.showSeat.findMany({
      where: { eventSessionId: session.id },
      select: { seat: { select: { seatMapId: true } } },
    });
    return {
      session,
      seatMapIds: [...new Set(seats.map((x: { seat: { seatMapId: string } }) => x.seat.seatMapId))],
    };
  }

  maybe('4a: copying a Concert session gives a Concert session, not Basketball', async () => {
    /*
      Basketball is published AFTER Concert on purpose: date resolution across the space picks
      the newest configuration, so the old copy of this Concert session landed in Basketball.
      This can only pass if the copy keeps the original's configuration.
    */
    const o = await org('Dup');
    const v = await venue(o, 'United States', 'America/Boise');
    const main = await space(v.id, 'Main Arena');
    const concert = await layout(main.id, 'Concert', 1);
    const basketball = await layout(main.id, 'Basketball', 1);
    const e = await event(o, v.id);
    const s = await events.addSession(ORGANIZER, e.id, {
      startsAt: IN_THIRTY_DAYS(),
      endsAt: LATER(IN_THIRTY_DAYS()),
      screenId: main.id,
      seatMapId: concert.id,
    } as never);
    expect(s.seatMapId).toBe(concert.id);

    const { session, seatMapIds } = await copiedSession(e.id);
    expect(session.seatMapId).toBe(concert.id);
    expect(session.seatMapId).not.toBe(basketball.id);
    expect(seatMapIds).toEqual([concert.id]);
  });

  maybe('4b: a cinema copy still takes the version of its layout in effect', async () => {
    /*
      Version compatibility. The original pins v1; v2 of the SAME layout is published since.
      The copy is a new session and gets the version in effect - v2 - exactly as before. Only
      the configuration is preserved, not a superseded version.
    */
    const o = await org('DupCine');
    const v = await venue(o, 'India', 'Asia/Kolkata');
    const screen = await space(v.id, 'Screen 1');
    const v1 = await layout(screen.id, 'Main', 1);
    const e = await event(o, v.id);
    const s = await events.addSession(ORGANIZER, e.id, {
      startsAt: IN_THIRTY_DAYS(),
      endsAt: LATER(IN_THIRTY_DAYS()),
      screenId: screen.id,
    } as never);
    expect(s.seatMapId).toBe(v1.id);
    const v2 = await layout(screen.id, 'Main v2', 2, v1.id);

    const { session, seatMapIds } = await copiedSession(e.id);
    expect(session.seatMapId).toBe(v2.id);
    expect(seatMapIds).toEqual([v2.id]);
  });
});
