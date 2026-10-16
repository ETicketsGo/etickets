import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../app.module';
import { AllExceptionsFilter } from '../common/all-exceptions.filter';
import { CancellationRefundsService } from '../refunds/cancellation-refunds.service';
import { CashReturnsService } from '../refunds/cash-returns.service';
import { ShowCancellationFanoutService } from '../notifications/producers/show-cancellation-fanout.service';
import { NotificationTemplateService } from '../notifications/templates/notification-template.service';

/**
 * integration-real-postgres - F1: cancelling an event reverses the receipt of a counter cash
 * sale, over HTTP against the whole app.
 *
 * A counter cash sale is issued a tax invoice at collection. When its show is cancelled the
 * booking is voided (#411) and the cash goes back across the counter. Before F1 the tax
 * invoice stood in the organizer's books for a sale that was undone, and the buyer was told
 * "A refund will follow". This proves, through the real counter, cancel, receipt and
 * notification code:
 *
 *  - exactly one CRN credit note, linked to the sale receipt and the booking, whose totals and
 *    tax lines negate the sale's, with an audit entry linking cancel, credit note and receipt;
 *  - nothing in Refund, Payment, Payout, Settlement, PayoutAllocation or
 *    OfflineReconciliationRecord changes;
 *  - a second cancel, the sweep and a direct retry issue nothing more, and the database refuses
 *    a second credit note and any edit to the one issued;
 *  - the organizer's receipts report nets the booking to zero, total and every GST line;
 *  - "Mark as given back" is recorded against that credit note;
 *  - the cash buyer, the walk-up's organization copy and an online buyer each get their wording.
 *
 * The one tax rule is ACTIVE only for a made-up Indian region, so no real place is taxed by it.
 * Every row is created under a unique suffix and removed afterwards. Skips (never fabricates a
 * pass) when no database is reachable.
 */
function loadDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const p of ['../../../../.env', '../../../../../.env']) {
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

const PASSWORD = 'Vermilion-Lantern-4821!';

type Row = Record<string, any>;

describe('integration-real-postgres: a cancelled counter cash sale is reversed by a credit note', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let app: INestApplication | undefined;
  let base = '';
  let available = false;

  const suffix = `f1cash-${Date.now()}`;
  const region = `F1 Region ${suffix}`;
  let orgId = '';
  let ownerToken = '';
  let managerToken = '';
  let taxRuleId = '';

  async function http(method: string, path: string, token?: string, body?: unknown) {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json: json?.data ?? json, text };
  }

  const login = async (email: string) => {
    const r = await http('POST', '/auth/login', undefined, { email, password: PASSWORD });
    expect(r.status).toBeLessThan(300);
    return r.json.accessToken as string;
  };

  /** Every finance row this organization has, counted, so "nothing changed" is a fact. */
  async function financeCounts() {
    const byOrg = { organizationId: orgId };
    const byBooking = { booking: { organizationId: orgId } };
    const bookingIds = (await db!.booking.findMany({ where: byOrg, select: { id: true } })).map(
      (b: { id: string }) => b.id,
    );
    return {
      refunds: await db!.refund.count({ where: byOrg }),
      payments: await db!.payment.count({ where: byBooking }),
      payouts: await db!.payout.count({ where: byOrg }),
      settlements: await db!.settlement.count({ where: byOrg }),
      payoutAllocations: await db!.payoutAllocation.count({
        where: { bookingId: { in: bookingIds } },
      }),
      offlineReconciliation: await db!.offlineReconciliationRecord.count({ where: byOrg }),
    };
  }

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED -- no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db!.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED -- DB unavailable');
      return;
    }
    process.env.DATABASE_URL = url;
    process.env.APP_ENV = process.env.APP_ENV ?? 'LOCAL';
    process.env.THROTTLE_LIMIT = '5000';
    process.env.AUTH_THROTTLE_LIMIT = '5000';

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    const hash = await bcrypt.hash(PASSWORD, 10);
    const user = (who: string, role: string) =>
      db!.user.create({
        data: {
          email: `${who}-${suffix}@test.invalid`,
          passwordHash: hash,
          fullName: `${who} person`,
          roles: [role],
        },
      });
    const owner = await user('owner', 'ORGANIZER_OWNER');
    const manager = await user('manager', 'ORGANIZER_MANAGER');

    const org = await db!.organization.create({
      data: {
        name: `F1 Org ${suffix}`,
        slug: `f1-org-${suffix}`,
        status: 'APPROVED',
        cashPaymentsEnabled: false,
        contactEmail: `box-office-${suffix}@test.invalid`,
        // A registered seller, so the sale document is a TAX INVOICE, as in India.
        legalName: `F1 Org ${suffix} Pvt Ltd`,
        taxRegistrationKind: 'GSTIN',
        taxRegistrationNumber: '29ABCDE1234F1Z5',
      },
    });
    orgId = org.id;
    await db!.organizationMember.createMany({
      data: [
        { organizationId: orgId, userId: owner.id, role: 'ORGANIZER_OWNER', status: 'ACTIVE' },
        { organizationId: orgId, userId: manager.id, role: 'ORGANIZER_MANAGER', status: 'ACTIVE' },
      ],
    });
    // GST inside the ticket price, at 18%, only in a region that does not exist.
    taxRuleId = (
      await db!.taxRule.create({
        data: {
          label: `F1 GST ${suffix}`,
          rateBasisPoints: 1800,
          appliesTo: 'TICKETS',
          country: 'India',
          region,
          currency: 'INR',
          inclusive: true,
          active: true,
        },
      })
    ).id;

    ownerToken = await login(`owner-${suffix}@test.invalid`);
    managerToken = await login(`manager-${suffix}@test.invalid`);
  }, 180_000);

  afterAll(async () => {
    if (db && available) {
      const users = await db.user.findMany({
        where: { email: { contains: suffix } },
        select: { id: true },
      });
      const ids = users.map((u: { id: string }) => u.id);
      const where = { booking: { organizationId: orgId } };
      const bookingIds = (
        await db.booking.findMany({ where: { organizationId: orgId }, select: { id: true } })
      ).map((b: { id: string }) => b.id);
      // A Notification names its booking by id only; there is no relation to filter through.
      await db.notification.deleteMany({
        where: { OR: [{ userId: { in: ids } }, { bookingId: { in: bookingIds } }] },
      });
      // Credit notes first: they point at the sale documents they reverse.
      await db.receipt.deleteMany({ where: { ...where, NOT: { reversesId: null } } });
      await db.receipt.deleteMany({ where });
      await db.receiptCounter.deleteMany({ where: { scope: { startsWith: `${orgId}:` } } });
      await db.refund.deleteMany({ where: { organizationId: orgId } });
      await db.ticket.deleteMany({ where });
      await db.bookingTaxLine.deleteMany({ where });
      await db.bookingItem.deleteMany({ where });
      await db.payment.deleteMany({ where });
      await db.booking.deleteMany({ where: { organizationId: orgId } });
      await db.auditLog.deleteMany({
        where: { OR: [{ organizationId: orgId }, { actorUserId: { in: ids } }] },
      });
      await db.organizationMember.deleteMany({ where: { organizationId: orgId } });
      const events = { event: { organizationId: orgId } };
      await db.ticketInventory.deleteMany({ where: { ticketType: { eventSession: events } } });
      await db.ticketType.deleteMany({ where: { eventSession: events } });
      await db.eventSession.deleteMany({ where: events });
      await db.event.deleteMany({ where: { organizationId: orgId } });
      await db.venue.deleteMany({ where: { organizationId: orgId } });
      if (taxRuleId) await db.taxRule.deleteMany({ where: { id: taxRuleId } });
      await db.organization.deleteMany({ where: { id: orgId } });
      await db.user.deleteMany({ where: { id: { in: ids } } });
      await db.$disconnect();
    }
    if (app) await app.close();
  }, 120_000);

  const maybe = (name: string, fn: () => Promise<void>, timeout = 120_000) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  /** A published GA event with one future date and one INR ticket type, in the taxed region. */
  async function gaEvent(label: string, priceMinor: number) {
    const venue = await db!.venue.create({
      data: {
        organizationId: orgId,
        name: `Hall ${label}`,
        city: 'Bengaluru',
        region,
        country: 'India',
      },
    });
    const event = await db!.event.create({
      data: {
        organizationId: orgId,
        venueId: venue.id,
        title: `Show ${label} ${suffix}`,
        slug: `show-${label.toLowerCase()}-${suffix}`,
        category: 'MUSIC',
        status: 'PUBLISHED',
      },
    });
    const startsAt = new Date(Date.now() + 5 * 86_400_000);
    const session = await db!.eventSession.create({
      data: { eventId: event.id, startsAt, endsAt: new Date(startsAt.getTime() + 7_200_000) },
    });
    const tt = await db!.ticketType.create({
      data: {
        eventSessionId: session.id,
        name: 'General',
        priceMinor,
        currency: 'INR',
        quantityTotal: 100,
        inventory: { create: { quantityTotal: 100 } },
      },
    });
    return { eventId: event.id, sessionId: session.id, ticketTypeId: tt.id };
  }

  const creditNotesFor = (bookingId: string) =>
    db!.receipt.findMany({ where: { bookingId, kind: 'CREDIT_NOTE' } });

  let show: { eventId: string; sessionId: string; ticketTypeId: string };
  let walkUpId = '';
  let emailedId = '';
  let before: Awaited<ReturnType<typeof financeCounts>>;

  maybe(
    'cancelling the event issues exactly one credit note per cash sale, and moves no money',
    async () => {
      show = await gaEvent('Reversal', 59_000);
      const sell = (body: Row) =>
        http('POST', `/organizations/${orgId}/counter-sales`, ownerToken, {
          eventSessionId: show.sessionId,
          items: [{ ticketTypeId: show.ticketTypeId, quantity: 2 }],
          ...body,
        });
      const walkUp = await sell({ buyerName: 'Walk Counter Buyer' });
      expect(walkUp.status).toBe(201);
      walkUpId = walkUp.json.bookingId;
      const emailed = await sell({
        buyerName: 'Walk Email Buyer',
        buyerEmail: `buyer-${suffix}@test.invalid`,
      });
      expect(emailed.status).toBe(201);
      emailedId = emailed.json.bookingId;

      const sale = await db!.receipt.findUniqueOrThrow({ where: { saleForBookingId: walkUpId } });
      expect(sale.kind).toBe('TAX_INVOICE');
      // The fixture is load-bearing only if the sale actually carried GST.
      expect(sale.taxMinor).toBeGreaterThan(0);
      expect(await creditNotesFor(walkUpId)).toEqual([]);
      before = await financeCounts();

      const r = await http('POST', `/events/${show.eventId}/cancel`, ownerToken, {
        reason: 'Walk F1: the hall is flooded.',
      });
      expect(r.status).toBe(201);
      expect(r.json.cashToReturn).toBe(2);

      for (const bookingId of [walkUpId, emailedId]) {
        const booking = await db!.booking.findUniqueOrThrow({ where: { id: bookingId } });
        expect(booking.status).toBe('CANCELLED');
        const ownSale = await db!.receipt.findUniqueOrThrow({
          where: { saleForBookingId: bookingId },
        });
        const notes = await creditNotesFor(bookingId);
        expect(notes).toHaveLength(1);
        const note = notes[0];
        expect(note.number).toMatch(/^CRN-\d{4}-\d{6}$/);
        expect(note.cancellationForBookingId).toBe(bookingId);
        expect(note.reversesId).toBe(ownSale.id);
        expect(note.refundId).toBeNull();
        expect(note.saleForBookingId).toBeNull();
        // Its totals negate the receipt's.
        expect(note.totalMinor).toBe(-ownSale.totalMinor);
        expect(note.taxMinor).toBe(-ownSale.taxMinor);
        expect(note.feeMinor).toBe(-ownSale.feeMinor);
        expect(note.subtotalMinor - note.discountMinor).toBe(
          -(ownSale.subtotalMinor - ownSale.discountMinor),
        );
        expect((note.documentJson as Row).reverses.number).toBe(ownSale.number);
      }
      // The summary names the credit note against each cash return.
      expect(r.json.cashReturns.map((c: Row) => c.creditNoteNumber).every(Boolean)).toBe(true);

      // One audit entry per reversal, linking the booking, the credit note and the receipt.
      const audit = await db!.auditLog.findMany({
        where: { organizationId: orgId, action: 'CASH_SALE_REVERSED' },
      });
      expect(audit).toHaveLength(2);
      const walkUpNote = (await creditNotesFor(walkUpId))[0];
      const walkUpAudit = audit.find((a: Row) => a.metadata.bookingId === walkUpId);
      expect(walkUpAudit.entityId).toBe(walkUpNote.id);
      expect(walkUpAudit.metadata).toMatchObject({
        creditNoteNumber: walkUpNote.number,
        reversesReceiptId: sale.id,
        reversesReceiptNumber: sale.number,
        cashReturn: 'OFFLINE_AT_COUNTER',
      });
      const cancelled = await db!.auditLog.findFirstOrThrow({
        where: { action: 'CASH_BOOKING_CANCELLED', entityId: walkUpId },
      });
      expect(cancelled.metadata.creditNoteNumber).toBe(walkUpNote.number);

      // No Refund, Payment, settlement, payout or reconciliation row was made or changed.
      expect(await financeCounts()).toEqual(before);
    },
  );

  maybe('a second cancel, the sweep and a retry issue no second credit note', async () => {
    const again = await http('POST', `/events/${show.eventId}/cancel`, ownerToken, {
      reason: 'Walk F1: pressed twice.',
    });
    expect(again.status).toBe(201);
    await app!.get(CancellationRefundsService).sweep();
    await app!.get(CashReturnsService).cancelForCancelledSession(show.sessionId);
    expect(await creditNotesFor(walkUpId)).toHaveLength(1);
    expect(await creditNotesFor(emailedId)).toHaveLength(1);
    expect(
      await db!.auditLog.count({ where: { organizationId: orgId, action: 'CASH_SALE_REVERSED' } }),
    ).toBe(2);
    expect(await financeCounts()).toEqual(before);
  });

  maybe('the database refuses a second credit note and any edit to the one issued', async () => {
    const note = (await creditNotesFor(walkUpId))[0];
    await expect(
      db!.receipt.create({
        data: {
          number: `CRN-DUP-${suffix}`,
          kind: 'CREDIT_NOTE',
          organizationId: orgId,
          bookingId: walkUpId,
          cancellationForBookingId: walkUpId,
          currency: 'INR',
          subtotalMinor: 0,
          discountMinor: 0,
          feeMinor: 0,
          taxMinor: 0,
          totalMinor: 0,
          documentJson: {},
        },
      }),
    ).rejects.toThrow();
    await expect(
      db!.receipt.update({ where: { id: note.id }, data: { totalMinor: 0 } }),
    ).rejects.toThrow(/cannot be changed/);
    // Only a credit note may carry the key, and only for its own booking.
    await expect(
      db!.receipt.create({
        data: {
          number: `CRN-BAD-${suffix}`,
          kind: 'RECEIPT',
          organizationId: orgId,
          bookingId: emailedId,
          cancellationForBookingId: `${emailedId}-other`,
          currency: 'INR',
          subtotalMinor: 0,
          discountMinor: 0,
          feeMinor: 0,
          taxMinor: 0,
          totalMinor: 0,
          documentJson: {},
        },
      }),
    ).rejects.toThrow();
    expect((await db!.receipt.findUniqueOrThrow({ where: { id: note.id } })).totalMinor).toBe(
      note.totalMinor,
    );
  });

  maybe(
    'the receipts report nets the cancelled cash sale to zero, total and every GST line',
    async () => {
      const report = await http(
        'GET',
        `/organizations/${orgId}/receipts?page=1&pageSize=100`,
        ownerToken,
      );
      expect(report.status).toBe(200);
      const docs = report.json.items.filter((d: Row) => d.booking.id === walkUpId);
      expect(docs.map((d: Row) => d.kind).sort()).toEqual(['CREDIT_NOTE', 'TAX_INVOICE']);
      const sum = (key: string) => docs.reduce((s: number, d: Row) => s + d[key], 0);
      expect(sum('totalMinor')).toBe(0);
      expect(sum('taxMinor')).toBe(0);
      expect(sum('feeMinor')).toBe(0);

      // GST by label and rate, read from each issued document as a filing would.
      const byLine = new Map<string, number>();
      for (const d of docs) {
        const full = await http('GET', `/receipts/${d.id}`, ownerToken);
        expect(full.status).toBe(200);
        for (const line of full.json.taxLines) {
          const key = `${line.label}|${line.rateBasisPoints}`;
          byLine.set(key, (byLine.get(key) ?? 0) + line.amountMinor);
        }
      }
      expect(byLine.size).toBeGreaterThan(0);
      for (const amount of byLine.values()) expect(amount).toBe(0);

      // The credit note renders as a document that names the invoice it reverses.
      const crn = docs.find((d: Row) => d.kind === 'CREDIT_NOTE');
      const sale = docs.find((d: Row) => d.kind === 'TAX_INVOICE');
      const html = await http('GET', `/receipts/${crn.id}/html`, ownerToken);
      expect(html.status).toBe(200);
      expect(html.text).toContain(crn.number);
      expect(html.text).toContain(sale.number);
    },
  );

  maybe('"Mark as given back" is recorded against the credit note, offline', async () => {
    const note = (await creditNotesFor(walkUpId))[0];
    const list = await http('GET', `/organizations/${orgId}/cash-returns`, ownerToken);
    const row = list.json.find((x: Row) => x.bookingId === walkUpId);
    expect(row.creditNote).toEqual({ id: note.id, number: note.number });

    const back = await http(
      'POST',
      `/organizations/${orgId}/cash-returns/${walkUpId}/returned`,
      managerToken,
    );
    expect(back.status).toBe(201);
    expect(back.json.creditNote).toEqual({ id: note.id, number: note.number });
    const returned = await db!.auditLog.findFirstOrThrow({
      where: { action: 'CASH_RETURNED', entityId: walkUpId },
    });
    expect(returned.metadata).toMatchObject({
      creditNoteId: note.id,
      creditNoteNumber: note.number,
      cashReturn: 'OFFLINE_AT_COUNTER',
    });
    expect(await creditNotesFor(walkUpId)).toHaveLength(1);
    expect(await financeCounts()).toEqual(before);
  });

  maybe('a cash sale voided before credit notes existed is reversed on the next pass', async () => {
    // As #411 left it: voided, no credit note. Removed by hand here to stand for that state.
    const note = (await creditNotesFor(emailedId))[0];
    await db!.receipt.delete({ where: { id: note.id } });
    await db!.auditLog.deleteMany({
      where: { action: 'CASH_SALE_REVERSED', entityId: note.id },
    });
    expect(await creditNotesFor(emailedId)).toHaveLength(0);

    await app!.get(CancellationRefundsService).sweep();
    await app!.get(CashReturnsService).cancelForCancelledSession(show.sessionId);
    const reissued = await creditNotesFor(emailedId);
    expect(reissued).toHaveLength(1);
    expect(reissued[0].cancellationForBookingId).toBe(emailedId);
    expect(
      await db!.auditLog.count({
        where: { action: 'CASH_SALE_REVERSED', entityId: reissued[0].id },
      }),
    ).toBe(1);
    expect(await financeCounts()).toEqual(before);
  });

  maybe(
    'cash buyers are told the cash comes back at the venue; online buyers keep the refund line',
    async () => {
      // An online buyer on the same show, for the contrast. Paid online; no Payment row is needed
      // for the message.
      const online = await db!.booking.create({
        data: {
          organizationId: orgId,
          eventId: show.eventId,
          eventSessionId: show.sessionId,
          status: 'CONFIRMED',
          paymentMethod: 'ONLINE',
          buyerName: 'Online Buyer',
          buyerEmail: `online-${suffix}@test.invalid`,
          reference: `ETG-F1-${suffix}`,
          currency: 'INR',
          subtotalMinor: 59_000,
          totalMinor: 59_000,
          holdExpiresAt: new Date(),
        },
      });

      await app!.get(ShowCancellationFanoutService).fanOut(show.sessionId);
      const notice = async (bookingId: string) => {
        const rows = await db!.notification.findMany({
          where: { bookingId, type: 'SHOW_CANCELLED', channel: 'email' },
        });
        expect(rows).toHaveLength(1);
        return rows[0];
      };
      const templates = new NotificationTemplateService();
      const render = (n: Row) => templates.render('SHOW_CANCELLED' as never, 'en', n.payload);

      // The walk-up gave no email: the organization is told whom to repay and how much.
      const walkUp = await notice(walkUpId);
      expect(walkUp.toEmail).toBe(`box-office-${suffix}@test.invalid`);
      const walkUpBooking = await db!.booking.findUniqueOrThrow({ where: { id: walkUpId } });
      const walkUpText = render(walkUp);
      expect(walkUpText.subject).toBe('Show cancelled: cash to give back');
      expect(walkUpText.body).toContain('Walk Counter Buyer');
      expect(walkUpText.body).toContain(walkUpBooking.reference);
      expect(walkUp.payload).toMatchObject({
        paidInCash: true,
        cashRecipient: 'ORGANIZER',
        amountMinor: walkUpBooking.totalMinor,
      });

      // The cash buyer with an email: the cash comes back at the box office.
      const emailed = await notice(emailedId);
      expect(emailed.toEmail).toBe(`buyer-${suffix}@test.invalid`);
      const emailedText = render(emailed);
      expect(emailedText.body).not.toMatch(/refund/i);
      expect(emailedText.body).toContain('box office');
      expect(emailed.payload.cashRecipient).toBeUndefined();

      // The online buyer keeps the refund wording.
      const onlineText = render(await notice(online.id));
      expect(onlineText.body).toContain('A refund will follow.');
    },
  );
});
