import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  eventSaleState,
  sessionSaleState,
  type EventSaleState,
  type SessionSaleState,
} from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { CinemaPricingPolicyService } from './cinema-pricing-policy.service';
import {
  memoizedResolver,
  sessionSaleEligibility,
  type SaleBlocker,
  type SessionSaleEligibility,
} from './sale-eligibility';

/** The cinema columns a pricing policy matches on. Shared by both reads below. */
const CINEMA_SELECT = {
  id: true,
  country: true,
  region: true,
  district: true,
  city: true,
  localBodyType: true,
  cinemaFormat: true,
  climateType: true,
  venue: { select: { country: true, region: true, city: true } },
} as const;

/** What a show sells. ACTIVE only: checkout refuses anything else before it prices it. */
const TICKET_TYPE_SELECT = {
  where: { status: 'ACTIVE' },
  select: {
    id: true,
    name: true,
    priceMinor: true,
    currency: true,
    seatCategory: { select: { name: true, regulatoryClass: true } },
  },
  orderBy: { priceMinor: 'asc' },
} as const;

/**
 * Everything checkout reads before it accepts a cart, for many shows in one query: the
 * organizer, the event, the show, each ACTIVE ticket type with its window and places, and
 * what the regulatory check needs (the same `CINEMA_SELECT`, the same ticket types in the same
 * order as `TICKET_TYPE_SELECT`).
 */
const SALE_STATE_SELECT = {
  id: true,
  eventId: true,
  status: true,
  startsAt: true,
  screenId: true,
  seatMapId: true,
  event: {
    select: {
      status: true,
      isFree: true,
      movie: { select: { id: true, status: true } },
      venue: { select: { country: true } },
      organization: { select: { status: true } },
    },
  },
  screen: { select: { cinema: { select: CINEMA_SELECT } } },
  ticketTypes: {
    where: { status: 'ACTIVE' },
    select: {
      id: true,
      name: true,
      priceMinor: true,
      currency: true,
      salesStartAt: true,
      salesEndAt: true,
      seatZoneId: true,
      seatCategory: { select: { name: true, regulatoryClass: true } },
      inventory: { select: { quantityTotal: true, quantitySold: true } },
    },
    orderBy: { priceMinor: 'asc' },
  },
  showZones: { select: { zoneId: true, capacity: true, sold: true } },
  _count: { select: { showSeats: true } },
} as const;

/** A show's unified sale state, with the regulatory verdict it was built from. */
export interface SessionSaleAnswer {
  state: SessionSaleState;
  /** Checkout's regulatory check alone, as `forSession` returns it. */
  eligibility: SessionSaleEligibility;
}

/** A blocker found on one or more of a cinema's shows. */
export interface CinemaSaleBlocker extends SaleBlocker {
  /** How many upcoming shows meet it. */
  affectedSessions: number;
}

export interface CinemaSaleEligibility {
  cinemaId: string;
  /** False when any upcoming show meets a blocker. */
  sellable: boolean;
  blockers: CinemaSaleBlocker[];
  /** How many upcoming shows were asked. Zero says nothing either way. */
  sessionsChecked: number;
}

/**
 * The database half of sale eligibility: load a show, or a cinema's upcoming shows, and ask
 * `sessionSaleEligibility` - the same rules checkout refuses a cart by.
 *
 * See `sale-eligibility.ts` for why this exists. This class decides nothing.
 */
@Injectable()
export class SaleEligibilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policies: CinemaPricingPolicyService,
  ) {}

  /** Whether one show can be sold online right now, and if not, what stops it. */
  async forSession(sessionId: string, at: Date = new Date()): Promise<SessionSaleEligibility> {
    const session = await this.prisma.eventSession.findUnique({
      where: { id: sessionId },
      select: {
        event: { select: { venue: { select: { country: true } } } },
        screen: { select: { cinema: { select: CINEMA_SELECT } } },
        ticketTypes: TICKET_TYPE_SELECT,
      },
    });
    if (!session) return { sellable: true, blockers: [], sellableTicketTypeIds: [] };
    return sessionSaleEligibility(
      memoizedResolver((ctx) => this.policies.resolve(ctx)),
      session.screen?.cinema ?? null,
      session.ticketTypes,
      session.event.venue?.country,
      at,
    );
  }

  /**
   * The unified sale state of each matching show: SELLING, PARTIAL or NOT_SELLING, with the
   * ticket types open and closed and the reasons, from the facts checkout refuses a cart by.
   *
   * The regulatory half is `sessionSaleEligibility` on exactly the inputs `forSession` gives it;
   * the rest (status, window, places, free-event prices) is read here and decided by the pure
   * `sessionSaleState` in shared-types. One memo for the whole call: many shows at one cinema
   * ask the same few policy questions.
   */
  async sessionStates(
    where: Prisma.EventSessionWhereInput,
    at: Date = new Date(),
  ): Promise<SessionSaleAnswer[]> {
    const sessions = await this.prisma.eventSession.findMany({
      where,
      select: SALE_STATE_SELECT,
      orderBy: { startsAt: 'asc' },
    });
    const resolve = memoizedResolver((ctx) => this.policies.resolve(ctx));
    const out: SessionSaleAnswer[] = [];
    for (const s of sessions) {
      const cinema = s.screen?.cinema ?? null;
      const eligibility = await sessionSaleEligibility(
        resolve,
        cinema,
        s.ticketTypes,
        s.event.venue?.country,
        at,
      );
      const zoneById = new Map(s.showZones.map((z) => [z.zoneId, z]));
      const state = sessionSaleState(
        {
          sessionId: s.id,
          eventId: s.eventId,
          organizationSuspended: s.event.organization?.status === 'SUSPENDED',
          eventStatus: s.event.status,
          film: s.event.movie,
          isFree: s.event.isFree,
          sessionStatus: s.status,
          startsAt: s.startsAt,
          seated: Boolean(s.screenId || s.seatMapId),
          seatCount: s._count.showSeats,
          ticketTypes: s.ticketTypes.map((t) => {
            /*
              Places left. A standing zone's own row is the authority checkout holds against;
              everything else keeps its count on the inventory row. A count that is missing or
              zero-sized is unknown, which is never read as sold out.
            */
            const zone = t.seatZoneId ? zoneById.get(t.seatZoneId) : undefined;
            const remaining = zone
              ? zone.capacity - zone.sold
              : t.inventory && t.inventory.quantityTotal > 0
                ? t.inventory.quantityTotal - t.inventory.quantitySold
                : null;
            return {
              id: t.id,
              name: t.name,
              priceMinor: t.priceMinor,
              salesStartAt: t.salesStartAt,
              salesEndAt: t.salesEndAt,
              zoned: Boolean(t.seatZoneId),
              remaining,
            };
          }),
          checkoutBlockers: eligibility.blockers,
          region: cinema?.region ?? cinema?.venue?.region ?? null,
        },
        at,
      );
      out.push({ state, eligibility });
    }
    return out;
  }

  /**
   * Each event's state over its upcoming shows: those not cancelled or ended and still to start.
   * An event that is not published, or whose organizer is suspended, is answered from that
   * alone - its shows are not read.
   */
  async eventStates(
    events: { id: string; status: string; organizationSuspended: boolean }[],
    at: Date = new Date(),
  ): Promise<EventSaleState[]> {
    const live = events.filter((e) => e.status === 'PUBLISHED' && !e.organizationSuspended);
    const answers = live.length
      ? await this.sessionStates(
          {
            eventId: { in: live.map((e) => e.id) },
            startsAt: { gt: at },
            status: { notIn: ['CANCELLED', 'COMPLETED'] },
          },
          at,
        )
      : [];
    const byEvent = new Map<string, SessionSaleState[]>();
    for (const a of answers) {
      const list = byEvent.get(a.state.eventId);
      if (list) list.push(a.state);
      else byEvent.set(a.state.eventId, [a.state]);
    }
    return events.map((e) =>
      eventSaleState({
        eventId: e.id,
        eventStatus: e.status,
        organizationSuspended: e.organizationSuspended,
        sessions: byEvent.get(e.id) ?? [],
      }),
    );
  }

  /**
   * Every upcoming show at one cinema, folded into one list of things to fix.
   *
   * Upcoming means what the readiness page already counts as upcoming: starting from now and
   * not cancelled. A paused show is included - it will resume, and finding out then that it
   * cannot sell is the failure this is here to prevent.
   */
  async forCinema(cinemaId: string, at: Date = new Date()): Promise<CinemaSaleEligibility> {
    const sessions = await this.prisma.eventSession.findMany({
      where: { screen: { cinemaId }, startsAt: { gte: at }, status: { not: 'CANCELLED' } },
      select: {
        id: true,
        event: { select: { venue: { select: { country: true } } } },
        screen: { select: { cinema: { select: CINEMA_SELECT } } },
        ticketTypes: TICKET_TYPE_SELECT,
      },
    });
    // One evaluation, one memo: a hundred shows in one place ask the same few questions.
    const resolve = memoizedResolver((ctx) => this.policies.resolve(ctx));

    const byKey = new Map<string, CinemaSaleBlocker>();
    for (const s of sessions) {
      const verdict = await sessionSaleEligibility(
        resolve,
        s.screen?.cinema ?? null,
        s.ticketTypes,
        s.event.venue?.country,
        at,
      );
      for (const b of verdict.blockers) {
        // Ticket type ids are per show and mean nothing across shows, so they are not kept.
        const key = [b.code, b.subject ?? '', b.organizerMessage].join('|');
        const seen = byKey.get(key);
        if (seen) seen.affectedSessions += 1;
        else byKey.set(key, { ...b, ticketTypeIds: [], affectedSessions: 1 });
      }
    }
    const blockers = [...byKey.values()];
    return {
      cinemaId,
      sellable: blockers.length === 0,
      blockers,
      sessionsChecked: sessions.length,
    };
  }
}
