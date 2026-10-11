import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PayoutsService } from './payouts.service';

/**
 * Shared fixtures for the payout-scoping specs. Not a spec itself.
 *
 * Every world is two organizations with two events each, all finished (so payable with a zero
 * hold), plus one event that has NOT finished (so its money is held). Names carry a unique suffix
 * because the local database is shared with other engineers: a spec creates only its own rows and
 * removes exactly those.
 */
export function loadDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const p of ['../../../.env', '../../../../.env']) {
    try {
      const txt = readFileSync(resolve(__dirname, p), 'utf8');
      const m = txt.match(/^DATABASE_URL=(.*)$/m);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    } catch {
      /* try next */
    }
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PrismaClient } = require('@prisma/client');
export type Client = InstanceType<typeof PrismaClient>;

export function newClient(url: string): Client {
  return new PrismaClient({ datasources: { db: { url } } });
}

export function payoutsServiceFor(db: Client): PayoutsService {
  return new PayoutsService(
    db as never,
    { assertMember: async () => undefined } as never,
    { record: async () => undefined } as never,
    // Payable the moment a show ends, no minimum: these specs are about WHICH bookings count.
    {
      effectiveFor: async () => ({
        holdDays: 0,
        minPayoutMinor: {},
        source: { holdDays: 'default', minPayoutMinor: 'default' },
      }),
    } as never,
  );
}

export interface World {
  orgA: string;
  orgB: string;
  /** Finished events. */
  a1: string;
  a2: string;
  b1: string;
  b2: string;
  /** Org A's event that has not finished: its money is held. */
  aLive: string;
  sessions: Record<string, string>;
}

export async function makeWorld(db: Client, suffix: string): Promise<World> {
  const sessions: Record<string, string> = {};
  const org = async (tag: string) =>
    (
      await db.organization.create({
        data: { name: `Scope ${tag} ${suffix}`, slug: `scope-${tag}-${suffix}` },
      })
    ).id;
  const orgA = await org('a');
  const orgB = await org('b');

  const event = async (orgId: string, tag: string, finished: boolean) => {
    const venue = await db.venue.create({
      data: {
        organizationId: orgId,
        name: `V ${tag} ${suffix}`,
        city: 'Bengaluru',
        country: 'India',
      },
    });
    const ev = await db.event.create({
      data: {
        organizationId: orgId,
        venueId: venue.id,
        title: `Scope ${tag} ${suffix}`,
        slug: `scope-${tag}-${suffix}`,
        category: 'Music',
        status: finished ? 'COMPLETED' : 'PUBLISHED',
      },
    });
    const session = await db.eventSession.create({
      data: {
        eventId: ev.id,
        startsAt: new Date(Date.now() + (finished ? -90_000_000 : 86_400_000)),
        endsAt: new Date(Date.now() + (finished ? -86_400_000 : 90_000_000)),
        status: finished ? 'COMPLETED' : 'SCHEDULED',
      },
    });
    sessions[ev.id] = session.id;
    return ev.id;
  };

  return {
    orgA,
    orgB,
    a1: await event(orgA, 'a1', true),
    a2: await event(orgA, 'a2', true),
    aLive: await event(orgA, 'alive', false),
    b1: await event(orgB, 'b1', true),
    b2: await event(orgB, 'b2', true),
    sessions,
  };
}

export async function sell(
  db: Client,
  world: World,
  orgId: string,
  eventId: string,
  amounts: { subtotalMinor: number; discountMinor?: number; organizerFeeMinor?: number },
) {
  return db.booking.create({
    data: {
      organizationId: orgId,
      eventId,
      eventSessionId: world.sessions[eventId],
      buyerName: 'Asha Rao',
      buyerEmail: `asha+${Math.random().toString(36).slice(2)}@example.test`,
      status: 'CONFIRMED',
      paymentMethod: 'ONLINE',
      currency: 'INR',
      feeMode: 'CUSTOMER_PAYS',
      subtotalMinor: amounts.subtotalMinor,
      bookingFeeMinor: 0,
      paymentFeeMinor: 0,
      discountMinor: amounts.discountMinor ?? 0,
      customerFeeMinor: 0,
      organizerFeeMinor: amounts.organizerFeeMinor ?? 0,
      taxMinor: 0,
      totalMinor: amounts.subtotalMinor,
      holdExpiresAt: new Date(Date.now() - 120_000),
      confirmedAt: new Date(),
    },
  });
}

export async function refund(db: Client, orgId: string, bookingId: string, amountMinor: number) {
  return db.refund.create({
    data: {
      bookingId,
      organizationId: orgId,
      amountMinor,
      status: 'COMPLETED',
      reason: 'scoping-itest',
    },
  });
}

/** A provider settlement in a claimed status: the provider path owns this event's money. */
export async function claimWithProvider(db: Client, orgId: string, eventId: string) {
  return db.settlement.create({
    data: {
      organizationId: orgId,
      eventId,
      currency: 'inr',
      status: 'TRANSFERRED',
      provider: 'razorpay',
      grossSalesMinor: 100_000,
      payableMinor: 100_000,
      transferredMinor: 100_000,
      releasedMinor: 100_000,
      providerTransferId: `trf_${Math.random().toString(36).slice(2, 10)}`,
    },
  });
}

/** What the organizer is owed on a booking, by the arithmetic the schema documents. */
export const organizerShare = (b: {
  subtotalMinor: number;
  discountMinor: number;
  organizerFeeMinor: number;
}) => b.subtotalMinor - b.discountMinor - b.organizerFeeMinor;

export async function cleanWorld(db: Client, world: World) {
  const orgs = [world.orgA, world.orgB];
  await db.refund.deleteMany({ where: { organizationId: { in: orgs } } });
  await db.payout.deleteMany({ where: { organizationId: { in: orgs } } });
  await db.settlement.deleteMany({ where: { organizationId: { in: orgs } } });
  await db.booking.deleteMany({ where: { organizationId: { in: orgs } } });
  await db.eventSession.deleteMany({ where: { event: { organizationId: { in: orgs } } } });
  await db.event.deleteMany({ where: { organizationId: { in: orgs } } });
  await db.venue.deleteMany({ where: { organizationId: { in: orgs } } });
  await db.organization.deleteMany({ where: { id: { in: orgs } } });
}
