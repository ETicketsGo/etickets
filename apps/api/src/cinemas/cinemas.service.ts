import { HttpStatus, Injectable } from '@nestjs/common';
import { Role } from '@eticketsgo/shared-types';
import type {
  CreateCinemaInput,
  CreateScreenInput,
  UpdateCinemaInput,
  UpdateScreenInput,
} from '@eticketsgo/validation';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';

const ORGANIZER_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER];

@Injectable()
export class CinemasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
  ) {}

  private async loadOwnedCinema(user: RequestUser, id: string, roles = ORGANIZER_ROLES) {
    const cinema = await this.prisma.cinema.findUnique({ where: { id } });
    if (!cinema)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Cinema not found.', HttpStatus.NOT_FOUND);
    await this.access.assertMember(user, cinema.organizationId, roles);
    return cinema;
  }

  private async loadOwnedScreen(user: RequestUser, id: string, roles = ORGANIZER_ROLES) {
    const screen = await this.prisma.screen.findUnique({
      where: { id },
      include: { cinema: { select: { organizationId: true } } },
    });
    if (!screen)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Screen not found.', HttpStatus.NOT_FOUND);
    await this.access.assertMember(user, screen.cinema.organizationId, roles);
    return screen;
  }

  async create(user: RequestUser, organizationId: string, input: CreateCinemaInput) {
    await this.access.assertMember(user, organizationId, ORGANIZER_ROLES);
    if (input.venueId) {
      const venue = await this.prisma.venue.findUnique({ where: { id: input.venueId } });
      if (!venue || venue.organizationId !== organizationId) {
        throw new AppException(
          ErrorCodes.NOT_FOUND,
          'Venue not found for this organization.',
          HttpStatus.NOT_FOUND,
        );
      }
    }
    return this.prisma.cinema.create({
      data: {
        organizationId,
        venueId: input.venueId,
        name: input.name,
        brand: input.brand,
        city: input.city,
        address: input.address,
        latitude: input.latitude,
        longitude: input.longitude,
      },
      include: { screens: true },
    });
  }

  async update(user: RequestUser, id: string, patch: UpdateCinemaInput) {
    await this.loadOwnedCinema(user, id);
    return this.prisma.cinema.update({
      where: { id },
      data: patch,
      include: { screens: true },
    });
  }

  async listForOrg(user: RequestUser, organizationId: string) {
    await this.access.assertMember(user, organizationId);
    return this.prisma.cinema.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      include: { screens: true },
    });
  }

  async getForOrg(user: RequestUser, id: string) {
    await this.loadOwnedCinema(user, id, undefined);
    return this.prisma.cinema.findUnique({ where: { id }, include: { screens: true } });
  }

  // ─── Screens ───

  async listScreens(user: RequestUser, cinemaId: string) {
    await this.loadOwnedCinema(user, cinemaId, undefined);
    return this.prisma.screen.findMany({
      where: { cinemaId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async addScreen(user: RequestUser, cinemaId: string, input: CreateScreenInput) {
    await this.loadOwnedCinema(user, cinemaId);
    return this.prisma.screen.create({
      data: {
        cinemaId,
        name: input.name,
        screenType: input.screenType,
        capacity: input.capacity,
      },
    });
  }

  async updateScreen(user: RequestUser, id: string, patch: UpdateScreenInput) {
    await this.loadOwnedScreen(user, id);
    return this.prisma.screen.update({ where: { id }, data: patch });
  }

  async removeScreen(user: RequestUser, id: string) {
    await this.loadOwnedScreen(user, id);
    await this.prisma.screen.delete({ where: { id } });
    return { success: true };
  }
}
