import { HttpStatus, Injectable } from '@nestjs/common';
import { EventStatus, ExperienceType } from '@eticketsgo/shared-types';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppException, ErrorCodes } from '../common/errors';
import { availableUnits } from '../inventory/inventory-strategy.interface';

export interface PublicEventFilters {
  q?: string;
  city?: string;
  category?: string;
  dateFrom?: Date;
  dateTo?: Date;
  page: number;
  pageSize: number;
}

@Injectable()
export class PublicEventsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(filters: PublicEventFilters) {
    const where: Prisma.EventWhereInput = {
      status: EventStatus.PUBLISHED,
      // Keep the generic browse events-only; movie experiences surface via /public/movies.
      experienceType: ExperienceType.EVENT,
      ...(filters.q ? { title: { contains: filters.q, mode: 'insensitive' } } : {}),
      ...(filters.category ? { category: { equals: filters.category, mode: 'insensitive' } } : {}),
      ...(filters.city ? { venue: { city: { equals: filters.city, mode: 'insensitive' } } } : {}),
      ...(filters.dateFrom || filters.dateTo
        ? {
            sessions: {
              some: {
                startsAt: {
                  ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
                  ...(filters.dateTo ? { lte: filters.dateTo } : {}),
                },
              },
            },
          }
        : {}),
    };

    const [total, events] = await this.prisma.$transaction([
      this.prisma.event.count({ where }),
      this.prisma.event.findMany({
        where,
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
        orderBy: { publishedAt: 'desc' },
        include: {
          venue: { select: { name: true, city: true, country: true } },
          organization: { select: { name: true } },
          sessions: {
            orderBy: { startsAt: 'asc' },
            take: 1,
            include: { ticketTypes: { orderBy: { priceMinor: 'asc' }, take: 1 } },
          },
        },
      }),
    ]);

    const data = events.map((e) => ({
      id: e.id,
      title: e.title,
      slug: e.slug,
      category: e.category,
      venue: e.venue,
      organizer: e.organization.name,
      nextSessionAt: e.sessions[0]?.startsAt ?? null,
      fromPriceMinor: e.sessions[0]?.ticketTypes[0]?.priceMinor ?? null,
      currency: e.sessions[0]?.ticketTypes[0]?.currency ?? 'INR',
    }));

    return {
      data,
      meta: {
        page: filters.page,
        pageSize: filters.pageSize,
        total,
        totalPages: Math.ceil(total / filters.pageSize),
      },
    };
  }

  async getBySlug(slug: string) {
    const event = await this.prisma.event.findUnique({
      where: { slug },
      include: {
        venue: true,
        organization: { select: { id: true, name: true } },
        sessions: {
          orderBy: { startsAt: 'asc' },
          include: {
            ticketTypes: { orderBy: { priceMinor: 'asc' }, include: { inventory: true } },
          },
        },
      },
    });
    if (!event || event.status !== EventStatus.PUBLISHED) {
      throw new AppException(
        ErrorCodes.EVENT_NOT_PUBLISHED,
        'Event not found or not available.',
        HttpStatus.NOT_FOUND,
      );
    }

    return {
      id: event.id,
      title: event.title,
      slug: event.slug,
      experienceType: event.experienceType,
      category: event.category,
      description: event.description,
      refundPolicy: event.refundPolicy,
      feeMode: event.feeMode,
      venue: event.venue,
      organizer: event.organization,
      sessions: event.sessions.map((s) => ({
        id: s.id,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        status: s.status,
        ticketTypes: s.ticketTypes.map((t) => ({
          id: t.id,
          name: t.name,
          priceMinor: t.priceMinor,
          currency: t.currency,
          maxPerOrder: t.maxPerOrder,
          available: t.inventory
            ? availableUnits(
                t.inventory.quantityTotal,
                t.inventory.quantitySold,
                t.inventory.quantityHeld,
              )
            : 0,
        })),
      })),
    };
  }

  /** Public organizer profile: verification badge + their published events. */
  async organizer(id: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id },
      select: { id: true, name: true, status: true, createdAt: true },
    });
    if (!org) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Organizer not found.', HttpStatus.NOT_FOUND);
    }
    const events = await this.prisma.event.findMany({
      where: { organizationId: id, status: EventStatus.PUBLISHED },
      orderBy: { publishedAt: 'desc' },
      take: 24,
      include: {
        venue: { select: { name: true, city: true, country: true } },
        sessions: {
          orderBy: { startsAt: 'asc' },
          take: 1,
          include: { ticketTypes: { orderBy: { priceMinor: 'asc' }, take: 1 } },
        },
      },
    });
    return {
      id: org.id,
      name: org.name,
      verified: org.status === 'APPROVED',
      memberSince: org.createdAt,
      eventCount: events.length,
      events: events.map((e) => ({
        id: e.id,
        title: e.title,
        slug: e.slug,
        category: e.category,
        venue: e.venue,
        organizer: org.name,
        nextSessionAt: e.sessions[0]?.startsAt ?? null,
        fromPriceMinor: e.sessions[0]?.ticketTypes[0]?.priceMinor ?? null,
        currency: e.sessions[0]?.ticketTypes[0]?.currency ?? 'INR',
      })),
    };
  }
}
