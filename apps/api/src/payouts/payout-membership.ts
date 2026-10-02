import type { Prisma } from '@prisma/client';
import { SETTLEMENT_CLAIMED_STATUSES } from './payouts.service';

/**
 * Who, if anyone, has already claimed one event's revenue.
 *
 * ── THE QUESTION THIS EXISTS TO ANSWER SAFELY ──────────────────────────────────────
 * Before anything may release an event's money - RETURN_TO_PLATFORM being the case this was built
 * for - somebody has to establish that no settlement path already paid it out. Getting that wrong
 * pays twice.
 *
 * The dangerous answer is not "claimed". It is a confident "not claimed" produced by looking for
 * allocations, finding none, and concluding the money is free. A payout raised before allocations
 * existed has none, and may well cover the event in question. So there is no NOT_CLAIMED that can
 * be reached by absence of evidence alone: a legacy payout whose period overlaps the event yields
 * UNKNOWN_LEGACY, which is not a release permission.
 *
 *   CLAIMED_BY_PROVIDER   a provider transfer owns it. The platform ledger excludes it.
 *   CLAIMED_BY_PAYOUT     a platform payout names this event in its allocations. Proven.
 *   UNKNOWN_LEGACY        a payout without allocations could cover it. NOT a no.
 *   NOT_CLAIMED           proven free: every payout that could cover it records what it covers.
 *
 * ── WHY LEGACY CANNOT BE NARROWED ──────────────────────────────────────────────────
 * A legacy payout stores a period and a total, and nothing about which bookings produced it. Its
 * membership could be reconstructed only by re-running the generator's query against today's
 * data, which answers a different question than the one the payout was raised from. That is
 * inventing evidence, so it is not done.
 */

export type EventMembership =
  | { kind: 'CLAIMED_BY_PROVIDER'; settlementIds: string[] }
  | { kind: 'CLAIMED_BY_PAYOUT'; payoutIds: string[] }
  | { kind: 'UNKNOWN_LEGACY'; payoutIds: string[] }
  | { kind: 'NOT_CLAIMED' };

/** Only the client surface this needs, so a transaction client is accepted unchanged. */
export interface MembershipReader {
  settlement: {
    findMany(args: unknown): Promise<Array<{ id: string }>>;
  };
  payoutAllocation: {
    findMany(args: unknown): Promise<Array<{ payoutId: string }>>;
  };
  payout: {
    findMany(args: unknown): Promise<Array<{ id: string }>>;
  };
}

export interface MembershipQuery {
  organizationId: string;
  eventId: string;
  /**
   * When the event's revenue could have been settled - normally the event's own window.
   *
   * Used ONLY to decide which legacy payouts might overlap it. It never narrows a legacy payout
   * to a definite answer; it bounds which ones are candidates for uncertainty.
   */
  revenueFrom: Date;
  revenueTo: Date;
}

/**
 * Whether this event's money is already claimed, and by whom.
 *
 * Ordered so the strongest evidence wins: a provider transfer is authoritative over the platform
 * ledger, which is the boundary `SETTLEMENT_CLAIMED_STATUSES` draws inside the generator. Then a
 * proven allocation. Then, only if neither applies, the legacy question.
 */
export async function eventMembership(
  client: MembershipReader,
  query: MembershipQuery,
): Promise<EventMembership> {
  /*
    ── 1. THE PROVIDER PATH FIRST ────────────────────────────────────────────────────
    The same statuses the payout generator excludes. If a transfer has claimed this event, the
    platform ledger never included it, so looking for a platform allocation would correctly find
    nothing and that absence would mean the opposite of free.
  */
  const claimed = await client.settlement.findMany({
    where: {
      eventId: query.eventId,
      status: { in: SETTLEMENT_CLAIMED_STATUSES as never[] },
    },
    select: { id: true },
  });
  if (claimed.length > 0) {
    return { kind: 'CLAIMED_BY_PROVIDER', settlementIds: claimed.map((s) => s.id) };
  }

  // ── 2. a proven platform claim ──────────────────────────────────────────────────
  const allocations = await client.payoutAllocation.findMany({
    where: { eventId: query.eventId },
    select: { payoutId: true },
  });
  if (allocations.length > 0) {
    return {
      kind: 'CLAIMED_BY_PAYOUT',
      payoutIds: [...new Set(allocations.map((a) => a.payoutId))].sort(),
    };
  }

  /*
    ── 3. THE ANSWER THAT MUST NOT BE "NO" ───────────────────────────────────────────
    Any payout without allocations whose period could contain this event's revenue. A null
    periodStart means "from the beginning", so it overlaps anything up to its periodEnd - and a
    payout with neither bound is a candidate for everything, which is the honest reading of a row
    that records no boundaries at all.
  */
  const legacy = await client.payout.findMany({
    where: {
      organizationId: query.organizationId,
      allocatedFrom: null,
      AND: [
        { OR: [{ periodStart: null }, { periodStart: { lte: query.revenueTo } }] },
        { OR: [{ periodEnd: null }, { periodEnd: { gte: query.revenueFrom } }] },
      ],
    },
    select: { id: true },
  });
  if (legacy.length > 0) {
    return { kind: 'UNKNOWN_LEGACY', payoutIds: legacy.map((p) => p.id).sort() };
  }

  return { kind: 'NOT_CLAIMED' };
}

/**
 * Whether an event's revenue may be released by an automated process.
 *
 * True ONLY for a proven absence of any claim. UNKNOWN_LEGACY is deliberately false: it means
 * nobody knows, and "nobody knows" has to read as "do not touch it" wherever money moves. A
 * person with the records in front of them may still decide otherwise - this answers what may be
 * automated, not what is true.
 */
export function mayRelease(membership: EventMembership): boolean {
  return membership.kind === 'NOT_CLAIMED';
}

/** A Prisma `where` selecting the legacy payouts that make an organization's scope uncertain. */
export function legacyPayoutWhere(organizationId: string): Prisma.PayoutWhereInput {
  return { organizationId, allocatedFrom: null };
}
