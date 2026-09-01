import { HttpStatus, Injectable } from '@nestjs/common';
import { Role } from '@eticketsgo/shared-types';
import type { CreateVenueInput, UpdateVenueInput } from '@eticketsgo/validation';
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
}
