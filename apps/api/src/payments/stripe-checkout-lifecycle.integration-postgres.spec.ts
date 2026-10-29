import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { BookingsService } from '../bookings/bookings.service';
import { PaymentsService } from './payments.service';
import { PaymentOrchestrator } from './orchestration/payment-orchestrator.service';
import { PaymentProviderResolver } from './provider/payment-provider.resolver';
import type { CreatePaymentInput } from './provider/payment-provider.interface';

/**
 * integration-real-postgres - the Stripe hold and Checkout Session lifecycle.
 *
 * The real PaymentsService, BookingsService sweep and recovery guard, against a real
 * database. Only Stripe itself is simulated (`FakeStripe`), with the behaviour the adapter
 * relies on: a session is open, expired or complete; `expire` refuses a session that is not
 * open; and the network can fail. One seat is on sale, so a double sale shows up as
 * `quantitySold > quantityTotal` or as two bookings holding tickets.
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

type FakeSession = {
  id: string;
  bookingId: string;
  amount: number;
  currency: string;
  status: 'open' | 'expired' | 'complete';
  paid: boolean;
};

/** Stripe Checkout, as far as the adapter's contract goes. */
class FakeStripe {
  sessions = new Map<string, FakeSession>();
  created: CreatePaymentInput[] = [];
  down = false;
  private n = 0;

  private net() {
    if (this.down) throw Object.assign(new Error('ECONNRESET'), { type: 'StripeConnectionError' });
  }

  async createPayment(input: CreatePaymentInput) {
    this.net();
    this.created.push(input);
    const id = `cs_test_${++this.n}_${input.bookingId}`;
    this.sessions.set(id, {
      id,
      bookingId: input.bookingId,
      amount: input.amountMinor,
      currency: input.currency.toUpperCase(),
      status: 'open',
      paid: false,
    });
    return {
      providerRef: id,
      clientActionUrl: `https://checkout.stripe.com/c/pay/${id}`,
      status: 'REQUIRES_PAYMENT' as const,
      providerOrderId: id,
    };
  }

  async resumeCheckout(id: string) {
    this.net();
    const s = this.sessions.get(id)!;
    return s.status === 'open' ? `https://checkout.stripe.com/c/pay/${id}` : null;
  }

  async closeOrder(id: string) {
    this.net();
    const s = this.sessions.get(id)!;
    if (s.status !== 'open') return 'not_open' as const;
    s.status = 'expired';
    return 'closed' as const;
  }

  async findOrderPayments(id: string) {
    this.net();
    const s = this.sessions.get(id)!;
    if (s.paid) {
      return [
        {
          providerRef: `pi_${id}`,
          status: 'SUCCEEDED',
          amountMinor: s.amount,
          currency: s.currency,
        },
      ];
    }
    if (s.status === 'expired') return [];
    throw new Error(`session ${s.status}, not final`);
  }

  /** The buyer pays: only an open session can be. Returns the webhook event it produces. */
  pay(id: string, override: Partial<{ amountMinor: number; currency: string }> = {}) {
    const s = this.sessions.get(id)!;
    if (s.status !== 'open') throw new Error('Stripe would refuse: session not open');
    s.status = 'complete';
    s.paid = true;
    return this.succeeded(id, override);
  }

  succeeded(id: string, override: Partial<{ amountMinor: number; currency: string }> = {}) {
    const s = this.sessions.get(id)!;
    return {
      type: 'payment.succeeded' as const,
      bookingId: s.bookingId,
      providerRef: `pi_${id}`,
      amountMinor: override.amountMinor ?? s.amount,
      currency: override.currency ?? s.currency,
      checkoutSessionId: id,
    };
  }
}

describe('integration-real-postgres: Stripe checkout lifecycle', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let app: INestApplication | undefined;
  let available = false;
  let payments: PaymentsService;
  let bookings: BookingsService;
  const stripe = new FakeStripe();

  const suffix = `stripe-life-${Date.now()}`;
  let orgId = '';
  let eventId = '';
  let n = 0;

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

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
    payments = app.get(PaymentsService);
    bookings = app.get(BookingsService);

    // Only the gateway is simulated; routing to it and everything after is the real code.
    const resolver = app.get(PaymentProviderResolver);
    const realGet = resolver.get.bind(resolver);
    jest
      .spyOn(resolver, 'get')
      .mockImplementation((name: string) =>
        name === 'stripe' ? (stripe as never) : realGet(name),
      );
    jest.spyOn(app.get(PaymentOrchestrator), 'createPayment').mockImplementation(
      async (_route: unknown, input: CreatePaymentInput) =>
        ({
          intent: await stripe.createPayment(input),
          provider: 'stripe',
        }) as never,
    );

    orgId = (
      await db!.organization.create({
        data: { name: `Stripe Life ${suffix}`, slug: suffix, status: 'APPROVED' },
      })
    ).id;
    const venue = await db!.venue.create({
      data: { organizationId: orgId, name: 'Hall', city: 'Austin', country: 'United States' },
    });
    eventId = (
      await db!.event.create({
        data: {
          organizationId: orgId,
          venueId: venue.id,
          title: `Stripe Show ${suffix}`,
          slug: `show-${suffix}`,
          category: 'Music',
          status: 'PUBLISHED',
        },
      })
    ).id;
  }, 180_000);

  afterAll(async () => {
    if (!db || !available) return;
    const mine = { booking: { organizationId: orgId } };
    await db.ticket.deleteMany({ where: mine });
    await db.bookingItem.deleteMany({ where: mine });
    await db.paymentAttempt.deleteMany({ where: { payment: mine } });
    await db.receipt.deleteMany({ where: mine });
    await db.payment.deleteMany({ where: mine });
    await db.booking.deleteMany({ where: { organizationId: orgId } });
    await db.ticketInventory.deleteMany({ where: { ticketType: { eventSession: { eventId } } } });
    await db.ticketType.deleteMany({ where: { eventSession: { eventId } } });
    await db.eventSession.deleteMany({ where: { eventId } });
    await db.event.deleteMany({ where: { organizationId: orgId } });
    await db.venue.deleteMany({ where: { organizationId: orgId } });
    await db.organization.deleteMany({ where: { id: orgId } });
    await app?.close();
    await db.$disconnect();
  }, 120_000);

  const maybe = (name: string, fn: () => Promise<void>) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      60_000,
    );

  /** A fresh showtime with ONE seat, so every scenario owns its inventory. */
  async function oneSeat() {
    const session = await db!.eventSession.create({
      data: {
        eventId,
        startsAt: new Date(Date.now() + 3 * 86_400_000),
        endsAt: new Date(Date.now() + 3 * 86_400_000 + 2 * 3_600_000),
      },
    });
    const tt = await db!.ticketType.create({
      data: {
        eventSessionId: session.id,
        name: 'GA',
        priceMinor: 2_500,
        quantityTotal: 1,
        inventory: { create: { quantityTotal: 1 } },
      },
    });
    return { sessionId: session.id, ticketTypeId: tt.id };
  }

  /** A hold on the seat, written the way BookingsService.create leaves one. */
  async function hold(seat: { sessionId: string; ticketTypeId: string }, minutesLeft = 10) {
    const updated = await db!.ticketInventory.updateMany({
      where: { ticketTypeId: seat.ticketTypeId, quantityHeld: 0, quantitySold: 0 },
      data: { quantityHeld: { increment: 1 } },
    });
    if (updated.count !== 1) throw new Error('seat not available');
    const booking = await db!.booking.create({
      data: {
        organizationId: orgId,
        eventId,
        eventSessionId: seat.sessionId,
        buyerEmail: `buyer+${suffix}@example.com`,
        buyerName: 'Buyer',
        holdExpiresAt: new Date(Date.now() + minutesLeft * 60_000),
        status: 'PENDING_PAYMENT',
        currency: 'USD',
        subtotalMinor: 2_500,
        totalMinor: 2_500,
        reference: `SL-${suffix}-${++n}`,
        items: {
          create: {
            ticketTypeId: seat.ticketTypeId,
            quantity: 1,
            unitPriceMinor: 2_500,
            lineTotalMinor: 2_500,
          },
        },
        payment: { create: { amountMinor: 2_500, currency: 'USD', provider: 'stripe' } },
      },
    });
    return booking.id;
  }

  /** POST /bookings/:id/pay, as the service answers it for a Stripe booking. */
  const startPay = async (bookingId: string) =>
    (await payments.createIntent(bookingId)) as { providerOrderId?: string };
  const lapse = (bookingId: string) =>
    db!.booking.update({
      where: { id: bookingId },
      data: { holdExpiresAt: new Date(Date.now() - 60_000) },
    });
  const sweep = (sessionId: string) =>
    bookings.releaseExpiredHolds(sessionId, { consultProvider: true });
  const state = async (bookingId: string, ticketTypeId: string) => {
    const b = await db!.booking.findUnique({
      where: { id: bookingId },
      include: { payment: true, _count: { select: { tickets: true } } },
    });
    const inv = await db!.ticketInventory.findUnique({ where: { ticketTypeId } });
    return { status: b.status, tickets: b._count.tickets, payment: b.payment, inv };
  };

  maybe('session lifetime and association: >= 30 min, stored as providerOrderId', async () => {
    const seat = await oneSeat();
    const id = await hold(seat);
    const before = Date.now();
    const start = await startPay(id);
    const input = stripe.created.at(-1)!;
    expect(input.expiresAt!.getTime() - before).toBeGreaterThanOrEqual(30 * 60_000);
    const s = await state(id, seat.ticketTypeId);
    expect(s.payment.providerOrderId).toBe(start.providerOrderId);
    expect(s.payment.status).toBe('PROCESSING');
  });

  maybe(
    'normal payment before expiry confirms once; a duplicate webhook issues nothing more',
    async () => {
      const seat = await oneSeat();
      const id = await hold(seat);
      const { providerOrderId } = await startPay(id);
      const event = stripe.pay(providerOrderId!);
      await payments.processVerifiedEvent(event);
      await payments.processVerifiedEvent(event);
      const s = await state(id, seat.ticketTypeId);
      expect(s.status).toBe('CONFIRMED');
      expect(s.tickets).toBe(1);
      expect(s.inv).toMatchObject({ quantitySold: 1, quantityHeld: 0 });
    },
  );

  maybe('paying again resumes the same open session instead of opening a second one', async () => {
    const seat = await oneSeat();
    const id = await hold(seat);
    const first = await startPay(id);
    const count = stripe.created.length;
    const again = await startPay(id);
    expect(again.providerOrderId).toBe(first.providerOrderId);
    expect(stripe.created.length).toBe(count);
  });

  maybe('success URL without a confirmed payment: nothing confirms', async () => {
    const seat = await oneSeat();
    const id = await hold(seat);
    await startPay(id);
    // The buyer is back on /checkout/success; no signed event has arrived.
    const s = await state(id, seat.ticketTypeId);
    expect(s.status).toBe('PENDING_PAYMENT');
    expect(s.tickets).toBe(0);
  });

  maybe('hold expiry with an open session: closes it first, then releases', async () => {
    const seat = await oneSeat();
    const id = await hold(seat);
    const { providerOrderId } = await startPay(id);
    await lapse(id);
    await sweep(seat.sessionId);
    expect(stripe.sessions.get(providerOrderId!)!.status).toBe('expired');
    const s = await state(id, seat.ticketTypeId);
    expect(s.status).toBe('EXPIRED');
    expect(s.inv).toMatchObject({ quantityHeld: 0, quantitySold: 0 });
    // The buyer who closed the tab and came back cannot pay the closed session.
    expect(() => stripe.pay(providerOrderId!)).toThrow(/not open/);
  });

  maybe(
    'Stripe outage during expiry: the seat stays held, then releases once Stripe answers',
    async () => {
      const seat = await oneSeat();
      const id = await hold(seat);
      await startPay(id);
      await lapse(id);
      stripe.down = true;
      try {
        await sweep(seat.sessionId);
      } finally {
        stripe.down = false;
      }
      let s = await state(id, seat.ticketTypeId);
      expect(s.status).toBe('PENDING_PAYMENT');
      expect(s.inv).toMatchObject({ quantityHeld: 1 });
      await sweep(seat.sessionId);
      s = await state(id, seat.ticketTypeId);
      expect(s.status).toBe('EXPIRED');
      expect(s.inv).toMatchObject({ quantityHeld: 0 });
    },
  );

  maybe(
    'payment racing hold expiry: exactly one confirmation, one ticket, no release',
    async () => {
      const seat = await oneSeat();
      const id = await hold(seat);
      const { providerOrderId } = await startPay(id);
      const event = stripe.pay(providerOrderId!);
      await lapse(id);
      await Promise.allSettled([
        payments.processVerifiedEvent(event),
        sweep(seat.sessionId),
        payments.processVerifiedEvent(event),
      ]);
      const s = await state(id, seat.ticketTypeId);
      expect(s.status).toBe('CONFIRMED');
      expect(s.tickets).toBe(1);
      expect(s.inv).toMatchObject({ quantitySold: 1, quantityHeld: 0 });
    },
  );

  maybe(
    'webhook lost, hold lapses: the sweep finds the payment and confirms instead of releasing',
    async () => {
      const seat = await oneSeat();
      const id = await hold(seat);
      const { providerOrderId } = await startPay(id);
      stripe.pay(providerOrderId!); // the webhook never arrives
      await lapse(id);
      await sweep(seat.sessionId);
      const s = await state(id, seat.ticketTypeId);
      expect(s.status).toBe('CONFIRMED');
      expect(s.tickets).toBe(1);
    },
  );

  maybe(
    'late payment, seat resold: no tickets, no double sale, recorded for a refund',
    async () => {
      const seat = await oneSeat();
      const first = await hold(seat);
      const { providerOrderId } = await startPay(first);
      // A delayed event for a session paid at the last instant, delivered after the seat moved on.
      const late = stripe.pay(providerOrderId!);
      await db!.booking.update({
        where: { id: first },
        data: { status: 'EXPIRED' },
      });
      await db!.ticketInventory.update({
        where: { ticketTypeId: seat.ticketTypeId },
        data: { quantityHeld: 0 },
      });
      const second = await hold(seat);
      const resold = await startPay(second);
      await payments.processVerifiedEvent(stripe.pay(resold.providerOrderId!));

      const outcome = await payments.processVerifiedEvent(late);
      expect(outcome).toMatchObject({ status: 'captured_on_unpayable_booking' });
      // Redelivered: still recorded once.
      await payments.processVerifiedEvent(late);

      const a = await state(first, seat.ticketTypeId);
      const b = await state(second, seat.ticketTypeId);
      expect(a.status).toBe('EXPIRED');
      expect(a.tickets).toBe(0);
      expect(b.tickets).toBe(1);
      expect(b.inv).toMatchObject({ quantitySold: 1, quantityHeld: 0 });
      const attempts = await db!.paymentAttempt.count({ where: { paymentId: a.payment.id } });
      expect(attempts).toBe(1);
      // Nothing was refunded automatically: the payment is not marked refunded.
      expect(a.payment.refundedMinor).toBe(0);
    },
  );

  maybe('currency mismatch, amount mismatch, foreign session: refused, no tickets', async () => {
    const seat = await oneSeat();
    const id = await hold(seat);
    const { providerOrderId } = await startPay(id);
    stripe.pay(providerOrderId!);
    await expect(
      payments.processVerifiedEvent(stripe.succeeded(providerOrderId!, { currency: 'CAD' })),
    ).rejects.toMatchObject({ code: 'PAYMENT_WEBHOOK_INVALID' });
    await expect(
      payments.processVerifiedEvent(stripe.succeeded(providerOrderId!, { amountMinor: 250 })),
    ).rejects.toBeDefined();
    await expect(
      payments.processVerifiedEvent({
        ...stripe.succeeded(providerOrderId!),
        checkoutSessionId: 'cs_test_someone_else',
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_WEBHOOK_INVALID' });
    const s = await state(id, seat.ticketTypeId);
    expect(s.status).toBe('PENDING_PAYMENT');
    expect(s.tickets).toBe(0);
    // And the genuine event still confirms afterwards.
    await payments.processVerifiedEvent(stripe.succeeded(providerOrderId!));
    expect((await state(id, seat.ticketTypeId)).tickets).toBe(1);
  });
});
