/* eslint-disable no-console */
// Dedicated pilot fixture (Sprint 13). Creates an ISOLATED "Offline Pilot" event with
// its own session + a pool of ACTIVE tickets, so the live-pilot simulation never
// competes with the shared seed tickets used by other drills. Idempotent + additive:
// re-running ensures the event exists and tops up the active-ticket pool.

import { randomBytes } from 'node:crypto';
import { BookingStatus, EventStatus, FeeMode, PrismaClient, TicketStatus } from '@prisma/client';

const prisma = new PrismaClient();
const rid = (n = 6) => randomBytes(n).toString('hex').toUpperCase();
const PILOT_SLUG = 'offline-pilot';
const TARGET_ACTIVE = 16;

async function main() {
  const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!org) throw new Error('No organization found — run the base seed first.');
  const venue = await prisma.venue.findFirst({ where: { organizationId: org.id } });
  const customer = await prisma.user.findFirst({ where: { email: 'customer1@eticketsgo.test' } });
  if (!customer) throw new Error('customer1 not found — run the base seed first.');

  // Ensure the pilot event + session + ticket type exist (idempotent).
  let event = await prisma.event.findFirst({ where: { slug: PILOT_SLUG } });
  let sessionId: string;
  let ticketTypeId: string;

  if (!event) {
    event = await prisma.event.create({
      data: {
        organizationId: org.id,
        venueId: venue?.id ?? null,
        title: 'Offline Pilot — Controlled Check-in',
        slug: PILOT_SLUG,
        category: 'Pilot',
        description: 'Dedicated fixture for the controlled offline check-in pilot simulation.',
        // DRAFT (not published) so the fixture stays ISOLATED — it never appears in
        // customer discovery/booking and cannot be picked up by unrelated e2e specs.
        // Offline check-in + activation do not depend on publish status (staff-scoped).
        status: EventStatus.DRAFT,
        feeMode: FeeMode.CUSTOMER_PAYS,
        refundPolicy: 'Pilot fixture — not a real sale.',
        publishedAt: null,
      },
    });
    const startsAt = new Date(Date.now() + 60 * 60_000);
    const session = await prisma.eventSession.create({
      data: { eventId: event.id, startsAt, endsAt: new Date(startsAt.getTime() + 3 * 3_600_000) },
    });
    sessionId = session.id;
    const tt = await prisma.ticketType.create({
      data: {
        eventSessionId: session.id,
        name: 'Pilot GA',
        priceMinor: 0,
        quantityTotal: 1000,
        maxPerOrder: 100,
        salesStartAt: new Date(),
        salesEndAt: new Date(startsAt.getTime() + 3 * 3_600_000),
        inventory: { create: { quantityTotal: 1000, quantitySold: 0, quantityHeld: 0 } },
      },
    });
    ticketTypeId = tt.id;
  } else {
    // Enforce isolation on re-run: keep the pilot event out of customer discovery.
    if (event.status !== EventStatus.DRAFT || event.publishedAt) {
      await prisma.event.update({
        where: { id: event.id },
        data: { status: EventStatus.DRAFT, publishedAt: null },
      });
    }
    const session = await prisma.eventSession.findFirst({ where: { eventId: event.id } });
    if (!session) throw new Error('Pilot event has no session.');
    sessionId = session.id;
    const tt = await prisma.ticketType.findFirst({ where: { eventSessionId: session.id } });
    if (!tt) throw new Error('Pilot session has no ticket type.');
    ticketTypeId = tt.id;
  }

  // Clean slate: wipe this session's offline operational state so every rehearsal starts
  // pristine (no leftover activations, revoked devices, reconciliation records, or
  // command-center alerts derived from a prior run). This is what makes the fixture truly
  // ISOLATED and the simulation deterministically re-runnable.
  await prisma.checkIn.deleteMany({ where: { eventSessionId: sessionId } });
  await prisma.offlineReconciliationRecord.deleteMany({ where: { eventSessionId: sessionId } });
  await prisma.offlineAlertAck.deleteMany({ where: { eventSessionId: sessionId } });
  await prisma.offlineActivation.deleteMany({ where: { eventSessionId: sessionId } });
  await prisma.checkInManifest.deleteMany({ where: { eventSessionId: sessionId } });
  await prisma.checkInDevice.deleteMany({ where: { eventId: event.id } });
  // Return any tickets consumed by a prior rehearsal to ACTIVE so the pool refreshes.
  await prisma.ticket.updateMany({
    where: { eventSessionId: sessionId, status: TicketStatus.CHECKED_IN },
    data: { status: TicketStatus.ACTIVE },
  });

  // Top up the ACTIVE ticket pool to the target.
  const activeCount = await prisma.ticket.count({
    where: { eventSessionId: sessionId, status: TicketStatus.ACTIVE },
  });
  const toCreate = Math.max(0, TARGET_ACTIVE - activeCount);

  if (toCreate > 0) {
    const booking = await prisma.booking.create({
      data: {
        organizationId: org.id,
        eventId: event.id,
        eventSessionId: sessionId,
        userId: customer.id,
        buyerName: customer.fullName,
        buyerEmail: customer.email,
        status: BookingStatus.CONFIRMED,
        feeMode: FeeMode.CUSTOMER_PAYS,
        subtotalMinor: 0,
        totalMinor: 0,
        holdExpiresAt: new Date(),
        confirmedAt: new Date(),
      },
    });
    for (let i = 0; i < toCreate; i++) {
      await prisma.ticket.create({
        data: {
          bookingId: booking.id,
          ticketTypeId,
          eventSessionId: sessionId,
          organizationId: org.id,
          serial: `PILOT-${rid()}`,
          nonce: rid(8),
          status: TicketStatus.ACTIVE,
          holderName: `Pilot Attendee ${activeCount + i + 1}`,
          holderEmail: customer.email,
        },
      });
    }
    await prisma.ticketInventory
      .update({ where: { ticketTypeId }, data: { quantitySold: { increment: toCreate } } })
      .catch(() => undefined);
  }

  const finalActive = await prisma.ticket.count({
    where: { eventSessionId: sessionId, status: TicketStatus.ACTIVE },
  });
  console.log(
    `Pilot fixture ready: event=${event.id} slug=${PILOT_SLUG} session=${sessionId} activeTickets=${finalActive}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
