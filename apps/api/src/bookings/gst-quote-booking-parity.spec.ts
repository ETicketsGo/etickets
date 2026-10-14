import { BookingStatus, EventStatus, ExperienceType, FeeMode } from '@eticketsgo/shared-types';
import { BookingsService } from './bookings.service';
import { PricingService } from '../pricing/pricing.service';
import { ManualTaxProvider } from '../tax/providers/manual-tax.provider';
import { InventoryService } from '../inventory/inventory.service';
import { GeneralAdmissionInventoryStrategy } from '../inventory/general-admission.strategy';
import { SeatBasedInventoryStrategy } from '../inventory/seat-based.strategy';
import { ExperienceTypeRegistry } from '../experience/experience-type.registry';
import { PricingStrategiesService } from '../pricing/pricing-strategies.service';
import {
  FlatPricingStrategy,
  SeatPricingStrategy,
  TierPricingStrategy,
} from '../pricing/pricing-strategies';
import { AddOnInventoryService } from '../commerce/addon-inventory.service';
import { MetricsService } from '../metrics/metrics.service';
import { ReceiptsService } from '../receipts/receipts.service';
import { refundTaxForTickets, ticketNetPrices } from '../refunds/refund-tax';
import { INDIA_GST_RULES } from '../../prisma/india-gst-rules';

/**
 * Quote = booking = payment = receipt, to the paisa, with India GST switched on.
 *
 * ── THE DEFECT (QA readiness F1, 2026-10-14) ───────────────────────────────────────────
 * With GST active on QA, the same cart was quoted at 103,960 paise (fee GST as CGST 317 +
 * SGST 317) and booked at 103,961 (IGST 635); another cart was 52,282 quoted and 52,281
 * booked. The booking carried the buyer's state and the quote did not, which moved the fee's
 * GST from CGST + SGST to IGST - and because each 9% half was rounded on its own, moving
 * the heading moved the PRICE. The buyer saw one number on the event page and was charged
 * another.
 *
 * ── WHY THE REAL SERVICES ─────────────────────────────────────────────────────────────
 * Every number here comes from the real `BookingsService.quote` and `.create`, the real
 * `PricingService`, the real `ManualTaxProvider` reading the shipped India GST table, and
 * the real `ReceiptsService`. Only the database is a stub. A parity test built on a pricing
 * stub would prove that the stub agrees with itself.
 *
 * GST stays OFF everywhere real: the rules exist only in this file's in-memory table.
 */
const BUYER = { id: 'u-gst', email: 'gst@t.test', fullName: 'G', roles: [] } as never;

const GST_ROWS = INDIA_GST_RULES.map((r, i) => ({
  id: `tr-${i}`,
  label: r.label,
  rateBasisPoints: r.rateBasisPoints,
  appliesTo: r.appliesTo,
  country: 'India',
  region: '*',
  currency: '*',
  priority: r.priority,
  active: true,
  effectiveFrom: null,
  effectiveTo: null,
  taxGroup: r.taxGroup,
  category: r.category,
  minUnitMinor: r.minUnitMinor ?? null,
  maxUnitMinor: r.maxUnitMinor ?? null,
  // As India prices them: GST inside the ticket price, added to the platform's fee.
  inclusive: r.appliesTo === 'TICKETS',
  split: 'CGST_SGST',
}));

interface TicketTypeFixture {
  id: string;
  priceMinor: number;
  regulatoryClass?: string | null;
  /** The ticket type's own tax classification, overriding the event's. */
  taxCategory?: string | null;
}

interface Scenario {
  ticketTypes: TicketTypeFixture[];
  items: { ticketTypeId: string; quantity: number }[];
  addOns?: { id: string; priceMinor: number; quantity: number }[];
  coupon?: { type: 'PERCENT' | 'FIXED'; value: number };
  buyerRegion?: string;
  /** Where the platform is registered; decides whether the fee is IGST. */
  platformRegion?: string;
  feeMode?: FeeMode;
  /**
   * The event's tax classification (H-8). Defaults to OTHER_ENTERTAINMENT, the 18% admission
   * rate every scenario here was written against; null is an event nobody classified.
   */
  eventTaxCategory?: string | null;
  /** The TaxRule rows the provider reads. Defaults to the shipped table, all active. */
  taxRows?: unknown[];
}

function setup(sc: Scenario) {
  const bookingCreate = jest.fn(async (args: { data: Record<string, unknown> }) => ({
    id: 'bk-gst',
    status: BookingStatus.PENDING_PAYMENT,
    holdExpiresAt: new Date(Date.now() + 900_000),
    items: [],
    payment: null,
    ...args.data,
  }));
  const bookingUpdate = jest.fn().mockResolvedValue({});
  const paymentUpdate = jest.fn().mockResolvedValue({ count: 1 });
  const tx = {
    booking: { create: bookingCreate, update: bookingUpdate },
    payment: { updateMany: paymentUpdate },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockResolvedValue([{ ok: 1 }]),
  };
  const prisma = {
    idempotencyRecord: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn() },
    eventSession: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'sess-1',
        eventId: 'ev-1',
        status: 'SCHEDULED',
        startsAt: new Date(Date.now() + 7 * 86_400_000),
        event: {
          id: 'ev-1',
          organizationId: 'org-1',
          status: EventStatus.PUBLISHED,
          experienceType: ExperienceType.EVENT,
          feeMode: sc.feeMode ?? FeeMode.CUSTOMER_PAYS,
          isFree: false,
          taxCategory:
            sc.eventTaxCategory === undefined ? 'OTHER_ENTERTAINMENT' : sc.eventTaxCategory,
          venue: { country: 'India', region: 'Andhra Pradesh', city: 'Vijayawada' },
          organization: {
            registeredCountry: 'India',
            registeredRegion: 'Andhra Pradesh',
            cashPaymentsEnabled: false,
            status: 'ACTIVE',
            name: 'Org',
          },
        },
      }),
    },
    booking: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn() },
    ticketType: {
      findMany: jest.fn().mockResolvedValue(
        sc.ticketTypes.map((t) => ({
          id: t.id,
          eventSessionId: 'sess-1',
          name: t.id,
          priceMinor: t.priceMinor,
          currency: 'INR',
          maxPerOrder: 20,
          seatCategoryId: null,
          seatCategory: t.regulatoryClass
            ? { name: t.regulatoryClass, regulatoryClass: t.regulatoryClass }
            : null,
          salesStartAt: null,
          salesEndAt: null,
          status: 'ACTIVE',
          taxCategory: t.taxCategory ?? null,
        })),
      ),
    },
    addOn: {
      findMany: jest.fn().mockResolvedValue(
        (sc.addOns ?? []).map((a) => ({
          id: a.id,
          name: a.id,
          priceMinor: a.priceMinor,
          enabled: true,
          salesStartAt: null,
          salesEndAt: null,
          maxPerOrder: 20,
        })),
      ),
    },
    coupon: {
      findUnique: jest.fn().mockResolvedValue(
        sc.coupon
          ? {
              id: 'cp-1',
              code: 'SAVE',
              status: 'ACTIVE',
              organizationId: 'org-1',
              type: sc.coupon.type,
              value: sc.coupon.value,
              currency: 'INR',
              startsAt: null,
              endsAt: null,
              maxRedemptions: null,
              redemptions: 0,
            }
          : null,
      ),
    },
    feeRule: { findMany: jest.fn().mockResolvedValue([]) },
    taxRule: { findMany: jest.fn().mockResolvedValue(sc.taxRows ?? GST_ROWS) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const pricingConfig = { PLATFORM_TAX_REGION: sc.platformRegion ?? 'Karnataka' };
  const service = new BookingsService(
    prisma as never,
    new PricingService(prisma as never, new ManualTaxProvider(prisma as never), {
      get: (k: string) => (pricingConfig as Record<string, string>)[k],
    } as never),
    new PricingStrategiesService(
      new FlatPricingStrategy(),
      new TierPricingStrategy(),
      new SeatPricingStrategy(),
    ),
    { record: jest.fn().mockResolvedValue(undefined) } as never,
    new InventoryService(
      new ExperienceTypeRegistry(),
      new GeneralAdmissionInventoryStrategy(),
      new SeatBasedInventoryStrategy(),
    ),
    new AddOnInventoryService(),
    new MetricsService(),
    { observe: async () => undefined } as never,
    { observe: async () => undefined } as never,
    { get: () => 15 } as never,
    {} as never,
  );

  const cart = {
    eventSessionId: 'sess-1',
    items: sc.items,
    ...(sc.addOns?.length
      ? { addOns: sc.addOns.map((a) => ({ addOnId: a.id, quantity: a.quantity })) }
      : {}),
    ...(sc.coupon ? { couponCode: 'SAVE' } : {}),
    ...(sc.buyerRegion ? { buyerRegion: sc.buyerRegion } : {}),
  };

  return { service, cart, bookingCreate, bookingUpdate, paymentUpdate, prisma, sc };
}

type Written = {
  subtotalMinor: number;
  discountMinor: number;
  customerFeeMinor: number;
  bookingFeeMinor: number;
  paymentFeeMinor: number;
  taxMinor: number;
  totalMinor: number;
  currency: string;
  taxLines: { create: TaxRow[] };
  items: {
    create: {
      kind: string;
      ticketTypeId?: string;
      quantity: number;
      unitPriceMinor: number;
      lineTotalMinor: number;
      taxCategory?: string | null;
    }[];
  };
  payment?: { create: { amountMinor: number } };
};
type TaxRow = {
  label: string;
  rateBasisPoints: number;
  baseMinor: number;
  amountMinor: number;
  basis: string;
  inclusive: boolean;
};

/** The sale receipt the real ReceiptsService would issue for the booking `create` wrote. */
async function receiptFor(written: Written) {
  const receiptCreate = jest.fn().mockResolvedValue({});
  const tx = {
    booking: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'bk-gst',
        organizationId: 'org-1',
        reference: 'ETG-IND-2026-000001',
        buyerName: 'G',
        buyerEmail: 'gst@t.test',
        ...written,
        taxLines: written.taxLines.create,
        items: written.items.create.map((i, n) => ({
          id: `it-${n}`,
          ...i,
          ticketType: { name: i.ticketTypeId ?? 'x' },
          addOn: null,
        })),
        event: { title: 'Show', venue: { name: 'Hall', city: 'Vijayawada' } },
        eventSession: { startsAt: new Date() },
      }),
    },
    organization: {
      findUnique: jest.fn().mockResolvedValue({
        name: 'Org',
        legalName: 'Org Pvt Ltd',
        taxRegistrationKind: 'GSTIN',
        taxRegistrationNumber: '37ABCDE1234F1Z5',
        registeredAddressLine1: null,
        registeredAddressLine2: null,
        registeredCity: null,
        registeredRegion: 'Andhra Pradesh',
        registeredPostalCode: null,
        registeredCountry: 'India',
        financeContactName: null,
        financeContactEmail: null,
        financeContactPhone: null,
      }),
    },
    receipt: { create: receiptCreate },
    receiptCounter: { upsert: jest.fn().mockResolvedValue({ value: 1 }) },
  };
  await new ReceiptsService({} as never).issueForBooking(tx as never, 'bk-gst');
  return receiptCreate.mock.calls[0][0].data as {
    totalMinor: number;
    taxMinor: number;
    documentJson: { taxLines: TaxRow[] };
  };
}

/** Quote, then book the same cart; assert every figure agrees. Returns the booking row. */
async function assertParity(sc: Scenario) {
  const { service, cart, bookingCreate } = setup(sc);
  const quote = (await service.quote(cart as never)) as {
    fees: { totalMinor: number; taxMinor: number; taxLines: TaxRow[]; customerFeeMinor: number };
  };
  await service.create(BUYER, { ...cart, buyerName: 'G', buyerEmail: 'gst@t.test' } as never);
  const written = bookingCreate.mock.calls[0][0].data as unknown as Written;
  const receipt = await receiptFor(written);

  const strip = (rows: TaxRow[]) =>
    rows.map((r) => ({
      label: r.label,
      rateBasisPoints: r.rateBasisPoints,
      baseMinor: r.baseMinor,
      amountMinor: r.amountMinor,
    }));

  expect(written.totalMinor).toBe(quote.fees.totalMinor);
  expect(written.taxMinor).toBe(quote.fees.taxMinor);
  expect(strip(written.taxLines.create)).toEqual(strip(quote.fees.taxLines));
  expect(written.payment?.create.amountMinor).toBe(quote.fees.totalMinor);
  expect(receipt.totalMinor).toBe(quote.fees.totalMinor);
  expect(receipt.taxMinor).toBe(quote.fees.taxMinor);
  expect(strip(receipt.documentJson.taxLines)).toEqual(strip(quote.fees.taxLines));

  // The receipt foots: what the buyer pays is tickets - discount + fee + ADDED tax.
  const added = written.taxLines.create
    .filter((l) => !l.inclusive)
    .reduce((s, l) => s + l.amountMinor, 0);
  expect(written.totalMinor).toBe(
    written.subtotalMinor - written.discountMinor + written.customerFeeMinor + added,
  );
  // Split lines always add up to what one line would be: the halves differ by at most 1.
  for (const basis of ['TICKETS', 'FEES']) {
    const parts = written.taxLines.create.filter((l) => l.basis === basis);
    if (parts.length === 2) {
      expect(parts.map((p) => p.label)).toEqual(['CGST', 'SGST']);
      expect([0, 1]).toContain(parts[0].amountMinor - parts[1].amountMinor);
    }
  }
  return { written, quote };
}

const labelsOn = (rows: TaxRow[], basis: string) =>
  rows.filter((l) => l.basis === basis).map((l) => l.label);

describe('GST quote and booking agree to the paisa', () => {
  it('the QA cart: 2 x Rs 499.90, quoted WITHOUT the buyer state and booked WITH it', async () => {
    /*
      The exact shape of the readiness evidence: the quote named no buyer state (intra-state
      by default) and the booking named Andhra Pradesh against a platform registered in
      Karnataka (IGST on the fee). The totals must match even though the headings differ.
    */
    const tickets = [{ id: 'gen', priceMinor: 49_990 }];
    const items = [{ ticketTypeId: 'gen', quantity: 2 }];
    const noState = await assertParity({ ticketTypes: tickets, items });
    const withState = await assertParity({
      ticketTypes: tickets,
      items,
      buyerRegion: 'Andhra Pradesh',
    });

    expect(labelsOn(noState.written.taxLines.create, 'FEES')).toEqual(['CGST', 'SGST']);
    expect(labelsOn(withState.written.taxLines.create, 'FEES')).toEqual(['IGST']);
    expect(withState.written.totalMinor).toBe(noState.written.totalMinor);
    expect(withState.written.taxMinor).toBe(noState.written.taxMinor);
  });

  const BUYERS: (string | undefined)[] = [undefined, 'Andhra Pradesh', 'Karnataka', 'Telangana'];

  it('every buyer state pays the same total for a sweep of odd-paise prices', async () => {
    for (const priceMinor of [9_999, 10_001, 24_999, 35_027, 49_901, 52_281, 77_777, 159_801]) {
      const totals = new Set<number>();
      for (const buyerRegion of BUYERS) {
        const { written } = await assertParity({
          ticketTypes: [{ id: 'gen', priceMinor }],
          items: [{ ticketTypeId: 'gen', quantity: 1 }],
          buyerRegion,
        });
        totals.add(written.totalMinor);
      }
      expect(totals.size).toBe(1);
    }
  });

  it('a platform in the venue state splits the fee; one elsewhere charges IGST', async () => {
    const base = {
      ticketTypes: [{ id: 'gen', priceMinor: 35_027 }],
      items: [{ ticketTypeId: 'gen', quantity: 3 }],
      buyerRegion: 'Andhra Pradesh',
    };
    const intra = await assertParity({ ...base, platformRegion: 'Andhra Pradesh' });
    const inter = await assertParity({ ...base, platformRegion: 'Karnataka' });
    expect(labelsOn(intra.written.taxLines.create, 'FEES')).toEqual(['CGST', 'SGST']);
    expect(labelsOn(inter.written.taxLines.create, 'FEES')).toEqual(['IGST']);
    expect(intra.written.totalMinor).toBe(inter.written.totalMinor);
  });

  it('multiple ticket types, including a banded cinema class', async () => {
    for (const buyerRegion of BUYERS) {
      await assertParity({
        // Cinema by CLASSIFICATION; the seat classes below are pricing classes, not tax.
        eventTaxCategory: 'CINEMA',
        ticketTypes: [
          { id: 'reg', priceMinor: 15_000, regulatoryClass: 'REGULAR' },
          { id: 'rec', priceMinor: 25_000, regulatoryClass: 'RECLINER' },
          { id: 'kid', priceMinor: 9_950 },
        ],
        items: [
          { ticketTypeId: 'reg', quantity: 3 },
          { ticketTypeId: 'rec', quantity: 2 },
          { ticketTypeId: 'kid', quantity: 1 },
        ],
        buyerRegion,
      });
    }
  });

  it('add-ons in the cart', async () => {
    for (const buyerRegion of BUYERS) {
      await assertParity({
        ticketTypes: [{ id: 'gen', priceMinor: 49_990 }],
        items: [{ ticketTypeId: 'gen', quantity: 2 }],
        addOns: [{ id: 'popcorn', priceMinor: 19_999, quantity: 3 }],
        buyerRegion,
      });
    }
  });

  it('percentage and fixed coupons', async () => {
    for (const coupon of [
      { type: 'PERCENT' as const, value: 15 },
      { type: 'FIXED' as const, value: 10_001 },
    ]) {
      for (const buyerRegion of BUYERS) {
        await assertParity({
          ticketTypes: [{ id: 'gen', priceMinor: 79_900 }],
          items: [{ ticketTypeId: 'gen', quantity: 3 }],
          coupon,
          buyerRegion,
        });
      }
    }
  });

  it('a free ticket beside a paid one', async () => {
    for (const buyerRegion of BUYERS) {
      await assertParity({
        ticketTypes: [
          { id: 'comp', priceMinor: 0 },
          { id: 'gen', priceMinor: 52_281 },
        ],
        items: [
          { ticketTypeId: 'comp', quantity: 2 },
          { ticketTypeId: 'gen', quantity: 1 },
        ],
        buyerRegion,
      });
    }
  });

  it('when the organizer absorbs the fee', async () => {
    for (const buyerRegion of BUYERS) {
      await assertParity({
        ticketTypes: [{ id: 'gen', priceMinor: 52_281 }],
        items: [{ ticketTypeId: 'gen', quantity: 2 }],
        feeMode: FeeMode.ORGANIZER_PAYS,
        buyerRegion,
      });
    }
  });
});

describe('partial refunds return exactly the tax the tickets carried', () => {
  it('any split of the tickets into refunds sums to the ticket tax, line by line', async () => {
    /*
      Each refund used to prorate every line on its own and round: three one-ticket refunds
      of a line could return a paisa more, or less, than the line. The share is now dealt
      out across the booking's tickets in a fixed order, so however they are grouped the
      refunds return each line exactly.
    */
    for (const coupon of [undefined, { type: 'PERCENT' as const, value: 33 }]) {
      const { written } = await assertParity({
        ticketTypes: [
          { id: 'a', priceMinor: 33_333 },
          { id: 'b', priceMinor: 49_999 },
        ],
        items: [
          { ticketTypeId: 'a', quantity: 3 },
          { ticketTypeId: 'b', quantity: 2 },
        ],
        coupon,
        buyerRegion: 'Telangana',
      });
      const items = written.items.create
        .filter((i) => i.ticketTypeId)
        .map((i, n) => ({ id: `it-${n}`, ...i, ticketTypeId: i.ticketTypeId as string }));
      const tickets = ['t1', 't2', 't3', 't4', 't5'].map((id, n) => ({
        id,
        ticketTypeId: n < 3 ? 'a' : 'b',
      }));
      const { netByTicket, bookingTicketsMinor } = ticketNetPrices(items, tickets, written);
      const ticketLines = written.taxLines.create.filter((l) => l.basis === 'TICKETS');

      for (const groups of [
        [['t1'], ['t2'], ['t3'], ['t4'], ['t5']],
        [['t5', 't1'], ['t3'], ['t2', 't4']],
        [['t1', 't2', 't3', 't4', 't5']],
      ]) {
        const refunds = groups.map((ids) =>
          refundTaxForTickets(written.taxLines.create, netByTicket, ids, bookingTicketsMinor),
        );
        ticketLines.forEach((line, i) => {
          const back = refunds.reduce((s, r) => s + r.lines[i].amountMinor, 0);
          expect(back).toBe(line.amountMinor);
        });
        const totalBack = refunds.reduce((s, r) => s + r.taxMinor, 0);
        expect(totalBack).toBe(ticketLines.reduce((s, l) => s + l.amountMinor, 0));
      }
    }
  });
});

describe('a code entered at checkout re-prices exactly as if it had been in the cart', () => {
  it('re-prices a pending booking with GST on, to the total a quote with the code gives', async () => {
    /*
      The re-price passed no admission lines, and a banded GST rule refuses an order it
      cannot rate per ticket - so with India GST active, typing a code on the payment page
      threw instead of applying it. It now rebuilds the lines from the booking's own tickets.
    */
    const scenario: Scenario = {
      // A cinema event with a concert ticket type on it: both classifications are rated, and
      // both must survive the re-price.
      eventTaxCategory: 'CINEMA',
      ticketTypes: [
        { id: 'reg', priceMinor: 15_001, regulatoryClass: 'REGULAR' },
        { id: 'gen', priceMinor: 52_281, taxCategory: 'LIVE_PERFORMANCE' },
      ],
      items: [
        { ticketTypeId: 'reg', quantity: 2 },
        { ticketTypeId: 'gen', quantity: 1 },
      ],
      buyerRegion: 'Telangana',
    };
    // Booked without the code ...
    const { service, cart, bookingCreate, bookingUpdate, paymentUpdate, prisma } = setup(scenario);
    await service.create(BUYER, { ...cart, buyerName: 'G', buyerEmail: 'gst@t.test' } as never);
    const written = bookingCreate.mock.calls[0][0].data as unknown as Written &
      Record<string, unknown>;
    const byType = new Map(scenario.ticketTypes.map((t) => [t.id, t]));
    prisma.booking.findUnique.mockResolvedValue({
      ...written,
      id: 'bk-gst',
      userId: 'u-gst',
      organizationId: 'org-1',
      status: BookingStatus.PENDING_PAYMENT,
      feeMode: FeeMode.CUSTOMER_PAYS,
      payment: { status: 'REQUIRES_PAYMENT', providerRef: null },
      event: {
        feeMode: FeeMode.CUSTOMER_PAYS,
        venue: { country: 'India', region: 'Andhra Pradesh' },
        organization: { registeredCountry: 'India', registeredRegion: 'Andhra Pradesh' },
        /*
          Reclassified since the booking. Rated as a live performance the Rs 150.01 seat would be
          exempt (0%), as cinema it is 18%: the re-price must rate the SNAPSHOT, not this.
        */
        taxCategory: 'LIVE_PERFORMANCE',
      },
      items: written.items.create
        .filter((i) => i.kind === 'TICKET')
        .map((i) => ({
          unitPriceMinor: i.unitPriceMinor,
          quantity: i.quantity,
          // What `create` snapshotted on the line.
          taxCategory: i.taxCategory,
          ticketType: { taxCategory: byType.get(i.ticketTypeId as string)?.taxCategory ?? null },
        })),
    });
    // ... the code applied on the payment page ...
    const coupon = { type: 'PERCENT' as const, value: 20 };
    prisma.coupon.findUnique.mockResolvedValue({
      id: 'cp-1',
      code: 'SAVE',
      status: 'ACTIVE',
      organizationId: 'org-1',
      type: coupon.type,
      value: coupon.value,
      currency: 'INR',
      startsAt: null,
      endsAt: null,
      maxRedemptions: null,
      redemptions: 0,
    });
    const applied = (await service.applyCoupon(BUYER as never, 'bk-gst', 'SAVE')) as {
      fees: { totalMinor: number };
    };

    // ... must land where a quote with the code in the cart lands.
    const withCode = setup({ ...scenario, coupon });
    const quote = (await withCode.service.quote(withCode.cart as never)) as {
      fees: { totalMinor: number; taxMinor: number; taxLines: TaxRow[] };
    };
    const updated = bookingUpdate.mock.calls[0][0].data;
    expect(applied.fees.totalMinor).toBe(quote.fees.totalMinor);
    expect(updated.totalMinor).toBe(quote.fees.totalMinor);
    expect(updated.taxMinor).toBe(quote.fees.taxMinor);
    expect(updated.taxLines.create.map((l: TaxRow) => [l.label, l.amountMinor])).toEqual(
      quote.fees.taxLines.map((l) => [l.label, l.amountMinor]),
    );
    expect(paymentUpdate.mock.calls[0][0].data.amountMinor).toBe(quote.fees.totalMinor);
  });
});

describe('the tax category comes from the classification, never the seat class (H-8)', () => {
  /** What `quote` or `create` threw, so the refusal itself can be read. */
  async function refusedWith(run: () => Promise<unknown>) {
    try {
      await run();
    } catch (err) {
      return err as { code?: string; details?: Record<string, unknown> };
    }
    throw new Error('expected a refusal, and the order was priced instead');
  }

  it('a Rs 90 cinema seat is taxed at 5%, and quote = booking = payment = receipt', async () => {
    /*
      THE DEFECT, end to end. The booking passed the seat's regulatory class (REGULAR) to the
      tax engine as the category; the shipped cinema bands were written for 'MOVIE', so the
      seat matched nothing and the 18% catch-all took it. It is now rated by the event's
      classification, and the line remembers it.
    */
    for (const buyerRegion of [undefined, 'Andhra Pradesh', 'Telangana']) {
      const { written } = await assertParity({
        eventTaxCategory: 'CINEMA',
        ticketTypes: [{ id: 'reg', priceMinor: 9_000, regulatoryClass: 'REGULAR' }],
        items: [{ ticketTypeId: 'reg', quantity: 2 }],
        buyerRegion,
      });
      const ticketRates = written.taxLines.create
        .filter((l) => l.basis === 'TICKETS')
        .map((l) => l.rateBasisPoints);
      expect(ticketRates).toEqual([250, 250]);
      expect(written.items.create[0].taxCategory).toBe('CINEMA');
    }
  });

  it.each([
    ['SPORTS_RECOGNISED', 50_000, 0],
    ['SPORTS_RECOGNISED', 50_001, 1800],
    ['LIVE_PERFORMANCE', 150_000, 1800],
    ['AMUSEMENT', 49_900, 1800],
  ])('%s at %i paise: rated at %i bp, and every figure agrees', async (cat, price, bp) => {
    const { written } = await assertParity({
      eventTaxCategory: cat,
      ticketTypes: [{ id: 'gen', priceMinor: price }],
      items: [{ ticketTypeId: 'gen', quantity: 3 }],
      buyerRegion: 'Telangana',
    });
    const ticketRate = written.taxLines.create
      .filter((l) => l.basis === 'TICKETS')
      .reduce((s, l) => s + l.rateBasisPoints, 0);
    expect(ticketRate).toBe(bp);
  });

  it('a ticket type override beats the event classification', async () => {
    const { written } = await assertParity({
      eventTaxCategory: 'LIVE_PERFORMANCE',
      ticketTypes: [{ id: 'film', priceMinor: 9_000, taxCategory: 'CINEMA' }],
      items: [{ ticketTypeId: 'film', quantity: 1 }],
    });
    // Rs 90 as a live performance would be exempt (0%); as cinema it is 5%.
    expect(written.taxLines.create.filter((l) => l.basis === 'TICKETS')[0].rateBasisPoints).toBe(
      250,
    );
    expect(written.items.create[0].taxCategory).toBe('CINEMA');
  });

  it('refuses an UNCLASSIFIED event with GST on - the quote and the booking - and writes nothing', async () => {
    const sc: Scenario = {
      eventTaxCategory: null,
      ticketTypes: [{ id: 'reg', priceMinor: 9_000, regulatoryClass: 'REGULAR' }],
      items: [{ ticketTypeId: 'reg', quantity: 2 }],
    };
    const { service, cart, bookingCreate } = setup(sc);
    const quoted = await refusedWith(() => service.quote(cart as never));
    expect(quoted.code).toBe('TAX_CLASSIFICATION_MISSING');
    // The buyer reads the "not open for online booking" sentence any unsellable show gives.
    expect(quoted.details?.reason).toBe('SALE_NOT_OPEN');
    expect(quoted.details?.blockers).toEqual(['TAX_CLASSIFICATION_MISSING']);

    const booked = await refusedWith(() =>
      service.create(BUYER, { ...cart, buyerName: 'G', buyerEmail: 'gst@t.test' } as never),
    );
    expect(booked.code).toBe('TAX_CLASSIFICATION_MISSING');
    expect(bookingCreate).not.toHaveBeenCalled();
  });

  it('refuses a classification no active rule rates (an IPL-style league) as TAX_RULE_NOT_FOUND', async () => {
    const { service, cart } = setup({
      eventTaxCategory: 'SPORTS_OTHER',
      ticketTypes: [{ id: 'gen', priceMinor: 150_000 }],
      items: [{ ticketTypeId: 'gen', quantity: 1 }],
    });
    const quoted = await refusedWith(() => service.quote(cart as never));
    expect(quoted.code).toBe('TAX_RULE_NOT_FOUND');
    expect(quoted.details?.categories).toEqual(['SPORTS_OTHER']);
  });

  it('with GST inactive an unclassified event prices exactly as before: no tax, no refusal', async () => {
    const inactive = GST_ROWS.map((r) => ({ ...r, active: false }));
    const { service, cart } = setup({
      eventTaxCategory: null,
      // Handed over even though inactive: the engine itself must ignore them.
      taxRows: inactive,
      ticketTypes: [{ id: 'reg', priceMinor: 9_000, regulatoryClass: 'REGULAR' }],
      items: [{ ticketTypeId: 'reg', quantity: 2 }],
    });
    const quote = (await service.quote(cart as never)) as {
      fees: { taxMinor: number; taxLines: unknown[]; totalMinor: number; customerFeeMinor: number };
    };
    expect(quote.fees.taxMinor).toBe(0);
    expect(quote.fees.taxLines).toEqual([]);
    expect(quote.fees.totalMinor).toBe(18_000 + quote.fees.customerFeeMinor);
  });
});
