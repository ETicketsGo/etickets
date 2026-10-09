import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Role } from '@eticketsgo/shared-types';
import { EventAttendeesService, EXPORT_CHUNK } from './event-attendees.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AuditService } from '../audit/audit.service';
import type { AttendeeFilter } from './event-attendees.query';
import type { RequestUser } from '../common/decorators';

/**
 * integration-real-postgres - the organizer's attendee list and its CSV export.
 *
 * ── WHAT THIS PROVES ───────────────────────────────────────────────────────────────
 * Against a real Postgres, because the list is one raw-SQL UNION and nothing short of the
 * database can say whether it counts, filters and pages correctly:
 *
 *   - 0, 1 and 100+ attendees, with refunded, partly refunded, cancelled, reserved-not-paid
 *     and abandoned (expired) bookings mixed in, each landing in the right state;
 *   - a free event has no payment column at all;
 *   - the export returns EXACTLY the rows the screen does, for the same filter;
 *   - a buyer's formula-shaped name is neutralised in the file;
 *   - a phone-only account's placeholder address never appears, and cannot be searched for;
 *   - another organization is refused, gate staff can read names but not contact details,
 *     and cannot export;
 *   - more than ten thousand rows export, every one exactly once, across chunk boundaries
 *     where every booking has the same timestamp (so the keyset tie-breakers carry the load);
 *   - every export is audited with its filter and count, and never with a person's data.
 *
 * Fixtures are uniquely named and removed afterwards; the database is shared.
 * Skips (never fabricates a pass) when no database is reachable.
 */
function loadDatabaseUrl(): string | undefined {
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
type Client = InstanceType<typeof PrismaClient>;

const PLACEHOLDER = 'phone+919800000001@users.eticketsgo.internal';
const EVIL_BUYER = '=HYPERLINK("http://evil.test","open me")';
const EVIL_HOLDER = '+SUM(1,2)';

describe('integration-real-postgres: organizer attendee list + CSV export', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let svc: EventAttendeesService;

  const tag = `att-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const orgIds: string[] = [];
  const userIds: string[] = [];

  let owner: RequestUser;
  let staff: RequestUser;
  let outsider: RequestUser;

  let paidEventId = '';
  let freeEventId = '';
  let emptyEventId = '';
  let bigEventId = '';
  let s1 = '';
  let s2 = '';
  let ga = '';
  let vip = '';
  let ga2 = '';
  let firstBulkRef = '';
  let firstBulkEmail = '';

  let serialN = 0;
  const serial = () => `${tag}-T${++serialN}`;

  async function makeUser(label: string): Promise<RequestUser> {
    const u = await db!.user.create({
      data: {
        email: `${label}-${tag}@test.invalid`,
        fullName: `${label} ${tag}`,
        passwordHash: 'x',
        roles: ['CUSTOMER'],
      },
    });
    userIds.push(u.id);
    return { id: u.id, email: u.email, fullName: u.fullName, roles: [Role.CUSTOMER] };
  }

  async function makeOrg(label: string) {
    const org = await db!.organization.create({
      data: { name: `${label} ${tag}`, slug: `${label}-${tag}`, status: 'APPROVED' },
    });
    orgIds.push(org.id);
    const venue = await db!.venue.create({
      data: {
        organizationId: org.id,
        name: `Hall ${tag}`,
        city: 'Vijayawada',
        country: 'India',
        timezone: 'Asia/Kolkata',
      },
    });
    return { orgId: org.id, venueId: venue.id };
  }

  async function makeEvent(orgId: string, venueId: string, label: string, isFree = false) {
    const e = await db!.event.create({
      data: {
        organizationId: orgId,
        venueId,
        title: `${label} ${tag}`,
        slug: `${label}-${tag}`,
        category: 'Concert',
        status: 'PUBLISHED',
        isFree,
      },
    });
    return e.id;
  }

  async function makeSession(eventId: string, startsAt: Date) {
    const s = await db!.eventSession.create({
      data: { eventId, startsAt, endsAt: new Date(startsAt.getTime() + 2 * 3_600_000) },
    });
    return s.id;
  }

  async function makeType(sessionId: string, name: string, priceMinor: number) {
    const t = await db!.ticketType.create({
      data: { eventSessionId: sessionId, name, priceMinor, quantityTotal: 20_000 },
    });
    return t.id;
  }

  interface BookingSpec {
    orgId: string;
    eventId: string;
    sessionId: string;
    ticketTypeId: string;
    status: string;
    buyerName: string;
    buyerEmail: string;
    reference?: string | null;
    paymentMethod?: 'ONLINE' | 'CASH';
    paymentStatus?: string;
    /** Ticket statuses to issue; empty means "no tickets yet" and a BookingItem line instead. */
    tickets: { status: string; holderName?: string; holderEmail?: string; seatLabel?: string }[];
    itemQuantity?: number;
  }

  async function makeBooking(spec: BookingSpec) {
    const b = await db!.booking.create({
      data: {
        organizationId: spec.orgId,
        eventId: spec.eventId,
        eventSessionId: spec.sessionId,
        buyerName: spec.buyerName,
        buyerEmail: spec.buyerEmail,
        reference: spec.reference ?? null,
        status: spec.status as never,
        paymentMethod: spec.paymentMethod ?? 'ONLINE',
        subtotalMinor: 1000,
        totalMinor: 1000,
        holdExpiresAt: new Date(Date.now() + 86_400_000),
        items: {
          create: [
            {
              kind: 'TICKET',
              ticketTypeId: spec.ticketTypeId,
              quantity: spec.itemQuantity ?? Math.max(spec.tickets.length, 1),
              unitPriceMinor: 1000,
              lineTotalMinor: 1000,
            },
          ],
        },
      },
    });
    if (spec.paymentStatus) {
      await db!.payment.create({
        data: { bookingId: b.id, status: spec.paymentStatus as never, amountMinor: 1000 },
      });
    }
    for (const t of spec.tickets) {
      await db!.ticket.create({
        data: {
          bookingId: b.id,
          ticketTypeId: spec.ticketTypeId,
          eventSessionId: spec.sessionId,
          organizationId: spec.orgId,
          serial: serial(),
          nonce: 'n',
          status: t.status as never,
          holderName: t.holderName ?? spec.buyerName,
          holderEmail: t.holderEmail ?? spec.buyerEmail,
          seatLabel: t.seatLabel ?? null,
        },
      });
    }
    return b.id;
  }

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db!.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - DB unavailable');
      return;
    }
    svc = new EventAttendeesService(
      db as never,
      new OrgAccessService(db as never),
      new AuditService(db as never),
    );

    owner = await makeUser('owner');
    staff = await makeUser('staff');
    outsider = await makeUser('outsider');

    const mine = await makeOrg('mine');
    const theirs = await makeOrg('theirs');
    await db!.organizationMember.createMany({
      data: [
        { organizationId: mine.orgId, userId: owner.id, role: 'ORGANIZER_OWNER' },
        { organizationId: mine.orgId, userId: staff.id, role: 'CHECKIN_STAFF' },
        { organizationId: theirs.orgId, userId: outsider.id, role: 'ORGANIZER_OWNER' },
      ],
    });

    emptyEventId = await makeEvent(mine.orgId, mine.venueId, 'empty');
    await makeSession(emptyEventId, new Date('2026-11-01T14:00:00Z'));

    // ── A free event with exactly one attendee ──
    freeEventId = await makeEvent(mine.orgId, mine.venueId, 'free', true);
    const fs1 = await makeSession(freeEventId, new Date('2026-11-01T14:00:00Z'));
    const fType = await makeType(fs1, 'Free entry', 0);
    await makeBooking({
      orgId: mine.orgId,
      eventId: freeEventId,
      sessionId: fs1,
      ticketTypeId: fType,
      status: 'CONFIRMED',
      buyerName: 'Only Guest',
      buyerEmail: `only-${tag}@test.invalid`,
      reference: `${tag}-FREE-1`,
      tickets: [{ status: 'ACTIVE' }],
    });

    // ── A paid event: 100 straightforward attendees, then every awkward case ──
    paidEventId = await makeEvent(mine.orgId, mine.venueId, 'paid');
    s1 = await makeSession(paidEventId, new Date('2026-11-01T14:00:00Z')); // 19:30 IST
    s2 = await makeSession(paidEventId, new Date('2026-11-02T14:00:00Z'));
    ga = await makeType(s1, 'General', 50_000);
    vip = await makeType(s1, 'VIP', 150_000);
    ga2 = await makeType(s2, 'General day 2', 50_000);

    // 100 confirmed single-ticket bookings in bulk; the first ten are checked in.
    const bulk = Array.from({ length: 100 }, (_, i) => ({
      id: `${tag}-b${i}`,
      organizationId: mine.orgId,
      eventId: paidEventId,
      eventSessionId: s1,
      buyerName: `Bulk Buyer ${i}`,
      buyerEmail: `bulk${i}-${tag}@test.invalid`,
      reference: `${tag}-REF-${i}`,
      status: 'CONFIRMED' as never,
      subtotalMinor: 50_000,
      totalMinor: 50_000,
      holdExpiresAt: new Date(),
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)),
    }));
    firstBulkRef = bulk[0].reference;
    firstBulkEmail = bulk[0].buyerEmail;
    await db!.booking.createMany({ data: bulk });
    await db!.payment.createMany({
      data: bulk.map((b) => ({ bookingId: b.id, status: 'SUCCEEDED' as never, amountMinor: 1 })),
    });
    await db!.ticket.createMany({
      data: bulk.map((b, i) => ({
        id: `${b.id}-t`,
        bookingId: b.id,
        ticketTypeId: ga,
        eventSessionId: s1,
        organizationId: mine.orgId,
        serial: serial(),
        nonce: 'n',
        status: (i < 10 ? 'CHECKED_IN' : 'ACTIVE') as never,
        holderName: b.buyerName,
        holderEmail: b.buyerEmail,
      })),
    });
    await db!.checkIn.createMany({
      data: bulk.slice(0, 10).map((b) => ({
        ticketId: `${b.id}-t`,
        eventSessionId: s1,
        result: 'SUCCESS' as never,
      })),
    });

    const base = { orgId: mine.orgId, eventId: paidEventId };
    // Refunded in full: two tickets, both REFUNDED.
    await makeBooking({
      ...base,
      sessionId: s1,
      ticketTypeId: vip,
      status: 'REFUNDED',
      buyerName: 'Refunded Rao',
      buyerEmail: `refunded-${tag}@test.invalid`,
      reference: `${tag}-REFUNDED`,
      paymentStatus: 'REFUNDED',
      tickets: [{ status: 'REFUNDED' }, { status: 'REFUNDED' }],
    });
    // Partly refunded: one ticket back, one still coming.
    await makeBooking({
      ...base,
      sessionId: s2,
      ticketTypeId: ga2,
      status: 'PARTIALLY_REFUNDED',
      buyerName: 'Partial Prasad',
      buyerEmail: `partial-${tag}@test.invalid`,
      reference: `${tag}-PARTIAL`,
      paymentStatus: 'PARTIALLY_REFUNDED',
      tickets: [{ status: 'REFUNDED' }, { status: 'ACTIVE', holderName: 'Friend Of Prasad' }],
    });
    // Cancelled before it was ever confirmed: no tickets, three reserved.
    await makeBooking({
      ...base,
      sessionId: s1,
      ticketTypeId: vip,
      status: 'CANCELLED',
      buyerName: 'Cancelled Chandra',
      buyerEmail: `cancelled-${tag}@test.invalid`,
      tickets: [],
      itemQuantity: 3,
    });
    // A cash reservation not yet paid at the counter: no tickets, two reserved.
    await makeBooking({
      ...base,
      sessionId: s1,
      ticketTypeId: ga,
      status: 'PENDING_PAYMENT',
      paymentMethod: 'CASH',
      buyerName: 'Pending Padma',
      buyerEmail: `pending-${tag}@test.invalid`,
      tickets: [],
      itemQuantity: 2,
    });
    // An abandoned checkout: never a booking, never listed.
    await makeBooking({
      ...base,
      sessionId: s1,
      ticketTypeId: ga,
      status: 'EXPIRED',
      buyerName: 'Abandoned Anil',
      buyerEmail: `expired-${tag}@test.invalid`,
      tickets: [],
      itemQuantity: 4,
    });
    // A phone-only account: its address is a placeholder that must never be shown.
    await makeBooking({
      ...base,
      sessionId: s2,
      ticketTypeId: ga2,
      status: 'CONFIRMED',
      buyerName: 'Phone Only Priya',
      buyerEmail: PLACEHOLDER,
      reference: `${tag}-PHONE`,
      paymentStatus: 'SUCCEEDED',
      tickets: [{ status: 'ACTIVE' }],
    });
    // A buyer who typed a spreadsheet formula as their name, seated.
    await makeBooking({
      ...base,
      sessionId: s1,
      ticketTypeId: vip,
      status: 'CONFIRMED',
      buyerName: EVIL_BUYER,
      buyerEmail: `evil-${tag}@test.invalid`,
      reference: `${tag}-EVIL`,
      paymentStatus: 'SUCCEEDED',
      tickets: [{ status: 'ACTIVE', holderName: EVIL_HOLDER, seatLabel: 'A-1' }],
    });

    // ── Ten thousand and fifty attendees, every booking at the same instant ──
    bigEventId = await makeEvent(mine.orgId, mine.venueId, 'big');
    const bs = await makeSession(bigEventId, new Date('2026-12-01T14:00:00Z'));
    const bt = await makeType(bs, 'Stadium', 10_000);
    const sameInstant = new Date(Date.UTC(2026, 9, 2, 12, 0, 0));
    const BIG = 10_050;
    for (let start = 0; start < BIG; start += 2000) {
      const slice = Array.from({ length: Math.min(2000, BIG - start) }, (_, k) => start + k);
      await db!.booking.createMany({
        data: slice.map((i) => ({
          id: `${tag}-g${i}`,
          organizationId: mine.orgId,
          eventId: bigEventId,
          eventSessionId: bs,
          buyerName: `Fan ${i}`,
          buyerEmail: `fan${i}-${tag}@test.invalid`,
          reference: `${tag}-BIG-${i}`,
          status: 'CONFIRMED' as never,
          subtotalMinor: 10_000,
          totalMinor: 10_000,
          holdExpiresAt: sameInstant,
          createdAt: sameInstant,
        })),
      });
      await db!.ticket.createMany({
        data: slice.map((i) => ({
          bookingId: `${tag}-g${i}`,
          ticketTypeId: bt,
          eventSessionId: bs,
          organizationId: mine.orgId,
          serial: `${tag}-G${i}`,
          nonce: 'n',
          status: 'ACTIVE' as never,
          holderName: `Fan ${i}`,
        })),
      });
    }
  }, 600_000);

  afterAll(async () => {
    if (!db || !available) return;
    const orgFilter = { organizationId: { in: orgIds } };
    await db.auditLog.deleteMany({
      where: { OR: [orgFilter, { actorUserId: { in: userIds } }] },
    });
    await db.checkIn.deleteMany({ where: { ticket: orgFilter } });
    await db.ticket.deleteMany({ where: orgFilter });
    await db.payment.deleteMany({ where: { booking: orgFilter } });
    await db.bookingItem.deleteMany({ where: { booking: orgFilter } });
    await db.booking.deleteMany({ where: orgFilter });
    await db.ticketType.deleteMany({ where: { eventSession: { event: orgFilter } } });
    await db.eventSession.deleteMany({ where: { event: orgFilter } });
    await db.event.deleteMany({ where: orgFilter });
    await db.venue.deleteMany({ where: orgFilter });
    await db.organizationMember.deleteMany({ where: orgFilter });
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.$disconnect();
  }, 600_000);

  const maybe = (name: string, fn: () => Promise<void>, timeout = 120_000) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  /** Every row the screen shows for a filter, across all its pages. */
  async function screenRows(user: RequestUser, eventId: string, filter: AttendeeFilter) {
    const rows: Awaited<ReturnType<EventAttendeesService['list']>>['data'] = [];
    for (let page = 1; ; page += 1) {
      const res = await svc.list(user, eventId, filter, page, 100);
      rows.push(...res.data);
      if (page >= res.meta.totalPages) break;
    }
    return rows;
  }

  async function exportCsv(user: RequestUser, eventId: string, filter: AttendeeFilter) {
    const ctx = await svc.authorizeExport(user, eventId);
    let out = '';
    const count = await svc.writeExport(user, ctx, filter, async (chunk) => {
      out += chunk;
    });
    return { out, count };
  }

  /** Splits our own CSV (every cell quoted, CRLF rows) into cells. */
  function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') {
        row.push(cell);
        cell = '';
      } else if (c === '\r' && text[i + 1] === '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
        i += 1;
      } else cell += c;
    }
    return rows;
  }

  maybe('an event with nobody booked: zero rows, zero totals, a header-only file', async () => {
    const res = await svc.list(owner, emptyEventId, {}, 1, 25);
    expect(res.data).toEqual([]);
    expect(res.meta.total).toBe(0);
    expect(res.totals.tickets).toBe(0);
    const { out, count } = await exportCsv(owner, emptyEventId, {});
    expect(count).toBe(0);
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(parseCsv(out.slice(1))).toHaveLength(1);
  });

  maybe('a free event with one attendee has no payment, on screen or in the file', async () => {
    const res = await svc.list(owner, freeEventId, {}, 1, 25);
    expect(res.meta.total).toBe(1);
    expect(res.event.isFree).toBe(true);
    expect(res.data[0].payment).toBeNull();
    expect(res.data[0].buyerName).toBe('Only Guest');
    const { out } = await exportCsv(owner, freeEventId, {});
    const [header, line] = parseCsv(out.slice(1));
    expect(header).not.toContain('Payment');
    expect(line[header.indexOf('Booking status')]).toBe('Confirmed');
    expect(line).toHaveLength(header.length);
  });

  maybe('100 attendees with every awkward case mixed in are counted by state', async () => {
    const res = await svc.list(owner, paidEventId, {}, 1, 25);
    // 100 bulk + partial's live ticket + phone-only + evil = 103 confirmed tickets.
    expect(res.totals.byStatus.CONFIRMED).toEqual({ rows: 103, tickets: 103, checkedIn: 10 });
    // Two from the refunded booking, one from the partly refunded one.
    expect(res.totals.byStatus.REFUNDED).toEqual({ rows: 3, tickets: 3, checkedIn: 0 });
    // Cancelled before confirmation: one line, three places.
    expect(res.totals.byStatus.CANCELLED).toEqual({ rows: 1, tickets: 3, checkedIn: 0 });
    // The unpaid cash reservation: one line, two places. The expired hold is nowhere.
    expect(res.totals.byStatus.PENDING).toEqual({ rows: 1, tickets: 2, checkedIn: 0 });
    expect(res.meta.total).toBe(108);
    expect(res.totals.tickets).toBe(111);
    expect(res.meta.totalPages).toBe(5);
    expect(res.data).toHaveLength(25);

    const everyone = await screenRows(owner, paidEventId, {});
    expect(everyone).toHaveLength(108);
    expect(new Set(everyone.map((r) => r.id)).size).toBe(108);
    expect(everyone.some((r) => r.buyerName === 'Abandoned Anil')).toBe(false);
    const pending = everyone.find((r) => r.buyerName === 'Pending Padma')!;
    expect(pending).toMatchObject({ status: 'PENDING', quantity: 2, payment: 'CASH_DUE' });
    expect(pending.ticketId).toBeNull();
    const evil = everyone.find((r) => r.reference === `${tag}-EVIL`)!;
    expect(evil.seatLabel).toBe('A-1');
    expect(evil.sessionLabel).toContain('19:30');
    expect(evil.timeZone).toBe('Asia/Kolkata');
  });

  maybe('each filter narrows the list, and totals follow the current filter', async () => {
    const confirmed = await svc.list(owner, paidEventId, { status: 'CONFIRMED' }, 1, 25);
    expect(confirmed.meta.total).toBe(103);
    // The chips still count the other states under the rest of the filter.
    expect(confirmed.totals.byStatus.REFUNDED.rows).toBe(3);

    expect((await svc.list(owner, paidEventId, { sessionId: s2 }, 1, 25)).meta.total).toBe(3);
    const vipOnly = await svc.list(owner, paidEventId, { ticketTypeId: vip }, 1, 25);
    expect(vipOnly.meta.total).toBe(4);
    expect(vipOnly.totals.byStatus.REFUNDED.rows).toBe(2);

    const inside = await svc.list(owner, paidEventId, { checkIn: 'checked_in' }, 1, 25);
    expect(inside.meta.total).toBe(10);
    expect(inside.data.every((r) => r.checkedIn && r.checkedInAt)).toBe(true);
    expect(
      (await svc.list(owner, paidEventId, { checkIn: 'not_checked_in' }, 1, 25)).meta.total,
    ).toBe(98);

    const byRef = await svc.list(owner, paidEventId, { q: firstBulkRef }, 1, 25);
    expect(byRef.data.map((r) => r.reference)).toEqual([firstBulkRef]);
    const byEmail = await svc.list(owner, paidEventId, { q: firstBulkEmail.toUpperCase() }, 1, 25);
    expect(byEmail.meta.total).toBe(1);
    expect(byEmail.data[0].buyerEmail).toBe(firstBulkEmail);

    // A LIKE wildcard is searched for literally, not as "anything".
    expect((await svc.list(owner, paidEventId, { q: '%' }, 1, 25)).meta.total).toBe(0);

    // Combined: session 1, General, not checked in, confirmed.
    const combo = await svc.list(
      owner,
      paidEventId,
      { sessionId: s1, ticketTypeId: ga, checkIn: 'not_checked_in', status: 'CONFIRMED' },
      1,
      25,
    );
    expect(combo.meta.total).toBe(90);
  });

  maybe('the export holds exactly the rows the screen shows, in the same order', async () => {
    const filters: AttendeeFilter[] = [
      {},
      { status: 'REFUNDED' },
      { status: 'PENDING' },
      { sessionId: s2 },
      { ticketTypeId: vip, status: 'CONFIRMED' },
      { checkIn: 'checked_in' },
      { q: 'bulk buyer 1' },
    ];
    for (const filter of filters) {
      const screen = await screenRows(owner, paidEventId, filter);
      const { out, count } = await exportCsv(owner, paidEventId, filter);
      const [header, ...lines] = parseCsv(out.slice(1));
      expect(count).toBe(screen.length);
      expect(lines).toHaveLength(screen.length);
      const ref = header.indexOf('Booking reference');
      const ser = header.indexOf('Ticket serial');
      const name = header.indexOf('Buyer name');
      expect(lines.map((l) => [l[ref], l[ser], l[name].replace(/^'/, '')])).toEqual(
        screen.map((r) => [r.reference ?? '', r.serial ?? '', r.buyerName]),
      );
    }
  });

  maybe('a formula typed as a name is neutralised in the file', async () => {
    const { out } = await exportCsv(owner, paidEventId, { q: tag + '-EVIL' });
    expect(out).toContain(`"'=HYPERLINK(""http://evil.test"",""open me"")"`);
    expect(out).toContain(`"'+SUM(1,2)"`);
    // And nowhere in the whole file does a cell begin with a live formula lead.
    const all = await exportCsv(owner, paidEventId, {});
    for (const line of parseCsv(all.out.slice(1))) {
      for (const cell of line) expect(/^[=+\-@\t\r]/.test(cell)).toBe(false);
    }
  });

  maybe('a phone-only placeholder address is never shown and cannot be searched for', async () => {
    const everyone = await screenRows(owner, paidEventId, {});
    const priya = everyone.find((r) => r.buyerName === 'Phone Only Priya')!;
    expect(priya.buyerEmail).toBeNull();
    expect(priya.attendeeEmail).toBeNull();
    expect(JSON.stringify(everyone)).not.toContain('users.eticketsgo.internal');

    const { out } = await exportCsv(owner, paidEventId, {});
    expect(out).toContain('Phone Only Priya');
    expect(out).not.toContain('users.eticketsgo.internal');

    for (const q of ['users.eticketsgo.internal', 'phone+9198', '9800000001']) {
      expect((await svc.list(owner, paidEventId, { q }, 1, 25)).meta.total).toBe(0);
    }
  });

  maybe('another organization is refused, and a missing event is a 404', async () => {
    await expect(svc.list(outsider, paidEventId, {}, 1, 25)).rejects.toMatchObject({
      status: 403,
    });
    await expect(svc.authorizeExport(outsider, paidEventId)).rejects.toMatchObject({
      status: 403,
    });
    await expect(svc.list(owner, `${tag}-missing`, {}, 1, 25)).rejects.toMatchObject({
      status: 404,
    });
  });

  maybe('gate staff read names but no contact details or payments, and cannot export', async () => {
    const res = await svc.list(staff, paidEventId, {}, 1, 100);
    expect(res.meta.total).toBe(108);
    expect(res.viewer).toEqual({ canSeeContact: false, canExport: false });
    for (const r of res.data) {
      expect(r.buyerEmail).toBeNull();
      expect(r.attendeeEmail).toBeNull();
      expect(r.attendeePhone).toBeNull();
      expect(r.payment).toBeNull();
    }
    // They cannot use the search box to confirm an address they are not shown.
    expect((await svc.list(staff, paidEventId, { q: firstBulkEmail }, 1, 25)).meta.total).toBe(0);
    // But they can find somebody by name or reference, which is what the door needs.
    expect((await svc.list(staff, paidEventId, { q: firstBulkRef }, 1, 25)).meta.total).toBe(1);

    await expect(svc.authorizeExport(staff, paidEventId)).rejects.toMatchObject({ status: 403 });
    expect((await svc.list(owner, paidEventId, {}, 1, 1)).viewer).toEqual({
      canSeeContact: true,
      canExport: true,
    });
  });

  maybe('every export is audited with its filter and count, never with anyone in it', async () => {
    const filter: AttendeeFilter = { status: 'CONFIRMED', sessionId: s1, q: 'Bulk Buyer 4' };
    const { count } = await exportCsv(owner, paidEventId, filter);
    const audit = await db!.auditLog.findFirst({
      where: { action: 'ATTENDEES_EXPORTED', entityId: paidEventId, actorUserId: owner.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.metadata).toMatchObject({
      format: 'csv',
      rowCount: count,
      completed: true,
      filter: { status: 'CONFIRMED', sessionId: s1, search: true },
    });
    const text = JSON.stringify(audit!.metadata);
    expect(text).not.toContain('Bulk Buyer');
    expect(text).not.toContain('@test.invalid');
  });

  maybe(
    'over ten thousand rows export once each across chunks that share one timestamp',
    async () => {
      const res = await svc.list(owner, bigEventId, {}, 1, 25);
      expect(res.meta.total).toBe(10_050);
      const { out, count } = await exportCsv(owner, bigEventId, {});
      expect(count).toBe(10_050);
      expect(count).toBeGreaterThan(EXPORT_CHUNK * 10);
      const [header, ...lines] = parseCsv(out.slice(1));
      const ser = header.indexOf('Ticket serial');
      expect(new Set(lines.map((l) => l[ser])).size).toBe(10_050);
      // A deep page off the screen is the same rows the file has at that position.
      const page = await svc.list(owner, bigEventId, {}, 300, 25);
      expect(page.data.map((r) => r.serial)).toEqual(
        lines.slice(299 * 25, 300 * 25).map((l) => l[ser]),
      );
    },
    300_000,
  );
});
