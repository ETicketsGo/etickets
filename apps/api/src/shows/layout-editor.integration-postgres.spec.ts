import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { countLayoutDocument, type LayoutDocument } from '@eticketsgo/shared-types';
import { saveLayoutDocumentSchema } from '@eticketsgo/validation';
import { SeatLayoutsService } from './seat-layouts.service';
import { ShowsService } from './shows.service';

/**
 * integration-real-postgres - E1: the seat layout editor writes the room the organizer shaped.
 *
 * The owner built a 100-seat arena and got 110 seats, a $84.98 price he never typed, and no way
 * to change either. Each promise the editor makes is checked against the rows the database
 * really holds:
 *
 *   - a template asked for exactly 100 seats writes exactly 100;
 *   - prices a template worked out are marked suggested, and publishing accepts them;
 *   - a draft read into the editor, changed and saved, reads back as exactly what was saved -
 *     for a room of rows AND for a venue map, whose block outlines must survive;
 *   - a published layout cannot be saved over, and a clone of it keeps everything;
 *   - a house seat drawn in the layout starts every session BLOCKED, a restricted-view seat is
 *     sold, and a removed seat (a gap) is never inventory.
 *
 * Fixtures are created under a unique suffix and removed afterwards: the database is shared.
 * Skips (never fabricates a pass) when no database is reachable.
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

const ORGANIZER = { id: 'itest-editor', email: 'e@t.test', fullName: 'E', roles: [] } as never;
const allowAll = { assertMember: async () => undefined } as never;
const cfg = { get: () => 15 } as never;

/** What a saved document should read back as: keys are the server's new ids, so compare by name. */
function comparable(doc: LayoutDocument) {
  const nameOf = new Map(doc.categories.map((c) => [c.key, c.name]));
  return {
    name: doc.name,
    categories: doc.categories.map((c) => ({
      name: c.name,
      colorHex: c.colorHex,
      priceMinor: c.priceMinor,
      priceSuggested: c.priceSuggested,
    })),
    sections: doc.sections.map((s) => ({
      name: s.name,
      category: nameOf.get(s.categoryKey),
      shape: s.shape,
      rotationDeg: s.rotationDeg,
      rows: s.rows.map((r) => ({
        label: r.label,
        kinds: r.kinds,
        labels: r.labels,
        category: r.categoryKey ? nameOf.get(r.categoryKey) : undefined,
      })),
    })),
  };
}

describe('integration-real-postgres: the seat layout editor', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let layouts: SeatLayoutsService;
  let shows: ShowsService;

  const suffix = `editor-${Date.now()}`;
  let orgId = '';
  let cinemaId = '';
  let movieId = '';

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - DB unavailable');
      return;
    }
    const audit = { record: async () => undefined } as never;
    layouts = new SeatLayoutsService(db as never, allowAll, audit);
    shows = new ShowsService(db as never, allowAll, audit, cfg);

    const org = await db.organization.create({
      data: { name: `Editor ${suffix}`, slug: `editor-${suffix}`, status: 'APPROVED' },
    });
    orgId = org.id;
    const venue = await db.venue.create({
      data: { organizationId: orgId, name: `V ${suffix}`, city: 'Bengaluru', country: 'India' },
    });
    const cinema = await db.cinema.create({
      data: { organizationId: orgId, venueId: venue.id, name: `C ${suffix}`, city: 'Bengaluru' },
    });
    cinemaId = cinema.id;
    const movie = await db.movie.create({
      data: {
        organizationId: orgId,
        title: `Editor Film ${suffix}`,
        slug: `editor-film-${suffix}`,
        status: 'PUBLISHED',
        runtimeMinutes: 100,
        language: 'English',
      },
    });
    movieId = movie.id;
  }, 120_000);

  afterAll(async () => {
    if (!db || !available) return;
    const screens = await db.screen.findMany({ where: { cinemaId }, select: { id: true } });
    const ids = screens.map((s: { id: string }) => s.id);
    await db.showSeat.deleteMany({ where: { eventSession: { screenId: { in: ids } } } });
    await db.ticketType.deleteMany({ where: { eventSession: { screenId: { in: ids } } } });
    await db.eventSession.deleteMany({ where: { screenId: { in: ids } } });
    await db.event.deleteMany({ where: { organizationId: orgId } });
    await db.movie.deleteMany({ where: { organizationId: orgId } });
    await db.seat.deleteMany({ where: { seatMap: { screenId: { in: ids } } } });
    await db.seatZone.deleteMany({ where: { seatMap: { screenId: { in: ids } } } });
    await db.seatRow.deleteMany({ where: { section: { seatMap: { screenId: { in: ids } } } } });
    await db.seatSection.deleteMany({ where: { seatMap: { screenId: { in: ids } } } });
    await db.seatCategory.deleteMany({ where: { seatMap: { screenId: { in: ids } } } });
    await db.seatMap.updateMany({
      where: { screenId: { in: ids } },
      data: { clonedFromId: null },
    });
    await db.seatMap.deleteMany({ where: { screenId: { in: ids } } });
    await db.screen.deleteMany({ where: { cinemaId } });
    await db.cinema.deleteMany({ where: { organizationId: orgId } });
    await db.venue.deleteMany({ where: { organizationId: orgId } });
    await db.organization.deleteMany({ where: { id: orgId } });
    await db.$disconnect();
  }, 120_000);

  const maybe = (name: string, fn: () => Promise<void>, timeout = 120_000) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  const newSpace = (name: string, capacity = 100) =>
    db!.screen.create({
      data: { cinemaId, name: `${name} ${suffix}`, screenType: '2D', capacity },
    });

  /** Save through the same schema the controller applies, so the test sends what the API takes. */
  const save = async (layoutId: string, doc: LayoutDocument) =>
    layouts.saveDocument(ORGANIZER, layoutId, saveLayoutDocumentSchema.parse(doc));

  maybe('exactly 100 seats from the amphitheatre, with the worked-out price marked', async () => {
    const space = await newSpace('Arena');
    const created = await layouts.createFromTemplate(ORGANIZER, space.id, {
      template: 'AMPHITHEATRE',
      targetSeats: 100,
      fit: 'EXACT',
      basePriceMinor: 4999,
    });
    expect(created.seats).toBe(100);
    const sellable = await db!.seat.count({
      where: { seatMapId: created.id, kind: { not: 'GAP' } },
    });
    expect(sellable).toBe(100);

    const read = await layouts.document(ORGANIZER, created.id);
    expect(read.editable).toBe(true);
    expect(read.layoutKind).toBe('SECTIONED');
    const byName = new Map(read.document.categories.map((c) => [c.name, c]));
    // The price typed is the organizer's; the one derived from it is only a suggestion.
    expect(byName.get('Rear')).toMatchObject({ priceMinor: 4999, priceSuggested: false });
    expect(byName.get('Front')).toMatchObject({ priceMinor: 8498, priceSuggested: true });
    const versions = await layouts.listVersions(ORGANIZER, space.id);
    expect(versions[0].suggestedPrices).toEqual([{ name: 'Front', priceMinor: 8498 }]);

    // J5: drop a block, resize another, set its category; the outlines of the rest survive.
    const doc = read.document;
    const front = doc.categories.find((c) => c.name === 'Front')!;
    front.priceMinor = 7500;
    front.priceSuggested = false;
    doc.sections = doc.sections.filter((s) => s.name !== 'Rear 5');
    const front3 = doc.sections.find((s) => s.name === 'Front 3')!;
    front3.rows = ['A', 'B', 'C', 'D'].map((label) => ({ label, kinds: 'SSSSSSSS' }));
    front3.rows[0].kinds = 'WCSSSSSS';
    await save(created.id, doc);

    const again = await layouts.document(ORGANIZER, created.id);
    expect(comparable(again.document)).toEqual(comparable(doc));
    expect(again.layoutKind).toBe('SECTIONED');
    expect(again.document.sections.every((s) => Array.isArray(s.shape))).toBe(true);
    expect((await layouts.listVersions(ORGANIZER, space.id))[0].suggestedPrices).toEqual([]);

    // The buyer preview shows the price that was set, never the old suggestion.
    const preview = await layouts.preview(ORGANIZER, created.id);
    expect(preview.categories.map((c) => [c.name, c.priceMinor])).toEqual([
      ['Front', 7500],
      ['Rear', 4999],
    ]);
    // Each block on the map carries its category colour, so a buyer can tell the areas apart.
    if (preview.view !== 'overview') throw new Error('expected a venue overview');
    const colourOf = new Map(preview.categories.map((c) => [c.name, c.colorHex]));
    const front1 = preview.sections.find((s) => s.name === 'Front 1');
    const rear1 = preview.sections.find((s) => s.name === 'Rear 1');
    expect(front1).toMatchObject({ categoryName: 'Front', colorHex: colourOf.get('Front') });
    expect(rear1).toMatchObject({ categoryName: 'Rear', colorHex: colourOf.get('Rear') });
    expect(colourOf.get('Front')).not.toBe(colourOf.get('Rear'));
  });

  describe('a room of rows, shaped seat by seat', () => {
    let space = { id: '' };
    let draftId = '';
    let shaped: LayoutDocument;

    maybe('splits, marks, removes and adds seats, and reads back exactly', async () => {
      space = await newSpace('Hall');
      const created = await layouts.createFromTemplate(ORGANIZER, space.id, {
        template: 'FLAT_HALL',
        targetSeats: 100,
        fit: 'EXACT',
        basePriceMinor: 15_000,
      });
      draftId = created.id;
      const doc = (await layouts.document(ORGANIZER, draftId)).document;
      expect(countLayoutDocument(doc).bookable).toBe(100);

      // J2: rename, reprice, recolour; add a category.
      doc.categories[0] = { ...doc.categories[0], name: 'Standard', priceMinor: 12_000 };
      doc.categories.push({
        key: 'new-premium',
        name: 'Premium',
        colorHex: '#7C3AED',
        priceMinor: 20_000,
        priceSuggested: false,
        regulatoryClass: null,
      });
      // J3: split the hall after its third row; the front part is Premium.
      const hall = doc.sections[0];
      const front = {
        ...hall,
        name: 'Front rows',
        categoryKey: 'new-premium',
        rows: hall.rows.slice(0, 3),
      };
      const back = { ...hall, name: 'Back rows', rows: hall.rows.slice(3) };
      doc.sections = [front, back];
      // J4: remove two seats, add two at the end of row B, mark one of each kind.
      const set = (s: string, at: number, code: string) => s.slice(0, at) + code + s.slice(at + 1);
      front.rows[0] = { ...front.rows[0], kinds: set(set(front.rows[0].kinds, 0, 'G'), 1, 'G') };
      front.rows[1] = { ...front.rows[1], kinds: `${front.rows[1].kinds}SS` };
      front.rows[2] = {
        ...front.rows[2],
        kinds: set(set(set(front.rows[2].kinds, 0, 'R'), 1, 'H'), 2, 'H'),
      };
      shaped = doc;
      const result = await save(draftId, doc);
      expect(result.counts.house).toBe(2);
      expect(result.counts.restricted).toBe(1);

      const read = await layouts.document(ORGANIZER, draftId);
      expect(comparable(read.document)).toEqual(comparable(doc));
      // What the database holds is the same count the editor showed.
      const positions = await db!.seat.count({ where: { seatMapId: draftId } });
      expect(positions).toBe(countLayoutDocument(doc).positions);
    });

    maybe('publishing accepts the prices; a published layout cannot be saved over', async () => {
      await layouts.publish(ORGANIZER, draftId, {});
      const categories = await db!.seatCategory.findMany({ where: { seatMapId: draftId } });
      expect(categories.every((c: { priceSuggested: boolean }) => !c.priceSuggested)).toBe(true);

      const read = await layouts.document(ORGANIZER, draftId);
      expect(read.editable).toBe(false);
      await expect(save(draftId, read.document)).rejects.toMatchObject({ status: 409 });
    });

    maybe('a clone opens as an editable draft with everything kept', async () => {
      const clone = await layouts.clone(ORGANIZER, draftId, {});
      const read = await layouts.document(ORGANIZER, clone.id);
      expect(read.editable).toBe(true);
      expect(comparable(read.document).sections).toEqual(comparable(shaped).sections);
    });

    maybe(
      'a session sells restricted-view seats, holds house seats back, and never a gap',
      async () => {
        const scheduled = await shows.scheduleShow(ORGANIZER, movieId, {
          screenId: space.id,
          startsAt: new Date(Date.now() + 230 * 86_400_000),
          endsAt: new Date(Date.now() + 230 * 86_400_000 + 3 * 3_600_000),
        } as never);
        const inventory = await db!.showSeat.findMany({
          where: { eventSessionId: scheduled.sessionId },
          select: { status: true, overrideKind: true, seat: { select: { kind: true } } },
        });
        const of = (kind: string) =>
          inventory.filter((r: { seat: { kind: string } }) => r.seat.kind === kind);
        expect(of('GAP')).toHaveLength(0);
        expect(of('HOUSE')).toHaveLength(2);
        expect(
          of('HOUSE').every(
            (r: { status: string; overrideKind: string | null }) =>
              r.status === 'BLOCKED' && r.overrideKind === 'HOUSE',
          ),
        ).toBe(true);
        expect(of('RESTRICTED_VIEW').map((r: { status: string }) => r.status)).toEqual([
          'AVAILABLE',
        ]);
        expect(of('SEAT').every((r: { status: string }) => r.status === 'AVAILABLE')).toBe(true);
        expect(inventory).toHaveLength(countLayoutDocument(shaped).seats);
      },
    );
  });

  maybe('a size the shape cannot be is refused in words, not built', async () => {
    const space = await newSpace('Stadium');
    await expect(
      layouts.createFromTemplate(ORGANIZER, space.id, {
        template: 'STADIUM',
        targetSeats: 100,
        fit: 'EXACT',
        basePriceMinor: 1000,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await db!.seatMap.count({ where: { screenId: space.id } })).toBe(0);
  });
});
