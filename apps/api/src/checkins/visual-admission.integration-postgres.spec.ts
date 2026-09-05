import { PrismaClient } from '@prisma/client';
import { CheckinsService } from './checkins.service';
import type { RequestUser } from '../common/decorators';

/**
 * Admitting a customer the way most Indian cinemas actually do it.
 *
 * ── WHAT THIS IS PROTECTING ────────────────────────────────────────────────────────
 * A visual admission and a scan differ in one thing: how the ticket was IDENTIFIED. Every
 * rule about whether it may be admitted — refunded, wrong session, already used, admitted by
 * another cinema's system — has to be identical, because two implementations of "may this
 * person come in" is how one of them quietly starts saying yes to something the other
 * refuses. These tests exist to make that divergence fail loudly.
 *
 * The one difference that MUST show up is in the record: `method`. A scan verifies a signed
 * token; a visual check verifies that somebody looked. Both admit a customer and only one of
 * them is proof, so a log that conflated them would assert an assurance half its rows do not
 * have.
 */
const prisma = new PrismaClient();

/*
  A REAL user id, resolved in beforeAll. `CheckIn.byUserId` is a foreign key — recording who
  admitted somebody is the point of the column, so a made-up actor is rejected by the database
  rather than quietly stored. That refusal is correct and this fixture respects it.
*/
const STAFF: RequestUser = {
  id: '',
  email: 'door@eticketsgo.test',
  roles: ['ORGANIZER_OWNER'],
} as RequestUser;

/** Membership is asserted elsewhere; here it always passes so the rules are what is tested. */
const access = { assertMember: async () => undefined } as never;
const audit = { record: async () => undefined } as never;
const notifications = { send: async () => undefined } as never;
const metrics = { recordCheckin: () => undefined, recordQrCheckin: () => undefined } as never;
const qr = { verify: () => ({ ticketId: 'x', nonce: 'x' }) } as never;

const service = new CheckinsService(prisma as never, qr, access, audit, notifications, metrics);

/*
  ── WHY THIS SUITE BUILDS ITS OWN TICKET ───────────────────────────────────────────
  It first reached for "any ACTIVE ticket in the database", which is a dependency on whatever
  the seed happens to contain and on whatever every other suite has done to it. It broke the
  moment nothing was ACTIVE — a failure that says nothing about the code under test.

  So it makes its own booking and ticket against an existing session, admits THAT, and deletes
  it afterwards. Nothing seeded is read, mutated or relied upon.
*/
let SESSION_ID = '';
let ORG_ID = '';
let TICKET_TYPE_ID = '';
const created: string[] = [];

async function freshTicket(seatLabel = 'A1'): Promise<{ id: string; eventSessionId: string }> {
  const suffix = `${Date.now()}${created.length}`;
  const booking = await prisma.booking.create({
    data: {
      organizationId: ORG_ID,
      eventId: (
        await prisma.eventSession.findUniqueOrThrow({
          where: { id: SESSION_ID },
          select: { eventId: true },
        })
      ).eventId,
      eventSessionId: SESSION_ID,
      status: 'CONFIRMED',
      buyerName: 'Visual Test',
      buyerEmail: 'visual@eticketsgo.test',
      currency: 'INR',
      subtotalMinor: 0,
      totalMinor: 0,
      holdExpiresAt: new Date(Date.now() + 3_600_000),
      reference: `VIS-${suffix}`,
    },
  });
  const ticket = await prisma.ticket.create({
    data: {
      bookingId: booking.id,
      ticketTypeId: TICKET_TYPE_ID,
      eventSessionId: SESSION_ID,
      organizationId: ORG_ID,
      serial: `TKT-VIS-${suffix}`,
      nonce: `n-${suffix}`,
      status: 'ACTIVE',
      seatLabel,
      holderName: 'Visual Test Holder',
    },
  });
  created.push(booking.id);
  return { id: ticket.id, eventSessionId: SESSION_ID };
}

beforeAll(async () => {
  const actor = await prisma.user.findFirst({ select: { id: true } });
  if (!actor) throw new Error('No users in the database; run the seed first.');
  STAFF.id = actor.id;

  const tt = await prisma.ticketType.findFirst({
    select: {
      id: true,
      eventSessionId: true,
      eventSession: { select: { event: { select: { organizationId: true } } } },
    },
  });
  if (!tt) throw new Error('No ticket type in the database; run the seed first.');
  TICKET_TYPE_ID = tt.id;
  SESSION_ID = tt.eventSessionId;
  ORG_ID = tt.eventSession.event.organizationId;
});

afterAll(async () => {
  // Bookings cascade to their tickets, and tickets cascade to their check-ins, so removing
  // the bookings this file created removes everything it wrote.
  await prisma.booking.deleteMany({ where: { id: { in: created } } });
  await prisma.$disconnect();
});

describe('admitting a ticket by eye', () => {
  it('admits it, and records that nobody scanned anything', async () => {
    const t = await freshTicket();
    const out = await service.admitVisually(STAFF, t.id);

    expect(out.result).toBe('SUCCESS');
    expect(out.message).toMatch(/visual/i);

    const log = await prisma.checkIn.findFirst({
      where: { ticketId: t.id },
      orderBy: { createdAt: 'desc' },
    });
    // The whole point. A row that said SCAN here would be a claim nobody made.
    expect(log?.method).toBe('VISUAL');
    expect(log?.result).toBe('SUCCESS');
    expect(log?.byUserId).toBe(STAFF.id);
  });

  it('refuses a ticket that has already been admitted, exactly as a scan would', async () => {
    const t = await freshTicket();
    await service.admitVisually(STAFF, t.id);
    const second = await service.admitVisually(STAFF, t.id);

    // Double admission is the failure a door check exists to prevent, and it must not become
    // possible simply because nobody held up a scanner.
    expect(second.result).toBe('DUPLICATE');
  });

  it('refuses a refunded ticket', async () => {
    const t = await freshTicket();
    await prisma.ticket.update({ where: { id: t.id }, data: { status: 'REFUNDED' } });
    const out = await service.admitVisually(STAFF, t.id);
    expect(out.result).toBe('CANCELLED');
  });

  it('refuses a ticket for a different session', async () => {
    const t = await freshTicket();
    const other = await prisma.eventSession.findFirst({
      where: { id: { not: t.eventSessionId } },
      select: { id: true },
    });
    if (!other) return; // single-session database; nothing to compare against
    const out = await service.admitVisually(STAFF, t.id, { expectedSessionId: other.id });
    expect(out.result).toBe('WRONG_SESSION');
  });

  it('refuses a seat another cinema admits, rather than marking it used here', async () => {
    /*
      The customer would be told they were checked in while the venue's own gate still refuses
      them — and our records would claim an admission that never happened. Reported as
      EXTERNAL, not INVALID: it is a genuine, paid ticket.
    */
    const t = await freshTicket();
    await prisma.ticket.update({
      where: { id: t.id },
      data: { vendorBarcode: 'PVR-VISUAL-TEST', vendorName: 'PVR Cinemas' },
    });
    const out = await service.admitVisually(STAFF, t.id);
    expect(out.result).toBe('EXTERNAL');
    const after = await prisma.ticket.findUnique({ where: { id: t.id } });
    // Not marked used here: the venue's own gate is what admits it.
    expect(after?.status).toBe('ACTIVE');
  });

  it('says so plainly when the ticket does not exist', async () => {
    const out = await service.admitVisually(STAFF, 'ckzzzzzzzzzzzzzzzzzzzzzzz');
    expect(out.result).toBe('INVALID');
  });
});

describe('finding the ticket in front of you', () => {
  it('matches on the seat, which is what staff read first', async () => {
    await freshTicket('Z9');
    const rows = await service.roster(STAFF, SESSION_ID, 'Z9');
    expect(rows.some((r) => r.seatLabel === 'Z9')).toBe(true);
  });

  it('matches on the booking reference, which is what a customer quotes', async () => {
    const t = await freshTicket('Y8');
    const ref = (
      await prisma.ticket.findUniqueOrThrow({
        where: { id: t.id },
        select: { booking: { select: { reference: true } } },
      })
    ).booking.reference!;
    const rows = await service.roster(STAFF, SESSION_ID, ref);
    expect(rows.some((r) => r.reference === ref)).toBe(true);
  });

  it('returns the session with no query, so a quiet door can just look', async () => {
    const t = await freshTicket();
    const rows = await service.roster(STAFF, t.eventSessionId);
    expect(rows.length).toBeGreaterThan(0);
    // Capped rather than paginated: past this, the answer is a better query.
    expect(rows.length).toBeLessThanOrEqual(50);
  });
});
