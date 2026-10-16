import { HttpStatus, Injectable } from '@nestjs/common';
import {
  Role,
  effectiveSpaceKind,
  sameClock,
  venueZone,
  zoneForPlace,
} from '@eticketsgo/shared-types';
import type { CreateScreenInput, CreateVenueInput, UpdateVenueInput } from '@eticketsgo/validation';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';
import { countsTowardsCap, overCapBy } from '../events/standing-capacity';
import { SOLD_BOOKING_STATUSES, keepWallClock } from './venue-timezone';

@Injectable()
export class VenuesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
  ) {}

  async create(user: RequestUser, organizationId: string, input: CreateVenueInput) {
    await this.access.assertMember(user, organizationId, [
      Role.ORGANIZER_OWNER,
      Role.ORGANIZER_MANAGER,
    ]);
    return this.prisma.venue.create({
      data: {
        organizationId,
        name: input.name,
        city: input.city,
        country: input.country,
        /*
          The state/province, at last settable.

          It decides India's place of supply — whether a sale is CGST + SGST or IGST — and
          until now nothing in the product could write it, so every organizer-created venue
          left it null and every sale from one looked intra-state.
        */
        region: input.region,
        /*
          A country is not a timezone in general - several launch markets span more than one -
          so without a zone from the caller it comes from the STATE where the state settles it
          (Idaho keeps Boise time, Texas Chicago's), else from a country with exactly ONE zone
          (India, the UK, the UAE, Singapore). Neither is a guess, and leaving it empty
          rendered every show time in the buyer's browser zone instead of the venue's.

          A zone the caller DID send is kept, even when it disagrees with the state. A venue in
          El Paso is on Mountain time though Texas is Central; overriding an explicit answer
          with a table would be the same silent wrong answer this replaces, pointed the other
          way. The organizer form now sets the zone from the state and says so in words, which
          is where a contradiction can be seen and fixed by a person.
        */
        timezone: input.timezone ?? zoneForPlace(input.country, input.region) ?? undefined,
        address: input.address,
        capacity: input.capacity,
      },
    });
  }

  /**
   * Edit a venue.
   *
   * There was no way to do this at all: a venue could be created from the onboarding page
   * or mid-wizard and then never touched again, yet its name and city print on every event
   * listing. A typo in a venue name was permanent.
   *
   * Only fields actually supplied are written, so a rename cannot blank an address that the
   * form did not happen to load.
   */
  async update(user: RequestUser, id: string, input: UpdateVenueInput) {
    const venue = await this.prisma.venue.findUnique({
      where: { id },
      select: {
        id: true,
        organizationId: true,
        city: true,
        address: true,
        country: true,
        region: true,
        timezone: true,
      },
    });
    if (!venue) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Venue not found.', HttpStatus.NOT_FOUND);
    }
    await this.access.assertMember(user, venue.organizationId, [
      Role.ORGANIZER_OWNER,
      Role.ORGANIZER_MANAGER,
    ]);
    /*
      A venue that has NO zone yet takes the one its place settles, the same rule as create.
      A stored zone is never moved by a state change alone: it may already time sold shows,
      and changing it is a decision the organizer makes by sending a zone.
    */
    const filledZone =
      input.timezone === undefined && !venue.timezone
        ? zoneForPlace(input.country ?? venue.country, input.region ?? venue.region)
        : null;

    /*
      -- A NEW CLOCK FOR A VENUE THAT HAS SOLD -------------------------------------------------
      Session times are stored as instants, resolved through the venue's zone when they were
      typed. Moving the zone does not move them; it changes the local time they are SHOWN as - so
      a ticket that says 19:00 would start saying 17:00, and its holder would arrive two hours
      late. That is refused while any session here has a ticket sold or being paid for, the same
      rule a cinema's own zone already has.

      A session nobody has bought from keeps its LOCAL time instead: the organizer who typed
      19:00 meant 19:00 at the venue, so its instants (and its ticket sale windows) are
      re-resolved in the new zone in the same transaction. That is the correction a wrong zone
      needs, and nobody holds a ticket that names the old reading.

      Only a stored zone being replaced by a different clock counts. Filling an empty zone, or
      re-spelling one (Asia/Calcutta to Asia/Kolkata), changes no time anybody sees.
    */
    const nextZone = input.timezone ?? null;
    const oldZone = venue.timezone;
    const clockChanges = !!(nextZone && oldZone && !sameClock(nextZone, oldZone));
    const sessionsHere = {
      OR: [
        { event: { venueId: id } },
        { screen: { venueId: id } },
        { screen: { cinema: { venueId: id } } },
      ],
    };
    let unsold: { id: string; startsAt: Date; endsAt: Date }[] = [];
    if (clockChanges) {
      const sold = await this.prisma.eventSession.count({
        where: {
          ...sessionsHere,
          bookings: { some: { status: { in: [...SOLD_BOOKING_STATUSES] } } },
        },
      });
      if (sold > 0) {
        throw new AppException(
          ErrorCodes.CONFLICT,
          `You cannot change this venue's time zone. ${sold} session${
            sold === 1 ? ' here has' : 's here have'
          } tickets sold or being paid for, and those tickets would show a different start time. Keep the time zone as it is, or contact ETicketsGo support to move the schedule safely.`,
          HttpStatus.CONFLICT,
          { reason: 'TIMEZONE_LOCKED_BY_SALES', soldSessions: sold },
        );
      }
      unsold = await this.prisma.eventSession.findMany({
        where: sessionsHere,
        select: { id: true, startsAt: true, endsAt: true },
      });
    }

    /*
      -- THE CINEMAS HERE TAKE THE VENUE'S LOCATION ----------------------------------------------
      A cinema is the film business AT a venue, and its location is the venue's. Its own city,
      address, country, region and clock columns are kept (older rows and older instances read
      them), but they are written from here, so an edit to the venue cannot leave a cinema in
      it saying somewhere else. The cinema page no longer edits them at all.
    */
    /*
      Only what the organizer actually CHANGED, and never a blank. The venue form sends every
      field on every save, and a cinema's own state and country still decide which regulated
      price rules apply to it (they are read before the venue's). Copying an unchanged or empty
      answer over them would let a street-address edit quietly clear a Telangana cinema's state.
    */
    const changed = (next: string | null | undefined, before: string | null) =>
      next !== undefined && next !== null && next.trim() !== '' && next !== (before ?? '');
    const location = {
      ...(changed(input.city, venue.city) ? { city: input.city } : {}),
      ...(changed(input.address, venue.address) ? { address: input.address } : {}),
      ...(changed(input.country, venue.country) ? { country: input.country } : {}),
      ...(changed(input.region, venue.region) ? { region: input.region } : {}),
      ...(changed(input.timezone, venue.timezone) ? { timezone: input.timezone } : {}),
      ...(filledZone ? { timezone: filledZone } : {}),
    };

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.venue.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.city !== undefined ? { city: input.city } : {}),
          ...(input.country !== undefined ? { country: input.country } : {}),
          ...(input.region !== undefined ? { region: input.region } : {}),
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
          ...(filledZone ? { timezone: filledZone } : {}),
          ...(input.address !== undefined ? { address: input.address } : {}),
          ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
        },
        include: { areas: true },
      });
      if (Object.keys(location).length > 0) {
        await tx.cinema.updateMany({ where: { venueId: id }, data: location });
      }
      if (clockChanges && nextZone && oldZone) {
        for (const s of unsold) {
          await tx.eventSession.update({
            where: { id: s.id },
            data: {
              startsAt: keepWallClock(s.startsAt, oldZone, nextZone),
              endsAt: keepWallClock(s.endsAt, oldZone, nextZone),
            },
          });
          const windows = await tx.ticketType.findMany({
            where: {
              eventSessionId: s.id,
              OR: [{ salesStartAt: { not: null } }, { salesEndAt: { not: null } }],
            },
            select: { id: true, salesStartAt: true, salesEndAt: true },
          });
          for (const t of windows) {
            await tx.ticketType.update({
              where: { id: t.id },
              data: {
                salesStartAt: t.salesStartAt && keepWallClock(t.salesStartAt, oldZone, nextZone),
                salesEndAt: t.salesEndAt && keepWallClock(t.salesEndAt, oldZone, nextZone),
              },
            });
          }
        }
      }
      return row;
    });
    // Said back so the form can tell the organizer their sessions kept their local times.
    return { ...updated, sessionsKeptLocalTime: clockChanges ? unsold.length : 0 };
  }

  async list(user: RequestUser, organizationId: string) {
    await this.access.assertMember(user, organizationId);
    return this.prisma.venue.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      include: { areas: true },
    });
  }

  async get(user: RequestUser, id: string) {
    const venue = await this.prisma.venue.findUnique({ where: { id }, include: { areas: true } });
    if (!venue)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Venue not found.', HttpStatus.NOT_FOUND);
    await this.access.assertMember(user, venue.organizationId);
    return venue;
  }

  /**
   * The spaces inside a venue - every bookable area, whether or not it is a cinema screen.
   *
   * This is the read the organizer console needs to show VENUE -> SPACE, and it could not be
   * written before: a space reached its venue only through a cinema, so "the spaces in this
   * venue" meant "the screens of the cinemas in this venue" and a hall that was not a cinema
   * simply could not exist to be listed.
   */
  async spaces(user: RequestUser, venueId: string) {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { id: true, organizationId: true },
    });
    if (!venue)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Venue not found.', HttpStatus.NOT_FOUND);
    await this.access.assertMember(user, venue.organizationId);

    const spaces = await this.prisma.screen.findMany({
      where: { venueId },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        capacity: true,
        status: true,
        screenType: true,
        kind: true,
        cinemaId: true,
        cinema: { select: { id: true, name: true } },
        seatMaps: {
          where: { status: 'PUBLISHED' },
          orderBy: [{ name: 'asc' }, { version: 'desc' }],
          select: { id: true, name: true, layoutKind: true, version: true },
        },
      },
    });

    const byName = new Map<string, (typeof spaces)[number]['seatMaps'][number]>();
    return spaces.map((s) => {
      byName.clear();
      for (const m of s.seatMaps) if (!byName.has(m.name)) byName.set(m.name, m);
      return {
        id: s.id,
        name: s.name,
        capacity: s.capacity,
        status: s.status,
        screenType: s.screenType,
        kind: effectiveSpaceKind(s),
        /* Named so the console can say "Screen 4" belongs to a cinema and "Main Hall" does not. */
        cinemaId: s.cinemaId,
        cinemaName: s.cinema?.name ?? null,
        // Every named configuration, current version of each - the same answer the
        // organization-wide listing gives, because the two reads must not disagree.
        layouts: [...byName.values()],
        layout: s.seatMaps[0] ?? null,
      };
    });
  }

  /**
   * Every bookable space in an organization, with the venue it belongs to.
   *
   * One query rather than one per venue: the organizer console lists VENUE -> SPACE -> LAYOUT
   * on a single screen, and a request per venue would make a chain with ten venues ten round
   * trips deep for a page that is mostly waiting.
   */
  async allSpaces(user: RequestUser, organizationId: string) {
    await this.access.assertMember(user, organizationId);

    const spaces = await this.prisma.screen.findMany({
      where: { venue: { organizationId } },
      orderBy: [{ venue: { name: 'asc' } }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        capacity: true,
        status: true,
        screenType: true,
        kind: true,
        venueId: true,
        cinemaId: true,
        cinema: { select: { id: true, name: true } },
        /*
          EVERY published layout, not the newest one.

          A space has NAMED configurations now - an arena's basketball bowl and its end-stage
          concert are both live at once - so taking one would show an operator half of what
          their own room can do. Ordered newest version first so the per-name reduction below
          keeps the current version of each.
        */
        seatMaps: {
          where: { status: 'PUBLISHED' },
          orderBy: [{ name: 'asc' }, { version: 'desc' }],
          select: { id: true, name: true, layoutKind: true, version: true },
        },
      },
    });

    /** The current version of each named layout. */
    const currentLayouts = (
      maps: { id: string; name: string; layoutKind: string; version: number }[],
    ) => {
      const byName = new Map<string, (typeof maps)[number]>();
      for (const m of maps) if (!byName.has(m.name)) byName.set(m.name, m);
      return [...byName.values()];
    };

    return spaces.map((s) => ({
      id: s.id,
      venueId: s.venueId,
      name: s.name,
      capacity: s.capacity,
      status: s.status,
      screenType: s.screenType,
      kind: effectiveSpaceKind(s),
      cinemaId: s.cinemaId,
      cinemaName: s.cinema?.name ?? null,
      layouts: currentLayouts(s.seatMaps),
      /** The first one, kept so existing callers that expect a single layout still work. */
      layout: s.seatMaps[0] ?? null,
    }));
  }

  /**
   * One space, with everything its own page needs: the venue it is in (whose location and
   * currency it inherits), the cinema it belongs to if it is a screen, its current layouts and
   * how many sessions use it.
   *
   * The session counts are what make "rename, take out of use or delete" safe to offer: the
   * page can say BEFORE anybody presses Delete that a space with sessions cannot be deleted.
   */
  async getSpace(user: RequestUser, spaceId: string) {
    const space = await this.prisma.screen.findUnique({
      where: { id: spaceId },
      select: {
        id: true,
        name: true,
        capacity: true,
        status: true,
        screenType: true,
        kind: true,
        cinemaId: true,
        cinema: { select: { id: true, name: true, organizationId: true } },
        venue: {
          select: {
            id: true,
            organizationId: true,
            name: true,
            city: true,
            address: true,
            country: true,
            region: true,
            timezone: true,
          },
        },
        seatMaps: {
          where: { status: 'PUBLISHED' },
          orderBy: [{ name: 'asc' }, { version: 'desc' }],
          select: { id: true, name: true, layoutKind: true, version: true },
        },
      },
    });
    // The venue owns a space; the cinema only for a row an older instance wrote.
    const organizationId = space?.venue?.organizationId ?? space?.cinema?.organizationId;
    if (!space || !organizationId)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Space not found.', HttpStatus.NOT_FOUND);
    await this.access.assertMember(user, organizationId);

    const now = new Date();
    // A standing space's sessions name it through `standingSpaceId`, a seated one's `screenId`.
    const inSpace = { OR: [{ screenId: spaceId }, { standingSpaceId: spaceId }] };
    const [sessions, upcomingSessions, standing] = await Promise.all([
      this.prisma.eventSession.count({ where: inSpace }),
      this.prisma.eventSession.count({
        where: { ...inSpace, startsAt: { gt: now }, status: { not: 'CANCELLED' } },
      }),
      /*
        Every session still to come in this space when it is a standing floor, with what it has
        on sale - so a session offering more than the space holds is FLAGGED here. It is never
        changed: lowering it is the organizer's decision, on the event's Tickets page.
      */
      this.prisma.eventSession.findMany({
        where: { standingSpaceId: spaceId, startsAt: { gt: now }, status: { not: 'CANCELLED' } },
        orderBy: { startsAt: 'asc' },
        take: 50,
        select: {
          id: true,
          startsAt: true,
          event: { select: { id: true, title: true } },
          ticketTypes: { select: { quantityTotal: true, status: true } },
        },
      }),
    ]);
    const standingSessions = standing.map((s) => {
      const onSale = s.ticketTypes.reduce(
        (n, t) => n + (countsTowardsCap(t.status) ? t.quantityTotal : 0),
        0,
      );
      return {
        sessionId: s.id,
        eventId: s.event.id,
        eventTitle: s.event.title,
        startsAt: s.startsAt,
        onSale,
        overCapacityBy: overCapBy(space.capacity, onSale),
      };
    });

    const byName = new Map<string, (typeof space.seatMaps)[number]>();
    for (const m of space.seatMaps) if (!byName.has(m.name)) byName.set(m.name, m);

    return {
      id: space.id,
      organizationId,
      name: space.name,
      capacity: space.capacity,
      status: space.status,
      screenType: space.screenType,
      kind: effectiveSpaceKind(space),
      venue: space.venue
        ? {
            id: space.venue.id,
            name: space.venue.name,
            city: space.venue.city,
            address: space.venue.address,
            country: space.venue.country,
            region: space.venue.region,
            timezone: space.venue.timezone,
          }
        : null,
      cinemaId: space.cinemaId,
      cinemaName: space.cinema?.name ?? null,
      layouts: [...byName.values()],
      sessions,
      upcomingSessions,
      standingSessions,
    };
  }

  /**
   * Add a space to a venue.
   *
   * THE POINT OF THE WHOLE MIGRATION. Before it, this call was impossible: `Screen.cinemaId`
   * was NOT NULL, so creating a bookable area meant creating a cinema to hang it from, and an
   * arena, an auditorium or a concert hall had to pretend to be one.
   *
   * -- A CINEMA SCREEN STILL JOINS A CINEMA ------------------------------------------------
   * The console's "New space" used to create a CINEMA and land on it, so "Screen 2" became a
   * cinema with an empty list of screens inside it - a space inside a space. A cinema is the
   * film business AT a venue (its brand, its schedule, its regulatory class), not a space, and
   * a screen needs one to show films. So a cinema screen is filed under the venue's cinema,
   * and when the venue has none yet one is made from the venue's own details - named after
   * the venue, never after the screen. The person adding "Screen 2" only sees the screen.
   *
   * Any other kind of space leaves `cinemaId` null, which is now allowed to mean what it says.
   */
  async addSpace(user: RequestUser, venueId: string, input: CreateScreenInput) {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: {
        id: true,
        organizationId: true,
        name: true,
        city: true,
        address: true,
        country: true,
        region: true,
        timezone: true,
      },
    });
    if (!venue)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Venue not found.', HttpStatus.NOT_FOUND);
    await this.access.assertMember(user, venue.organizationId, [
      Role.ORGANIZER_OWNER,
      Role.ORGANIZER_MANAGER,
    ]);

    if (input.kind !== 'CINEMA_SCREEN') {
      return this.prisma.screen.create({
        data: {
          venueId,
          // Deliberately absent. This space is not a cinema screen, and saying so is the
          // difference between the model this migration created and the one it replaced.
          cinemaId: null,
          name: input.name,
          screenType: input.screenType,
          capacity: input.capacity,
          kind: input.kind,
        },
      });
    }

    const zone = venueZone(venue.timezone, venue.country);
    return this.prisma.$transaction(async (tx) => {
      // Serialised per venue, so two screens added at once cannot each create a cinema.
      await tx.$queryRaw`SELECT id FROM "Venue" WHERE id = ${venueId} FOR UPDATE`;
      const existing = await tx.cinema.findFirst({
        where: { venueId, organizationId: venue.organizationId },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      const cinemaId =
        existing?.id ??
        (
          await tx.cinema.create({
            data: {
              organizationId: venue.organizationId,
              venueId,
              /*
                The venue's details, copied once so the cinema agrees with where it is. The
                clock is the venue's zone, else its country's only zone; the column default is
                the last resort, exactly as for a cinema created any other way.
              */
              name: venue.name,
              city: venue.city,
              address: venue.address,
              country: venue.country,
              region: venue.region,
              ...(zone ? { timezone: zone } : {}),
            },
            select: { id: true },
          })
        ).id;
      return tx.screen.create({
        data: {
          venueId,
          cinemaId,
          name: input.name,
          screenType: input.screenType,
          capacity: input.capacity,
          kind: 'CINEMA_SCREEN',
        },
      });
    });
  }
}
