import { Injectable } from '@nestjs/common';
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
