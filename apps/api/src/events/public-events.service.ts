import { HttpStatus, Injectable } from '@nestjs/common';
import { EventStatus, ExperienceType } from '@eticketsgo/shared-types';
import { Prisma } from '@prisma/client';
import type { FeeMode } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AdvertisedPriceService } from '../pricing/advertised-price.service';
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
  constructor(
    private readonly prisma: PrismaService,
    // What a LISTING advertises, per PRICE_DISPLAY_MODE. Returns prices unchanged in the
    // default `itemised` mode without touching the database.
    private readonly advertised: AdvertisedPriceService,
  ) {}

  async list(filters: PublicEventFilters) {
    const where: Prisma.EventWhereInput = {
      status: EventStatus.PUBLISHED,
      // Keep the generic browse events-only; movie experiences surface via /public/movies.
      experienceType: ExperienceType.EVENT,
      // Free-text `q` matches the event title, the organizer name, and the venue
      // name/city (additive: previously title-only). All other filters unchanged.
      ...(filters.q
        ? {
            OR: [
              { title: { contains: filters.q, mode: 'insensitive' } },
              { organization: { name: { contains: filters.q, mode: 'insensitive' } } },
              { venue: { name: { contains: filters.q, mode: 'insensitive' } } },
              { venue: { city: { contains: filters.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
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

    const data = await Promise.all(
      events.map(async (e) => {
        const currency = e.sessions[0]?.ticketTypes[0]?.currency ?? 'INR';
        return {
          id: e.id,
          title: e.title,
          slug: e.slug,
          category: e.category,
          venue: e.venue,
          organizer: e.organization.name,
          nextSessionAt: e.sessions[0]?.startsAt ?? null,
          fromPriceMinor: await this.advertised.forTicket(
            e.sessions[0]?.ticketTypes[0]?.priceMinor ?? null,
            e.feeMode as FeeMode,
            currency,
          ),
          currency,
        };
      }),
    );

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

  /**
   * Published-event categories with their counts (events-only), for a richer
   * "browse by category" experience. Sorted by count desc, then name asc so the
   * result is deterministic. Reuses a Prisma groupBy (no raw SQL).
   */
  async categoriesWithCounts(): Promise<{ category: string; count: number }[]> {
    const rows = await this.prisma.event.groupBy({
      by: ['category'],
      where: { status: EventStatus.PUBLISHED, experienceType: ExperienceType.EVENT },
      _count: { _all: true },
    });
    return rows
      .map((r) => ({ category: r.category, count: r._count._all }))
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
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
      // So the buyer is told "Free" rather than "₹0.00", and the checkout can skip itself.
      isFree: event.isFree,
      venue: event.venue,
      organizer: event.organization,
      sessions: event.sessions.map((s) => ({
        id: s.id,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        status: s.status,
        /*
          Whether this session sells named seats.

          The buyer needs a different screen for each: a seat map to pick from, or a quantity
          to choose. Sent as a fact about the SESSION rather than left for the client to infer
          from the experience type, because that inference is exactly what used to make a
          seated concert impossible — and because two sessions of the same event can differ,
          one in a seated theatre and one in a standing room.
        */
        seatBased: Boolean(s.screenId),
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
      select: {
        id: true,
        name: true,
        status: true,
        createdAt: true,
        description: true,
        logoUrl: true,
        coverImageUrl: true,
        website: true,
        contactEmail: true,
        contactPhone: true,
        twitterUrl: true,
        instagramUrl: true,
        facebookUrl: true,
        verified: true,
      },
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
    // Advertised prices resolved before the map, so the organizer page quotes the same
    // number the browse listing does. Two surfaces showing different prices for the same
    // ticket is the exact failure the all-in rules exist to address.
    const advertisedByEvent = new Map<string, number | null>(
      await Promise.all(
        events.map(
          async (e) =>
            [
              e.id,
              await this.advertised.forTicket(
                e.sessions[0]?.ticketTypes[0]?.priceMinor ?? null,
                e.feeMode as FeeMode,
                e.sessions[0]?.ticketTypes[0]?.currency ?? 'INR',
              ),
            ] as const,
        ),
      ),
    );

    return {
      id: org.id,
      name: org.name,
      verified: org.verified,
      memberSince: org.createdAt,
      eventCount: events.length,
      description: org.description,
      logoUrl: org.logoUrl,
      coverImageUrl: org.coverImageUrl,
      website: org.website,
      contactEmail: org.contactEmail,
      contactPhone: org.contactPhone,
      twitterUrl: org.twitterUrl,
      instagramUrl: org.instagramUrl,
      facebookUrl: org.facebookUrl,
      events: events.map((e) => ({
        id: e.id,
        title: e.title,
        slug: e.slug,
        category: e.category,
        venue: e.venue,
        organizer: org.name,
        nextSessionAt: e.sessions[0]?.startsAt ?? null,
        fromPriceMinor: advertisedByEvent.get(e.id) ?? null,
        currency: e.sessions[0]?.ticketTypes[0]?.currency ?? 'INR',
      })),
    };
  }
}
