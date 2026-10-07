import { HttpStatus, Injectable } from '@nestjs/common';
import { Role } from '@eticketsgo/shared-types';
import type { CreateScreenInput, CreateVenueInput, UpdateVenueInput } from '@eticketsgo/validation';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';

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
        // Omitted leaves the schema default. A country is not a timezone — several launch
        // markets span more than one — so this is never inferred from `country`.
        timezone: input.timezone,
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
      select: { id: true, organizationId: true },
    });
    if (!venue) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Venue not found.', HttpStatus.NOT_FOUND);
    }
    await this.access.assertMember(user, venue.organizationId, [
      Role.ORGANIZER_OWNER,
      Role.ORGANIZER_MANAGER,
    ]);

    return this.prisma.venue.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.city !== undefined ? { city: input.city } : {}),
        ...(input.country !== undefined ? { country: input.country } : {}),
        ...(input.region !== undefined ? { region: input.region } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        ...(input.address !== undefined ? { address: input.address } : {}),
        ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
      },
      include: { areas: true },
    });
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
        cinemaId: true,
        cinema: { select: { id: true, name: true } },
        seatMaps: {
          where: { status: 'PUBLISHED' },
          orderBy: { version: 'desc' },
          take: 1,
          select: { id: true, name: true, layoutKind: true, version: true },
        },
      },
    });

    return spaces.map((s) => ({
      id: s.id,
      name: s.name,
      capacity: s.capacity,
      status: s.status,
      screenType: s.screenType,
      /* Named so the console can say "Screen 4" belongs to a cinema and "Main Hall" does not. */
      cinemaId: s.cinemaId,
      cinemaName: s.cinema?.name ?? null,
      layout: s.seatMaps[0] ?? null,
    }));
  }

  /**
   * Add a space to a venue, with no cinema involved.
   *
   * THE POINT OF THE WHOLE MIGRATION. Before it, this call was impossible: `Screen.cinemaId`
   * was NOT NULL, so creating a bookable area meant creating a cinema to hang it from, and an
   * arena, an auditorium or a concert hall had to pretend to be one.
   *
   * A cinema screen is still created through `CinemasService.addScreen`, which sets both the
   * cinema and the venue. The two paths write the same columns; this one simply leaves
   * `cinemaId` null, which is now allowed to mean what it says.
   */
  async addSpace(user: RequestUser, venueId: string, input: CreateScreenInput) {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { id: true, organizationId: true },
    });
    if (!venue)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Venue not found.', HttpStatus.NOT_FOUND);
    await this.access.assertMember(user, venue.organizationId, [
      Role.ORGANIZER_OWNER,
      Role.ORGANIZER_MANAGER,
    ]);

    return this.prisma.screen.create({
      data: {
        venueId,
        // Deliberately absent. This space is not a cinema screen, and saying so is the
        // difference between the model this migration created and the one it replaced.
        cinemaId: null,
        name: input.name,
        screenType: input.screenType,
        capacity: input.capacity,
      },
    });
  }
}
