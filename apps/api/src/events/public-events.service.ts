import { HttpStatus, Injectable } from '@nestjs/common';
import { EventStatus, ExperienceType } from '@eticketsgo/shared-types';
import { Prisma } from '@prisma/client';
import type { FeeMode } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AdvertisedPriceService } from '../pricing/advertised-price.service';
import { AppException, ErrorCodes } from '../common/errors';
import { availableUnits } from '../inventory/inventory-strategy.interface';
import { countryAliases } from '../common/country';

export interface PublicEventFilters {
  q?: string;
  city?: string;
  /**
   * Scope to one country, in any spelling — `IN` and `India` both work.
   *
   * This is what the storefront applies when nobody has picked a city. Showing a visitor in
   * Hyderabad a comedy night in Idaho is not "more choice", it is noise they have to read
   * past, and it makes a two-market platform look like it has nothing near them. `city`
   * still wins when both are given: the narrower intent is the real one.
   */
  country?: string;
  category?: string;
  dateFrom?: Date;
  dateTo?: Date;
  /** Only events whose organizer declared them free. Never inferred from a price. */
  freeOnly?: boolean;
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
    const now = new Date();
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
      ...(filters.city
        ? { venue: { city: { equals: filters.city, mode: 'insensitive' } } }
        : filters.country
          ? {
              /*
                Every spelling, because the caller's `IN` has to meet the database's
                `India`. Applied only when no city is given — a city already implies its
                country, and ANDing both would turn one bad country string into an empty
                page for a city the customer explicitly asked for.
              */
              venue: { country: { in: countryAliases(filters.country), mode: 'insensitive' } },
            }
          : {}),
      // Declared, never inferred. `isFree` is a property of the event, not of whether
      // somebody happened to price a ticket type at zero.
      ...(filters.freeOnly ? { isFree: true } : {}),
      /*
        Something still to come.

        Browse used to list every published event regardless of whether any of its sessions
        had happened yet, so last month's show sat in the results looking bookable — and
        with the include above now correctly finding no upcoming session, it would render a
        card with no date at all. An event you cannot attend is not a search result.

        A requested date range narrows this further but can never widen it back into the
        past: `gte` takes whichever of "now" and the requested start is later.
      */
      sessions: {
        some: {
          startsAt: {
            gte: filters.dateFrom && filters.dateFrom > now ? filters.dateFrom : now,
            ...(filters.dateTo ? { lte: filters.dateTo } : {}),
          },
        },
      },
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
            /*
              The NEXT session, not the first one ever scheduled.

              Without the `gte` this took the earliest session outright, so a run of shows
              that opened last month advertised its opening night — a date already past —
              as the thing you were about to buy a ticket for, and priced the card from
              that session's ticket types. For a single-session event the two are the same,
              which is why it survived: the bug only appears on exactly the multi-date runs
              that theatres and cinemas exist to sell.
            */
            where: { startsAt: { gte: now } },
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
        organization: {
          select: {
            id: true,
            name: true,
            /*
              Whether this organizer takes cash at the venue, so the checkout can offer it.
              The storefront must not guess: an option shown that the server would refuse is
              a buyer who fills in a form and is turned away at the last step.
            */
            cashPaymentsEnabled: true,
          },
        },
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
      organizer: { id: event.organization.id, name: event.organization.name },
      // Surfaced on the event rather than nested in `organizer`, because it is a fact about
      // how you can pay for THIS event, not a detail of who is running it.
      cashAccepted: event.organization.cashPaymentsEnabled && !event.isFree,
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
