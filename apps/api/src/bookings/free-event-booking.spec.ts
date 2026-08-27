import { BookingStatus, ExperienceType, EventStatus, FeeMode } from '@eticketsgo/shared-types';
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
  TierPricingStrategy,
  SeatPricingStrategy,
} from '../pricing/pricing-strategies';
import { AddOnInventoryService } from '../commerce/addon-inventory.service';
import { MetricsService } from '../metrics/metrics.service';

/**
 * A free event never touches the payment system.
 *
 * ── WHAT WAS ASKED FOR ─────────────────────────────────────────────────────────────
 * "Free event should not even call payments api and should not collect payment fee or
 * platform fee, it is just free event." Everything AFTER the money still has to happen:
 * the attendee books, gets tickets and a QR code, and can cancel.
 *
 * Before this, a zero-rupee event was an ordinary priced event whose numbers happened to be
 * zero. Its booking went PENDING_PAYMENT, got a Payment row, and waited for a webhook that
 * would never arrive — so it expired, and the attendee never received the free ticket they
 * were promised. Had a buyer reached the checkout, the platform would have opened a
 * zero-amount order at Razorpay, which is a support ticket, not a payment.
 *
 * The pricing here is the REAL fee calculator with the REAL tax provider, not a stub that
 * returns zeros. "No booking fee and no platform share" is the claim under test, and a stub
 * would be asserting that the test's own mock returns what the test wrote in it.
 */
const BUYER = { id: 'u-free', email: 'free@t.test', fullName: 'F', roles: [] } as never;

interface Options {
  /** What the ticket type costs. Non-zero on a free event is the data error under test. */
  priceMinor?: number;
  isFree?: boolean;
  /** Swap in a confirmation seam that fails, or is missing entirely. */
  payments?: unknown;
}

function setup(over: Options = {}) {
  const priceMinor = over.priceMinor ?? 0;
  const isFree = over.isFree ?? true;

  const created = {
    id: 'bk-free',
    status: BookingStatus.PENDING_PAYMENT,
    currency: 'INR',
    holdExpiresAt: new Date(Date.now() + 900_000),
    totalMinor: 0,
    items: [],
    // Null exactly as Prisma returns it when the optional relation was never created.
    payment: null,
  };

  const bookingCreate = jest.fn().mockResolvedValue(created);
  const confirmFreeBooking = jest.fn().mockResolvedValue({
    status: 'confirmed',
    bookingId: 'bk-free',
    tickets: 2,
  });
  const audit = { record: jest.fn().mockResolvedValue(undefined) };

  const tx = {
    booking: { create: bookingCreate },
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
          feeMode: FeeMode.CUSTOMER_PAYS,
          isFree,
          venue: { country: 'India' },
          organization: { registeredCountry: 'India', registeredRegion: null },
        },
      }),
    },
    booking: { findMany: jest.fn().mockResolvedValue([]) },
    ticketType: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'tt-1',
          eventSessionId: 'sess-1',
          name: 'Entry',
          priceMinor,
          maxPerOrder: 10,
          seatCategoryId: null,
          salesStartAt: null,
          salesEndAt: null,
        },
      ]),
    },
    // The real fee calculator reads its tiers from here; none configured means no fee band.
    feeRule: { findMany: jest.fn().mockResolvedValue([]) },
    taxRule: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };

  const service = new BookingsService(
    prisma as never,
    new PricingService(prisma as never, new ManualTaxProvider(prisma as never)),
    new PricingStrategiesService(
      new FlatPricingStrategy(),
      new TierPricingStrategy(),
      new SeatPricingStrategy(),
    ),
    audit as never,
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
    (over.payments === undefined ? { confirmFreeBooking } : over.payments) as never,
  );

  const book = () =>
    service.create(BUYER, {
      eventSessionId: 'sess-1',
      items: [{ ticketTypeId: 'tt-1', quantity: 2 }],
      buyerName: 'F',
      buyerEmail: 'free@t.test',
    } as never);

  return { service, book, prisma, bookingCreate, confirmFreeBooking, audit };
}

describe('booking a free event', () => {
  it('creates no Payment row at all', async () => {
    /*
      Not a zero-amount one.

      A SUCCEEDED payment for ₹0 would appear in every reconciliation, settlement and payout
      report as a line that can never be matched against a bank statement, because no bank
      was involved. The absence of the row is the point, so the absence is what is asserted.
    */
    const { book, bookingCreate } = setup();
    await book();

    expect(bookingCreate).toHaveBeenCalledTimes(1);
    expect(bookingCreate.mock.calls[0][0].data).not.toHaveProperty('payment');
  });

  it('takes no booking fee, no payment fee and no platform share', async () => {
    // The literal request: "should not collect payment fee or platform fee".
    const { book, bookingCreate } = setup();
    const result = (await book()) as { fees: Record<string, number>; payment: unknown };

    const written = bookingCreate.mock.calls[0][0].data;
    expect(written.subtotalMinor).toBe(0);
    expect(written.totalMinor).toBe(0);
    expect(written.customerFeeMinor).toBe(0);
    expect(written.organizerFeeMinor).toBe(0);
    expect(result.fees.bookingFeeMinor).toBe(0);
    expect(result.fees.paymentFeeMinor).toBe(0);
    expect(result.fees.taxMinor).toBe(0);
  });

  it('confirms the booking on the spot, so the attendee gets their tickets', async () => {
    /*
      There is no webhook coming. Left PENDING_PAYMENT the hold would expire and the free
      ticket would silently never exist — the failure this whole path is built to avoid.
    */
    const { book, confirmFreeBooking } = setup();
    const result = (await book()) as { status: string; payment: unknown };

    expect(confirmFreeBooking).toHaveBeenCalledWith('bk-free');
    expect(result.status).toBe(BookingStatus.CONFIRMED);
    // And it reports the absence of a payment rather than an empty one, so the client can
    // route the buyer past a checkout that does not apply to them.
    expect(result.payment).toBeNull();
  });

  it('refuses to book a free event whose tickets carry a price', async () => {
    /*
      The worst failure this feature could have: an event declared free but priced at ₹500
      would take the free path, skip the provider, and give the tickets away. The discrepancy
      would only ever surface in the takings.
    */
    const { book, audit, bookingCreate } = setup({ priceMinor: 50_000 });

    await expect(book()).rejects.toThrow(/marked free but its tickets carry a price/i);
    expect(bookingCreate).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'FREE_EVENT_PRICED_BOOKING_REFUSED' }),
    );
  });

  it('fails loudly rather than returning a booking that is quietly still pending', async () => {
    // A free booking with no way to confirm is a broken deployment, not a pending payment.
    const { book } = setup({ payments: null });
    await expect(book()).rejects.toThrow(/not available in this configuration/i);
  });
});

describe('booking a paid event is unchanged', () => {
  it('still creates a Payment row awaiting payment', async () => {
    /*
      The regression that matters. Everything above is additive only if the ordinary path
      is untouched, so it is asserted here rather than assumed.
    */
    const { book, bookingCreate, confirmFreeBooking } = setup({
      isFree: false,
      priceMinor: 50_000,
    });
    const result = (await book()) as { status: string; payment: { status?: string } };

    const written = bookingCreate.mock.calls[0][0].data;
    expect(written.payment).toBeDefined();
    expect(written.payment.create.amountMinor).toBe(written.totalMinor);
    expect(written.totalMinor).toBeGreaterThan(0);
    expect(result.status).toBe(BookingStatus.PENDING_PAYMENT);
    expect(confirmFreeBooking).not.toHaveBeenCalled();
  });
});
