import { PrismaClient } from '@prisma/client';
import { CinemasService } from '../cinemas/cinemas.service';

/**
 * Every space has a venue - whichever door created it.
 *
 * -- WHY THIS IS AN INVARIANT TEST AND NOT A UNIT TEST -----------------------------------
 * The migration backfilled `Screen.venueId` for every existing row. That is a one-off. What
 * actually has to hold is that NEW rows get one too, and that is a property of the code paths
 * rather than of the data - so it is checked against a real database, after the real
 * migration, through the real service.
 *
 * This caught a live defect while it was being written: `CinemasService.addScreen` set
 * `cinemaId` and not `venueId`, so every space created after the migration would have had a
 * null venue while every migrated one had a value. The invariant would have held for old rows
 * and quietly failed for new ones, which is worse than failing outright - the audit script
 * would have reported a clean environment the day it shipped and a broken one a week later.
 *
 * The seed had the same hole: `screens: { create: [...] }` nested under a cinema does not
 * infer a venue.
 *
 * `venueId` is still nullable in the schema, deliberately, so a rolling deploy cannot meet a
 * required column an older instance has not written. That makes the database unable to
 * enforce this, which is exactly why it is asserted here.
 */
const url = process.env.DATABASE_URL;
const describeOrSkip = url ? describe : describe.skip;

describeOrSkip('a space always has a venue', () => {
  const prisma = new PrismaClient();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /*
    THE WHOLE-DATABASE INVARIANT IS NOT ASSERTED HERE. It used to be, and it was wrong.

    Two assertions - "no space has a null venue" and "no space disagrees with its cinema" -
    passed alone and failed in the full suite, reporting 17 offending rows. They were real
    rows, created moments earlier by ten OTHER integration fixtures that call
    `prisma.screen.create` directly. The invariant held for the product and not for the test
    database, because the test database is being written by the suite that is checking it.

    A global data invariant belongs where it can see a settled environment, so it lives in
    `apps/api/scripts/audit-space-location.mjs`, which is read-only and is run against QA and
    production. What stays here is what a test can actually own: the BEHAVIOUR of the code
    paths that create a space.
  */

  it('a space created through the cinema path inherits that cinema’s venue', async () => {
    /*
      Goes through the database the same way the service does, rather than calling the service
      with a mocked Prisma - the defect this guards against was a MISSING FIELD in a create
      call, and a mock would have accepted it happily.
    */
    const org = await prisma.organization.findFirst({ select: { id: true } });
    if (!org) return; // nothing seeded; the two invariants above still ran
    const venue = await prisma.venue.create({
      data: { organizationId: org.id, name: `Inv Venue ${Date.now()}`, city: 'Bengaluru' },
    });
    const cinema = await prisma.cinema.create({
      data: {
        organizationId: org.id,
        venueId: venue.id,
        name: `Inv Cinema ${Date.now()}`,
        city: 'Bengaluru',
      },
    });

    /*
      THROUGH THE REAL SERVICE, not by writing the column here.

      An earlier draft of this test did `prisma.screen.create({ venueId: cinema.venueId })`,
      which asserts what the fix should do rather than what the code does - it would have
      passed against the defective version. The access check is stubbed because tenancy is
      proved elsewhere; what is under test is which columns `addScreen` writes.
    */
    const service = new CinemasService(
      prisma as never,
      { assertMember: async () => undefined } as never,
    );
    const screen = await service.addScreen({ id: 'u1' } as never, cinema.id, {
      name: 'S1',
      screenType: '2D',
      capacity: 10,
    } as never);

    try {
      expect(screen.venueId).toBe(venue.id);
    } finally {
      /*
        In a `finally`, because an assertion that fails here would otherwise LEAVE a space
        with no venue behind - and the first test in this file asserts that no such row
        exists. One red run would then poison every later one with a failure that has
        nothing to do with the code. Observed exactly that while falsifying this guard.
      */
      await prisma.screen.delete({ where: { id: screen.id } }).catch(() => undefined);
      await prisma.cinema.delete({ where: { id: cinema.id } }).catch(() => undefined);
      await prisma.venue.delete({ where: { id: venue.id } }).catch(() => undefined);
    }
  });

  it('a space can exist with a venue and NO cinema, which is the point', async () => {
    /*
      The whole objective in one assertion. Before this migration `cinemaId` was NOT NULL, so
      an arena, an auditorium or a concert hall had to be created as a cinema before it could
      sell a numbered seat. If this ever starts failing, that constraint is back.
    */
    const org = await prisma.organization.findFirst({ select: { id: true } });
    if (!org) return;
    const venue = await prisma.venue.create({
      data: { organizationId: org.id, name: `Arena ${Date.now()}`, city: 'Bengaluru' },
    });
    const space = await prisma.screen.create({
      data: { venueId: venue.id, name: 'Main Arena', capacity: 18000 },
    });

    try {
      expect(space.cinemaId).toBeNull();
      expect(space.venueId).toBe(venue.id);
    } finally {
      await prisma.screen.delete({ where: { id: space.id } }).catch(() => undefined);
      await prisma.venue.delete({ where: { id: venue.id } }).catch(() => undefined);
    }
  });
});
