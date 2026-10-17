import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BusinessReportsService } from './business-reports.service';
import { AnalyticsService } from './analytics.service';
import { ReceiptsService } from '../receipts/receipts.service';
import { computeTax, type TaxRuleInput } from '../pricing/tax-calculator';
import { refundTaxForTickets, ticketNetPrices } from '../refunds/refund-tax';
import { INDIA_GST_RULES } from '../../prisma/india-gst-rules';

/**
 * integration-real-postgres - the admin "Tax charged" report reconciles to the documents.
 *
 * ── WHAT WAS WRONG ─────────────────────────────────────────────────────────────────
 * The report summed `BookingTaxLine` by the booking's confirmation date. That is the tax on
 * every sale ever confirmed in the range, and nothing else: a refund issues a credit note
 * that gives part of that tax back, and a cancelled counter cash sale issues one that gives
 * all of it back (#415), and the report saw neither. It overstated tax by every reversal.
 *
 * ── WHAT IT IS CHECKED AGAINST ────────────────────────────────────────────────────────
 * The issued documents themselves: each sale document and each credit note, issued here by
 * the REAL issuers (`issueForBooking`, `issueCreditNote`, `issueCancellationCreditNote`),
 * with tax lines priced by the REAL engine against the India rule table we ship. The report
 * must equal the sum of the sale documents' tax lines minus the credit notes' tax lines, to
 * the paisa, read by an independent SQL query in this file.
 *
 * The documents are dated in 2031 (the clock is moved for `Date` only) so that each case has
 * a window no other suite's rows can fall into: the report is platform-wide by design.
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

/** The shipped India rules, switched on, exactly as `seed-india-gst.ts --activate` writes them. */
const RULES: TaxRuleInput[] = INDIA_GST_RULES.map((r) => ({
  label: r.label,
  rateBasisPoints: r.rateBasisPoints,
  appliesTo: r.appliesTo,
  country: 'India',
  region: '*',
  currency: 'INR',
  taxGroup: r.taxGroup,
  category: r.category,
  minUnitMinor: r.minUnitMinor ?? null,
  maxUnitMinor: r.maxUnitMinor ?? null,
  priority: r.priority,
  inclusive: r.appliesTo === 'TICKETS',
  split: 'CGST_SGST',
  active: true,
}));

/** Only `Date` moves; every timer the Prisma client relies on stays real. */
const DATE_ONLY = {
  doNotFake: [
    'hrtime',
    'nextTick',
    'performance',
    'queueMicrotask',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'requestIdleCallback',
    'cancelIdleCallback',
    'setImmediate',
    'clearImmediate',
    'setInterval',
    'clearInterval',
    'setTimeout',
    'clearTimeout',
  ] as const,
};

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const endOf = (iso: string) => new Date(`${iso}T23:59:59.999Z`);

describe('integration-real-postgres: admin tax report nets credit notes', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let receipts: ReceiptsService;
  let reports: BusinessReportsService;

  const suffix = `taxrep-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let orgId = '';
  const venues: Record<'KA' | 'MH', string> = { KA: '', MH: '' };
  const events: Record<'KA' | 'MH', string> = { KA: '', MH: '' };
  const sessions: Record<'KA' | 'MH', string> = { KA: '', MH: '' };
  const types: Record<string, string> = {};
  let serial = 0;

  /** Run `fn` with the clock (Date only) at `at`. */
  async function at<T>(when: Date, fn: () => Promise<T>): Promise<T> {
    jest.useFakeTimers(DATE_ONLY as never);
    jest.setSystemTime(when);
    try {
      return await fn();
    } finally {
      jest.useRealTimers();
    }
  }

  /**
   * A confirmed sale priced by the real engine, and its sale document issued by the real
   * issuer at `when`.
   */
  async function sell(opts: {
    place: 'KA' | 'MH';
    when: Date;
    tickets: { type: string; priceMinor: number; quantity: number }[];
    category: string;
    cash?: boolean;
    /** The buyer's state, which is the place of supply for the platform fee. */
    customerRegion?: string;
  }): Promise<string> {
    const subtotalMinor = opts.tickets.reduce((s, t) => s + t.priceMinor * t.quantity, 0);
    const bookingFeeMinor = 2_000;
    const tax = computeTax({
      netSubtotalMinor: subtotalMinor,
      admissionLines: opts.tickets.map((t) => ({
        unitPriceMinor: t.priceMinor,
        quantity: t.quantity,
        category: opts.category,
      })),
      customerFeeMinor: bookingFeeMinor,
      rules: RULES,
      place: {
        country: 'India',
        region: opts.place === 'KA' ? 'Karnataka' : 'Maharashtra',
        supplierRegion: 'Karnataka',
        customerRegion: opts.customerRegion ?? 'Karnataka',
        platformRegion: 'Karnataka',
        currency: 'INR',
        at: opts.when,
      },
    });
    const booking = await db!.booking.create({
      data: {
        organizationId: orgId,
        eventId: events[opts.place],
        eventSessionId: sessions[opts.place],
        buyerName: 'Asha Rao',
        buyerEmail: `asha+${Math.random().toString(36).slice(2)}@example.test`,
        status: 'CONFIRMED',
        paymentMethod: opts.cash ? 'CASH' : 'ONLINE',
        feeMode: 'CUSTOMER_PAYS',
        currency: 'INR',
        subtotalMinor,
        bookingFeeMinor,
        paymentFeeMinor: 0,
        discountMinor: 0,
        customerFeeMinor: bookingFeeMinor,
        organizerFeeMinor: 0,
        taxMinor: tax.taxMinor,
        totalMinor: subtotalMinor + bookingFeeMinor + tax.taxAddedMinor,
        confirmedAt: opts.when,
        holdExpiresAt: opts.when,
        items: {
          create: opts.tickets.map((t) => ({
            ticketTypeId: types[t.type],
            quantity: t.quantity,
            unitPriceMinor: t.priceMinor,
            lineTotalMinor: t.priceMinor * t.quantity,
          })),
        },
        taxLines: {
          create: tax.taxLines.map((l) => ({
            label: l.label,
            rateBasisPoints: l.rateBasisPoints,
            baseMinor: l.baseMinor,
            amountMinor: l.amountMinor,
            basis: l.basis,
            inclusive: l.inclusive,
          })),
        },
      },
    });
    for (const t of opts.tickets) {
      for (let n = 0; n < t.quantity; n += 1) {
        serial += 1;
        await db!.ticket.create({
          data: {
            bookingId: booking.id,
            ticketTypeId: types[t.type],
            eventSessionId: sessions[opts.place],
            organizationId: orgId,
            serial: `${suffix}-${serial}`,
            nonce: 'n',
          },
        });
      }
    }
    await at(opts.when, () =>
      db!.$transaction((tx: never) => receipts.issueForBooking(tx, booking.id)),
    );
    return booking.id;
  }

  /**
   * A completed online refund of some of a booking's tickets, priced with the helpers the
   * refund service uses, and its credit note issued by the real issuer at `when`.
   */
  async function refund(
    bookingId: string,
    when: Date,
    opts: { ticketTypes?: string[]; cancellation?: boolean } = {},
  ): Promise<void> {
    const booking = await db!.booking.findUniqueOrThrow({
      where: { id: bookingId },
      include: { taxLines: true, items: true, tickets: true },
    });
    const wanted = opts.ticketTypes?.map((name) => types[name]);
    const ticketIds = booking.tickets
      .filter((t: { ticketTypeId: string }) => !wanted || wanted.includes(t.ticketTypeId))
      .map((t: { id: string }) => t.id);
    const { netByTicket, bookingTicketsMinor } = ticketNetPrices(
      booking.items,
      booking.tickets,
      booking,
    );
    const cancellation = opts.cancellation === true;
    const tax = refundTaxForTickets(booking.taxLines, netByTicket, ticketIds, bookingTicketsMinor, {
      includeFeeTax: cancellation,
    });
    const ticketsMinor = ticketIds.reduce(
      (s: number, id: string) => s + (netByTicket.get(id) ?? 0),
      0,
    );
    const feeMinor = cancellation ? booking.customerFeeMinor : 0;
    const created = await db!.refund.create({
      data: {
        bookingId,
        organizationId: orgId,
        amountMinor: ticketsMinor + feeMinor + tax.addedMinor,
        taxMinor: tax.taxMinor,
        taxAddedMinor: tax.addedMinor,
        platformFeeRefundedMinor: cancellation ? feeMinor + tax.addedMinor : 0,
        status: 'COMPLETED',
        reason: cancellation ? 'The show was cancelled.' : 'Buyer asked for a refund.',
        ticketIds,
        createdAt: when,
      },
    });
    await at(when, () => db!.$transaction((tx: never) => receipts.issueCreditNote(tx, created.id)));
  }

  /** A counter cash sale whose show was cancelled: voided, and reversed by a credit note. */
  async function cancelCash(bookingId: string, when: Date): Promise<void> {
    await at(when, () =>
      db!.$transaction(async (tx: Client) => {
        await tx.booking.update({ where: { id: bookingId }, data: { status: 'CANCELLED' } });
        await receipts.issueCancellationCreditNote(
          tx as never,
          bookingId,
          'The show was cancelled. The cash paid at the counter is given back at the venue.',
        );
      }),
    );
  }

  /** Independent of the report: every tax line on every document issued in the window. */
  async function documentTax(from: Date, to: Date) {
    const rows: { credit: boolean; amount: bigint | null }[] = await db!.$queryRaw`
      SELECT (r."kind" = 'CREDIT_NOTE') AS credit,
             SUM((line->>'amountMinor')::bigint) AS amount
      FROM "Receipt" r
      CROSS JOIN LATERAL jsonb_array_elements(r."documentJson"->'taxLines') AS line
      WHERE r."issuedAt" >= ${from} AND r."issuedAt" <= ${to} AND r."currency" = 'INR'
      GROUP BY 1
    `;
    const sum = (credit: boolean) => Number(rows.find((r) => r.credit === credit)?.amount ?? 0);
    return { sales: sum(false), creditNotes: sum(true) };
  }

  /** The tax on one booking's sale document, read from the document. */
  async function saleTax(bookingId: string): Promise<number> {
    const sale = await db!.receipt.findUniqueOrThrow({ where: { saleForBookingId: bookingId } });
    return (sale.documentJson as { taxLines: { amountMinor: number }[] }).taxLines.reduce(
      (s, l) => s + l.amountMinor,
      0,
    );
  }

  const inr = async (from: Date, to: Date) => {
    const r = await reports.tax(from, to);
    const block = r.byCurrency.find((c) => c.currency === 'INR');
    if (!block) throw new Error('no INR block in the tax report');
    return block;
  };

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - DB unavailable');
      return;
    }
    receipts = new ReceiptsService(db as never);
    reports = new BusinessReportsService(
      db as never,
      new AnalyticsService(db as never, {} as never, {} as never),
      {} as never,
    );

    const org = await db.organization.create({
      data: {
        name: `Walk Tax ${suffix}`,
        slug: `walk-tax-${suffix}`,
        taxRegistrationKind: 'GSTIN',
        taxRegistrationNumber: '29ABCDE1234F1Z5',
        registeredRegion: 'Karnataka',
      },
    });
    orgId = org.id;
    for (const place of ['KA', 'MH'] as const) {
      const venue = await db.venue.create({
        data: {
          organizationId: orgId,
          name: `V ${place} ${suffix}`,
          city: place === 'KA' ? 'Bengaluru' : 'Mumbai',
          country: 'India',
          region: place === 'KA' ? 'Karnataka' : 'Maharashtra',
        },
      });
      venues[place] = venue.id;
      const event = await db.event.create({
        data: {
          organizationId: orgId,
          venueId: venue.id,
          title: `Night ${place} ${suffix}`,
          slug: `night-${place.toLowerCase()}-${suffix}`,
          category: 'Music',
          status: 'PUBLISHED',
        },
      });
      events[place] = event.id;
      const session = await db.eventSession.create({
        data: {
          eventId: event.id,
          startsAt: new Date('2031-06-01T14:30:00Z'),
          endsAt: new Date('2031-06-01T17:00:00Z'),
          status: 'SCHEDULED',
        },
      });
      sessions[place] = session.id;
      for (const [name, priceMinor] of [
        ['Floor', 79_900],
        ['Balcony', 60_000],
        ['Front', 9_000],
      ] as const) {
        const tt = await db.ticketType.create({
          data: { eventSessionId: session.id, name, priceMinor, quantityTotal: 100 },
        });
        types[`${place}:${name}`] = tt.id;
      }
    }
  }, 60_000);

  afterAll(async () => {
    jest.useRealTimers();
    if (!db || !available) return;
    // Credit notes first: they point at the sale documents.
    await db.receipt.deleteMany({ where: { organizationId: orgId, kind: 'CREDIT_NOTE' } });
    await db.receipt.deleteMany({ where: { organizationId: orgId } });
    await db.receiptCounter.deleteMany({ where: { scope: { startsWith: orgId } } });
    await db.refund.deleteMany({ where: { organizationId: orgId } });
    await db.booking.deleteMany({ where: { organizationId: orgId } });
    await db.ticketType.deleteMany({ where: { eventSessionId: { in: Object.values(sessions) } } });
    await db.eventSession.deleteMany({ where: { id: { in: Object.values(sessions) } } });
    await db.event.deleteMany({ where: { organizationId: orgId } });
    await db.venue.deleteMany({ where: { organizationId: orgId } });
    await db.organization.deleteMany({ where: { id: orgId } });
    await db.$disconnect();
  }, 60_000);

  const guard = () => {
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] test skipped - DB unavailable');
      return false;
    }
    return true;
  };

  it('a sale with no refund: tax charged is the invoice, nothing reversed', async () => {
    if (!guard()) return;
    const id = await sell({
      place: 'KA',
      when: new Date('2031-03-02T10:00:00Z'),
      tickets: [{ type: 'KA:Floor', priceMinor: 79_900, quantity: 2 }],
      category: 'LIVE_PERFORMANCE',
    });
    const charged = await saleTax(id);
    expect(charged).toBeGreaterThan(0);

    const r = await inr(day('2031-03-02'), endOf('2031-03-02'));
    expect(r.taxChargedMinor).toBe(charged);
    expect(r.taxReversedMinor).toBe(0);
    expect(r.netTaxMinor).toBe(charged);
    expect(r.invoices).toBe(1);
    expect(r.creditNotes).toBe(0);
  });

  it('a full online refund in the same period nets the tax to zero', async () => {
    if (!guard()) return;
    const id = await sell({
      place: 'KA',
      when: new Date('2031-03-05T10:00:00Z'),
      tickets: [{ type: 'KA:Floor', priceMinor: 79_900, quantity: 2 }],
      category: 'LIVE_PERFORMANCE',
    });
    // A cancellation refund: every ticket, the fee, and the tax on the fee all go back.
    await refund(id, new Date('2031-03-06T09:00:00Z'), { cancellation: true });
    const charged = await saleTax(id);

    const r = await inr(day('2031-03-05'), endOf('2031-03-06'));
    expect(r.taxChargedMinor).toBe(charged);
    expect(r.taxReversedMinor).toBe(charged);
    expect(r.netTaxMinor).toBe(0);
    expect(r.creditNotes).toBe(1);
    // Every GST component nets to zero too, not only the total.
    for (const row of r.breakdown) expect(row.netMinor).toBe(0);
  });

  it('a refund in a later period: the charge stays in period 1, the reversal lands in period 2', async () => {
    if (!guard()) return;
    const id = await sell({
      place: 'KA',
      when: new Date('2031-04-28T10:00:00Z'),
      tickets: [{ type: 'KA:Floor', priceMinor: 79_900, quantity: 1 }],
      category: 'LIVE_PERFORMANCE',
    });
    await refund(id, new Date('2031-05-03T09:00:00Z'), { cancellation: true });
    const charged = await saleTax(id);

    // Period 1: the end of April, which holds the sale and nothing else.
    const april = await inr(day('2031-04-28'), endOf('2031-04-30'));
    expect(april.taxChargedMinor).toBe(charged);
    expect(april.taxReversedMinor).toBe(0);
    expect(april.netTaxMinor).toBe(charged);

    const may = await inr(day('2031-05-01'), endOf('2031-05-03'));
    expect(may.taxChargedMinor).toBe(0);
    expect(may.taxReversedMinor).toBe(charged);
    expect(may.netTaxMinor).toBe(-charged);

    // One range over both months: each month on its own row, and the total nets.
    const both = await inr(day('2031-04-28'), endOf('2031-05-03'));
    expect(both.netTaxMinor).toBe(0);
    expect(both.byMonth).toEqual([
      { month: '2031-04', chargedMinor: charged, reversedMinor: 0, netMinor: charged },
      { month: '2031-05', chargedMinor: 0, reversedMinor: charged, netMinor: -charged },
    ]);
  });

  it('a partial refund reverses only the returned tickets tax', async () => {
    if (!guard()) return;
    const id = await sell({
      place: 'KA',
      when: new Date('2031-06-10T10:00:00Z'),
      tickets: [
        { type: 'KA:Floor', priceMinor: 79_900, quantity: 1 },
        { type: 'KA:Balcony', priceMinor: 60_000, quantity: 2 },
      ],
      category: 'LIVE_PERFORMANCE',
      // A buyer in Kerala, so the fee's GST is IGST and stays on a row of its own.
      customerRegion: 'Kerala',
    });
    // The buyer returns the two balcony seats; the fee and its tax stay.
    await refund(id, new Date('2031-06-11T09:00:00Z'), { ticketTypes: ['KA:Balcony'] });
    const charged = await saleTax(id);
    const docs = await documentTax(day('2031-06-10'), endOf('2031-06-11'));
    const reversed = -docs.creditNotes;
    expect(reversed).toBeGreaterThan(0);
    expect(reversed).toBeLessThan(charged);

    const r = await inr(day('2031-06-10'), endOf('2031-06-11'));
    expect(r.taxChargedMinor).toBe(charged);
    expect(r.taxReversedMinor).toBe(reversed);
    expect(r.netTaxMinor).toBe(charged - reversed);
    // The fee's GST was not refunded, so its line is untouched.
    const fee = r.breakdown.find((b) => b.component === 'IGST');
    expect(fee?.chargedMinor).toBeGreaterThan(0);
    expect(fee?.reversedMinor).toBe(0);
  });

  it('a counter cash sale cancelled with a credit note nets to zero', async () => {
    if (!guard()) return;
    const id = await sell({
      place: 'KA',
      when: new Date('2031-07-02T10:00:00Z'),
      tickets: [{ type: 'KA:Floor', priceMinor: 79_900, quantity: 3 }],
      category: 'LIVE_PERFORMANCE',
      cash: true,
    });
    await cancelCash(id, new Date('2031-07-03T09:00:00Z'));
    const charged = await saleTax(id);

    const r = await inr(day('2031-07-02'), endOf('2031-07-03'));
    expect(r.taxChargedMinor).toBe(charged);
    expect(r.taxReversedMinor).toBe(charged);
    expect(r.netTaxMinor).toBe(0);
    expect(r.invoices).toBe(1);
    expect(r.creditNotes).toBe(1);
  });

  it('several inclusive GST rules: each component and rate on its own row, by state', async () => {
    if (!guard()) return;
    // Cinema in Karnataka: a Rs 90 seat (5%) and a Rs 250 seat (18%), so two bands in one
    // order, each split CGST + SGST; the buyer is in Kerala, so the fee's GST is IGST.
    const ka = await sell({
      place: 'KA',
      when: new Date('2031-08-04T10:00:00Z'),
      tickets: [
        { type: 'KA:Front', priceMinor: 9_000, quantity: 1 },
        { type: 'KA:Balcony', priceMinor: 25_000, quantity: 1 },
      ],
      category: 'CINEMA',
      customerRegion: 'Kerala',
    });
    // A show in Maharashtra sold by a Karnataka seller: admission is inter-state, so IGST
    // (and the Kerala buyer's fee is IGST as well).
    const mh = await sell({
      place: 'MH',
      when: new Date('2031-08-04T11:00:00Z'),
      tickets: [{ type: 'MH:Floor', priceMinor: 79_900, quantity: 1 }],
      category: 'LIVE_PERFORMANCE',
      customerRegion: 'Kerala',
    });
    // The Rs 250 cinema seat is returned in the same month.
    await refund(ka, new Date('2031-08-05T09:00:00Z'), { ticketTypes: ['KA:Balcony'] });

    const r = await inr(day('2031-08-04'), endOf('2031-08-05'));
    const rows = Object.fromEntries(
      r.breakdown.map((b) => [`${b.component ?? b.label}@${b.rateBasisPoints}`, b]),
    );
    expect(Object.keys(rows).sort()).toEqual(
      ['CGST@250', 'SGST@250', 'CGST@900', 'SGST@900', 'IGST@1800'].sort(),
    );
    /*
      Each row is exactly that label and rate summed over the documents, read independently:
      charged from the sale documents, reversed from the credit note. (The credit note for the
      Rs 250 seat gives back a share of BOTH bands' lines, because the refund deals each
      inclusive line over the whole booking; the report states what the documents say.)
    */
    const perRate: { credit: boolean; label: string; rate: number; amount: bigint }[] = await db!
      .$queryRaw`
        SELECT (r."kind" = 'CREDIT_NOTE') AS credit, line->>'label' AS label,
               (line->>'rateBasisPoints')::int AS rate,
               SUM((line->>'amountMinor')::bigint) AS amount
        FROM "Receipt" r
        CROSS JOIN LATERAL jsonb_array_elements(r."documentJson"->'taxLines') AS line
        WHERE r."issuedAt" >= ${day('2031-08-04')} AND r."issuedAt" <= ${endOf('2031-08-05')}
        GROUP BY 1, 2, 3
      `;
    for (const [key, row] of Object.entries(rows)) {
      const pick = (credit: boolean) =>
        Number(
          perRate.find((p) => p.credit === credit && `${p.label}@${p.rate}` === key)?.amount ?? 0,
        );
      expect(row.chargedMinor).toBe(pick(false));
      expect(row.reversedMinor).toBe(0 - pick(true));
      expect(row.netMinor).toBe(row.chargedMinor - row.reversedMinor);
    }
    // The 18% seat went back, so its band is reversed; the fee's IGST was not refunded.
    expect(rows['CGST@900'].reversedMinor).toBeGreaterThan(0);
    expect(rows['IGST@1800'].reversedMinor).toBe(0);
    expect(r.breakdown.reduce((s, b) => s + b.netMinor, 0)).toBe(r.netTaxMinor);

    // Per state of the venue (the place of supply for admission).
    const places = Object.fromEntries(r.byPlace.map((p) => [p.region, p]));
    expect(places.Karnataka.country).toBe('India');
    expect(places.Maharashtra.chargedMinor).toBe(await saleTax(mh));
    expect(places.Maharashtra.reversedMinor).toBe(0);
    expect(places.Karnataka.chargedMinor).toBe(await saleTax(ka));
    expect(places.Karnataka.reversedMinor).toBeGreaterThan(0);
    expect(r.byPlace.reduce((s, p) => s + p.netMinor, 0)).toBe(r.netTaxMinor);
  });

  it('the report total is the documents tax lines, sales minus credit notes, to the paisa', async () => {
    if (!guard()) return;
    // Every case above, in one window.
    const from = day('2031-03-01');
    const to = endOf('2031-08-31');
    const docs = await documentTax(from, to);
    const r = await inr(from, to);

    expect(docs.sales).toBeGreaterThan(0);
    expect(docs.creditNotes).toBeLessThan(0);
    expect(r.taxChargedMinor).toBe(docs.sales);
    expect(r.taxReversedMinor).toBe(-docs.creditNotes);
    expect(r.netTaxMinor).toBe(docs.sales + docs.creditNotes);
    // Each view of the same documents adds up to the same net.
    expect(r.byMonth.reduce((s, m) => s + m.netMinor, 0)).toBe(r.netTaxMinor);
    expect(r.byPlace.reduce((s, p) => s + p.netMinor, 0)).toBe(r.netTaxMinor);
    expect(r.breakdown.reduce((s, b) => s + b.netMinor, 0)).toBe(r.netTaxMinor);
    // And the documents' own tax column agrees with their lines here, so the report's
    // figure is also what the organizer's receipts list shows.
    const column = await db!.receipt.aggregate({
      where: { organizationId: orgId, issuedAt: { gte: from, lte: to } },
      _sum: { taxMinor: true },
    });
    expect(column._sum.taxMinor).toBe(r.netTaxMinor);
  });
});
