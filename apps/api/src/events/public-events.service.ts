import { HttpStatus, Injectable } from '@nestjs/common';
import { EventStatus, ExperienceType, SessionStatus } from '@eticketsgo/shared-types';
import { Prisma } from '@prisma/client';
import type { FeeMode } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AdvertisedPriceService } from '../pricing/advertised-price.service';
import { AppException, ErrorCodes } from '../common/errors';
import { availableUnits } from '../inventory/inventory-strategy.interface';
import { countryAliases } from '../common/country';
import { coverImagePath, eventImageOrder, eventImagesView } from './event-image';

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

        And still on. A date in the future counts only while it is SCHEDULED or PAUSED — an
        event whose remaining dates were all cancelled stayed listed, with a cancelled date as
        its next show. PAUSED stays in, as the movie catalogue keeps it: "sales are paused" is
        something a customer can act on, and a show that vanished looks like a fault.
      */
      sessions: {
        some: {
          status: { in: [SessionStatus.SCHEDULED, SessionStatus.PAUSED] },
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
          // The zone too, so the card shows the date at the venue rather than in the reader's
          // browser — on QA the cards and the event page disagreed about the same show.
          venue: { select: { name: true, city: true, country: true, timezone: true } },
          organization: { select: { name: true } },
          // The cover's id and hash only. A listing must never drag image bytes out of the database.
          images: { select: { id: true, sha256: true }, orderBy: eventImageOrder(), take: 1 },
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
            // The same "still on" rule as the filter above, so the date on the card is one
            // that is actually happening.
            where: {
              startsAt: { gte: now },
              status: { in: [SessionStatus.SCHEDULED, SessionStatus.PAUSED] },
            },
            orderBy: { startsAt: 'asc' },
            take: 1,
            // A ticket type taken off sale is not the price a customer can buy at.
            include: {
              ticketTypes: { where: { status: 'ACTIVE' }, orderBy: { priceMinor: 'asc' }, take: 1 },
            },
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
          imagePath: coverImagePath(e.id, e.images),
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
        images: { select: { id: true, sha256: true }, orderBy: eventImageOrder() },
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
          /*
            Only dates that are still on — the same rule as the browse listing and the
            organizer page. This returned every session the event ever had, so the event page
            preselected the first one: on QA "Stand-up comedy" opened on a date already past,
            showed "General ₹450 · 99 left", enabled "Continue to payment", and the quote
            answered 409. A date you cannot attend is not something to offer.
          */
          where: {
            startsAt: { gte: new Date() },
            status: { in: [SessionStatus.SCHEDULED, SessionStatus.PAUSED] },
          },
          orderBy: { startsAt: 'asc' },
          include: {
            /*
              ACTIVE only. The organizer's switch for taking a ticket type off sale was stored
              and never read: the page kept offering it, and checkout kept selling it.
            */
            ticketTypes: {
              where: { status: 'ACTIVE' },
              orderBy: { priceMinor: 'asc' },
              include: { inventory: true },
            },
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
      // The cover for anything that shows one image, and all of them for the page's gallery.
      imagePath: coverImagePath(event.id, event.images),
      images: eventImagesView(event.id, event.images),
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
    const now = new Date();
    const events = await this.prisma.event.findMany({
      where: { organizationId: id, status: EventStatus.PUBLISHED },
      orderBy: { publishedAt: 'desc' },
      take: 24,
      include: {
        // With its zone, for the same reason as the browse listing: the card's date is the venue's.
        venue: { select: { name: true, city: true, country: true, timezone: true } },
        images: { select: { id: true, sha256: true }, orderBy: eventImageOrder(), take: 1 },
        /*
          The same "still on" rule as the browse listing. This took each event's FIRST session
          ever and its cheapest ticket type of any status, so an organizer's page could show a
          date already past or cancelled, and a price taken off sale — found by the review.
        */
        sessions: {
          where: {
            startsAt: { gte: now },
            status: { in: [SessionStatus.SCHEDULED, SessionStatus.PAUSED] },
          },
          orderBy: { startsAt: 'asc' },
          take: 1,
          include: {
            ticketTypes: { where: { status: 'ACTIVE' }, orderBy: { priceMinor: 'asc' }, take: 1 },
          },
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
        imagePath: coverImagePath(e.id, e.images),
        nextSessionAt: e.sessions[0]?.startsAt ?? null,
        fromPriceMinor: advertisedByEvent.get(e.id) ?? null,
        currency: e.sessions[0]?.ticketTypes[0]?.currency ?? 'INR',
      })),
    };
  }
}
