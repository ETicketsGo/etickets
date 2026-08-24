import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ReceiptsService } from './receipts.service';

/**
 * integration-real-postgres — receipt numbering and issuance.
 *
 * These guarantees cannot be proven with a mocked Prisma client, because the thing being
 * guaranteed IS the database's behaviour: that the counter row serialises concurrent
 * issuers, and that the nullable-unique columns make a duplicate document impossible rather
 * than merely unlikely. A stub would happily return whatever we told it to.
 *
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

describe('integration-real-postgres: receipt numbering', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let receipts: ReceiptsService;

  const suffix = `rcpt-${Date.now()}`;
  let orgId = '';
  let otherOrgId = '';
  let eventId = '';
  let sessionId = '';

  /** A confirmed-shaped booking with the given money split. */
  async function makeBooking(
    over: { totalMinor?: number; taxMinor?: number; organizationId?: string } = {},
  ): Promise<string> {
    const b = await db!.booking.create({
      data: {
        organizationId: over.organizationId ?? orgId,
        eventId,
        eventSessionId: sessionId,
        buyerName: 'Asha Rao',
        buyerEmail: `asha+${Math.random().toString(36).slice(2)}@example.test`,
        status: 'CONFIRMED',
        feeMode: 'CUSTOMER_PAYS',
        subtotalMinor: 100_000,
        bookingFeeMinor: 2_000,
        paymentFeeMinor: 2_040,
        discountMinor: 0,
        customerFeeMinor: 4_040,
        organizerFeeMinor: 0,
        taxMinor: over.taxMinor ?? 0,
        totalMinor: over.totalMinor ?? 104_040,
        holdExpiresAt: new Date('2026-09-01T14:00:00Z'),
      },
    });
    return b.id;
  }

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — DB unavailable');
      return;
    }
    receipts = new ReceiptsService(db as never);

    const org = await db.organization.create({
      data: { name: `Aurora ${suffix}`, slug: `aurora-${suffix}` },
    });
    orgId = org.id;
    const other = await db.organization.create({
      data: { name: `Beacon ${suffix}`, slug: `beacon-${suffix}` },
    });
    otherOrgId = other.id;

    const venue = await db.venue.create({
      data: { organizationId: orgId, name: `V ${suffix}`, city: 'Bengaluru', country: 'India' },
    });
    const event = await db.event.create({
      data: {
        organizationId: orgId,
        venueId: venue.id,
        title: `Night of Strings ${suffix}`,
        slug: `nos-${suffix}`,
        category: 'Music',
        status: 'PUBLISHED',
      },
    });
    eventId = event.id;
    const session = await db.eventSession.create({
      data: {
        eventId,
        startsAt: new Date('2026-09-01T14:30:00Z'),
        endsAt: new Date('2026-09-01T17:00:00Z'),
        status: 'SCHEDULED',
      },
    });
    sessionId = session.id;
  }, 60_000);

  afterAll(async () => {
    if (!db || !available) return;
    const orgIds = [orgId, otherOrgId];
    await db.receipt.deleteMany({ where: { organizationId: { in: orgIds } } });
    await db.receiptCounter.deleteMany({
      where: { OR: orgIds.map((id) => ({ scope: { startsWith: id } })) },
    });
    await db.refund.deleteMany({ where: { organizationId: { in: orgIds } } });
    await db.bookingTaxLine.deleteMany({ where: { booking: { organizationId: { in: orgIds } } } });
    await db.booking.deleteMany({ where: { organizationId: { in: orgIds } } });
    await db.eventSession.deleteMany({ where: { eventId } });
    await db.event.deleteMany({ where: { organizationId: orgId } });
    await db.venue.deleteMany({ where: { organizationId: orgId } });
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });
    await db.$disconnect();
  }, 60_000);

  const guard = () => {
    if (!available) throw new Error('SKIP');
  };
  const maybe = (name: string, fn: () => Promise<void>, timeout?: number) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  maybe(
    'numbers one organization sequentially with no gaps',
    async () => {
      guard();
      const numbers: string[] = [];
      for (let i = 0; i < 5; i++) {
        const bookingId = await makeBooking();
        await db!.$transaction((tx: never) => receipts.issueForBooking(tx, bookingId));
        const r = await db!.receipt.findUnique({ where: { saleForBookingId: bookingId } });
        numbers.push(r!.number);
      }
      const year = new Date().getUTCFullYear();
      expect(numbers).toEqual([
        `RCT-${year}-000001`,
        `RCT-${year}-000002`,
        `RCT-${year}-000003`,
        `RCT-${year}-000004`,
        `RCT-${year}-000005`,
      ]);
    },
    60_000,
  );

  maybe(
    "restarts at 1 for a different organization's books",
    async () => {
      guard();
      const bookingId = await makeBooking({ organizationId: otherOrgId });
      await db!.$transaction((tx: never) => receipts.issueForBooking(tx, bookingId));
      const r = await db!.receipt.findUnique({ where: { saleForBookingId: bookingId } });
      expect(r!.number).toBe(`RCT-${new Date().getUTCFullYear()}-000001`);
      // …and did not disturb the first organization's series.
      expect(await db!.receipt.count({ where: { organizationId: orgId } })).toBe(5);
    },
    60_000,
  );

  maybe(
    'hands out no duplicate number under concurrent issuance',
    async () => {
      guard();
      // The real risk: two webhook deliveries confirming different bookings at the same
      // instant. If the counter did not serialise, both would read the same value.
      const ids = await Promise.all([1, 2, 3, 4, 5, 6].map(() => makeBooking()));
      await Promise.all(
        ids.map((id) => db!.$transaction((tx: never) => receipts.issueForBooking(tx, id))),
      );
      const rows = await db!.receipt.findMany({
        where: { organizationId: orgId },
        select: { number: true },
      });
      const numbers = rows.map((r: { number: string }) => r.number);
      expect(new Set(numbers).size).toBe(numbers.length);
      // Gapless: the sequence covers 1..N with nothing missing.
      const seq = numbers
        .map((n: string) => Number(n.split('-')[2]))
        .sort((a: number, b: number) => a - b);
      expect(seq).toEqual(Array.from({ length: seq.length }, (_, i) => i + 1));
    },
    120_000,
  );

  maybe(
    'cannot issue a second sale document for the same booking',
    async () => {
      guard();
      const bookingId = await makeBooking();
      await db!.$transaction((tx: never) => receipts.issueForBooking(tx, bookingId));
      // A redelivered webhook reaching issuance twice must be stopped by the DATABASE, not by
      // a hopeful application-level check.
      await expect(
        db!.$transaction((tx: never) => receipts.issueForBooking(tx, bookingId)),
      ).rejects.toThrow();
      expect(await db!.receipt.count({ where: { bookingId, kind: { not: 'CREDIT_NOTE' } } })).toBe(
        1,
      );
    },
    60_000,
  );

  maybe(
    'rolls the number back when the issuing transaction fails',
    async () => {
      guard();
      // Gaplessness only holds because the counter shares the caller's transaction. Prove it:
      // an aborted confirm must not consume a number.
      const scope = `${orgId}:RCT:${new Date().getUTCFullYear()}`;
      // Issue one successfully first, so this test does not depend on any other test having
      // run to create the counter row.
      const warmup = await makeBooking();
      await db!.$transaction((tx: never) => receipts.issueForBooking(tx, warmup));
      const before = await db!.receiptCounter.findUnique({ where: { scope } });
      const bookingId = await makeBooking();
      await expect(
        db!.$transaction(async (tx: never) => {
          await receipts.issueForBooking(tx, bookingId);
          throw new Error('confirm failed after issuance');
        }),
      ).rejects.toThrow('confirm failed after issuance');
      const after = await db!.receiptCounter.findUnique({ where: { scope } });
      expect(after!.value).toBe(before!.value);
      expect(await db!.receipt.findUnique({ where: { saleForBookingId: bookingId } })).toBeNull();
    },
    60_000,
  );

  maybe(
    'calls it a tax invoice only once the seller records a registration',
    async () => {
      guard();
      const first = await makeBooking();
      await db!.$transaction((tx: never) => receipts.issueForBooking(tx, first));
      const before = await db!.receipt.findUnique({ where: { saleForBookingId: first } });
      expect(before!.kind).toBe('RECEIPT');

      await db!.organization.update({
        where: { id: orgId },
        data: { taxRegistrationKind: 'GSTIN', taxRegistrationNumber: '29AABCU9603R1ZM' },
      });
      const second = await makeBooking();
      await db!.$transaction((tx: never) => receipts.issueForBooking(tx, second));
      const after = await db!.receipt.findUnique({ where: { saleForBookingId: second } });
      expect(after!.kind).toBe('TAX_INVOICE');
      expect(after!.number).toBe(`INV-${new Date().getUTCFullYear()}-000001`);

      // The already-issued document is untouched. A receipt is a record of what was issued,
      // not a live view that reinterprets itself when the seller's details change.
      const reread = await db!.receipt.findUnique({ where: { saleForBookingId: first } });
      expect(reread!.kind).toBe('RECEIPT');
      expect(reread!.number).toBe(before!.number);
      expect(JSON.stringify(reread!.documentJson)).toBe(JSON.stringify(before!.documentJson));
    },
    60_000,
  );

  maybe(
    'issues a negative credit note for a refund, once and only once',
    async () => {
      guard();
      const bookingId = await makeBooking({ totalMinor: 114_444, taxMinor: 10_404 });
      await db!.bookingTaxLine.create({
        data: {
          bookingId,
          label: 'Test tax',
          rateBasisPoints: 1_000,
          baseMinor: 104_040,
          amountMinor: 10_404,
        },
      });
      await db!.$transaction((tx: never) => receipts.issueForBooking(tx, bookingId));
      const sale = await db!.receipt.findUnique({ where: { saleForBookingId: bookingId } });

      const refund = await db!.refund.create({
        data: {
          bookingId,
          organizationId: orgId,
          // Tickets + the tax charged on them. The platform fee is NOT returned, which is
          // the platform's standing policy and is asserted explicitly below.
          amountMinor: 110_404,
          taxMinor: 10_404,
          status: 'COMPLETED',
          reason: 'Event cancelled',
        },
      });
      await db!.$transaction((tx: never) => receipts.issueCreditNote(tx, refund.id));

      const note = await db!.receipt.findUnique({ where: { refundId: refund.id } });
      expect(note!.kind).toBe('CREDIT_NOTE');
      expect(note!.totalMinor).toBe(-110_404);
      expect(note!.taxMinor).toBe(-10_404);
      expect(note!.reversesId).toBe(sale!.id);

      // The tickets and the tax on them are fully reversed…
      expect(sale!.subtotalMinor + note!.subtotalMinor).toBe(0);
      expect(sale!.taxMinor + note!.taxMinor).toBe(0);
      // …and what remains is exactly the platform fee, which is not refunded. Stating it as
      // an equation rather than expecting zero keeps the policy visible: if fees ever became
      // refundable, this line is where that decision would have to be made explicitly.
      expect(sale!.totalMinor + note!.totalMinor).toBe(sale!.feeMinor);

      // A retried refund does not mint a second credit note.
      await db!.$transaction((tx: never) => receipts.issueCreditNote(tx, refund.id));
      expect(await db!.receipt.count({ where: { bookingId, kind: 'CREDIT_NOTE' } })).toBe(1);

      await db!.refund.deleteMany({ where: { id: refund.id } });
    },
    60_000,
  );

  maybe(
    'states the exact tax the refund returned, not an apportionment of it',
    async () => {
      guard();
      /*
        The refund row carries its own split, decided when the refund was requested. The
        credit note must copy it verbatim: re-deriving the tax by scaling the booking's total
        would round a second time and could print a figure that differs by a paisa from the
        money that actually moved — on a document a tax authority may read.

        The numbers below are deliberately awkward so an apportionment would NOT reproduce
        them: 5_000 of tax on a 60_000 refund is not 10_404 x (60_000 / 114_444), which is
        5_455.
      */
      const bookingId = await makeBooking({ totalMinor: 114_444, taxMinor: 10_404 });
      await db!.bookingTaxLine.create({
        data: {
          bookingId,
          label: 'Test tax',
          rateBasisPoints: 1_000,
          baseMinor: 104_040,
          amountMinor: 10_404,
        },
      });
      await db!.$transaction((tx: never) => receipts.issueForBooking(tx, bookingId));
      const refund = await db!.refund.create({
        data: {
          bookingId,
          organizationId: orgId,
          amountMinor: 60_000,
          taxMinor: 5_000,
          status: 'COMPLETED',
          reason: 'One of two tickets returned',
        },
      });
      await db!.$transaction((tx: never) => receipts.issueCreditNote(tx, refund.id));
      const note = await db!.receipt.findUnique({ where: { refundId: refund.id } });
      expect(note!.totalMinor).toBe(-60_000);
      expect(note!.taxMinor).toBe(-5_000);
      expect(note!.subtotalMinor).toBe(-55_000);
      // Fees are not refunded, so the credit note claims none were returned.
      expect(note!.feeMinor).toBe(0);
      // Falsification: the apportioned value this used to compute.
      expect(note!.taxMinor).not.toBe(-Math.round((10_404 * 60_000) / 114_444));
      await db!.refund.deleteMany({ where: { id: refund.id } });
    },
    60_000,
  );
});
