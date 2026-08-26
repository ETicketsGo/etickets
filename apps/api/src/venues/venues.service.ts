import { HttpStatus, Injectable } from '@nestjs/common';
import { Role } from '@eticketsgo/shared-types';
import type { CreateVenueInput } from '@eticketsgo/validation';
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
