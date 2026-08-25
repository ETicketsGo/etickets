import { BookingStatus, PaymentStatus } from '@eticketsgo/shared-types';
import { BookingsService } from './bookings.service';

/**
 * Applying a discount code at checkout.
 *
 * Reported from QA: an organizer created a promotion and found nowhere in the buying flow to
 * use it. A code could always be passed when the booking was CREATED — while the buyer is
 * picking seats, not thinking about money — so in practice it was unreachable.
 *
 * Re-pricing a booking after the fact is only safe while nothing downstream has acted on the
 * old price. These tests are mostly about the refusals.
 */
const USER = { id: 'u-1', email: 'b@t.test', fullName: 'B', roles: [] } as never;

function setup(
  over: {
    status?: string;
    paymentStatus?: string;
    providerRef?: string | null;
    userId?: string | null;
    coupon?: unknown;
  } = {},
) {
  const booking = {
    id: 'bk-1',
    userId: over.userId === undefined ? 'u-1' : over.userId,
    status: over.status ?? BookingStatus.PENDING_PAYMENT,
    subtotalMinor: 100_000,
    currency: 'INR',
    feeMode: 'CUSTOMER_PAYS',
    event: { feeMode: 'CUSTOMER_PAYS' },
    payment: {
      status: over.paymentStatus ?? PaymentStatus.REQUIRES_PAYMENT,
      providerRef: over.providerRef ?? null,
    },
  };
  const bookingUpdate = jest.fn().mockResolvedValue({});
  const paymentUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    booking: { findUnique: jest.fn().mockResolvedValue(booking), update: bookingUpdate },
    coupon: {
      findUnique: jest.fn().mockResolvedValue(
        over.coupon === undefined
          ? {
              id: 'cp-1',
              code: 'FIRST10',
              status: 'ACTIVE',
              type: 'PERCENT',
              value: 10,
              startsAt: null,
              endsAt: null,
              maxRedemptions: null,
              redemptions: 0,
            }
          : over.coupon,
      ),
    },
    payment: { updateMany: paymentUpdateMany },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ booking: { update: bookingUpdate }, payment: { updateMany: paymentUpdateMany } }),
  };
  const pricing = {
    quote: jest.fn().mockResolvedValue({
      currency: 'INR',
      subtotalMinor: 100_000,
      discountMinor: 10_000,
      netSubtotalMinor: 90_000,
      bookingFeeMinor: 1_500,
      paymentFeeMinor: 1_830,
      customerFeeMinor: 3_330,
      organizerFeeMinor: 0,
      taxLines: [],
      taxMinor: 0,
      totalMinor: 93_330,
    }),
  };
  /*
    Only prisma and pricing are exercised by `applyCoupon`; the rest of the constructor is
    stubbed. Listed explicitly rather than spread from an array so that adding a dependency
    breaks this at COMPILE time, which is the moment to decide whether coupons care about it.
  */
  const stub = {} as never;
  const service = new BookingsService(
    prisma as never,
    pricing as never,
    stub, // pricingStrategies
    stub, // audit
    stub, // inventory
    stub, // addOnInventory
    stub, // metrics
    stub, // lockShadow
    stub, // bookingShadow
  );
  return { service, prisma, bookingUpdate, paymentUpdateMany, pricing };
}

describe('BookingsService.applyCoupon', () => {
  it('re-prices the booking and the amount to be charged together', async () => {
    // A total and a gateway amount that disagree is the outcome worth failing loudly to
    // avoid, so both are written inside one transaction.
    const { service, bookingUpdate, paymentUpdateMany } = setup();
    const res = await service.applyCoupon(USER, 'bk-1', 'FIRST10');

    expect(res.applied).toBe(true);
    expect(bookingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ couponId: 'cp-1', totalMinor: 93_330 }),
      }),
    );
    expect(paymentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { amountMinor: 93_330 } }),
    );
  });

  it('replaces tax lines rather than adding to them', async () => {
    // Re-pricing from scratch: leaving the previous lines would double-count on the receipt.
    const { service, bookingUpdate } = setup();
    await service.applyCoupon(USER, 'bk-1', 'FIRST10');
    expect(bookingUpdate.mock.calls[0][0].data.taxLines).toHaveProperty('deleteMany');
  });

  it('clears the code when passed null', async () => {
    const { service, bookingUpdate } = setup();
    const res = await service.applyCoupon(USER, 'bk-1', null);
    expect(res.applied).toBe(false);
    expect(bookingUpdate.mock.calls[0][0].data.couponId).toBeNull();
  });

  it('tells the buyer an unknown code is unknown', async () => {
    // A box that accepts anything and changes nothing is worse than one that says no.
    const { service } = setup({ coupon: null });
    await expect(service.applyCoupon(USER, 'bk-1', 'NOPE')).rejects.toThrow(/not valid/i);
  });

  it('refuses once payment has started at the provider', async () => {
    // An intent at the gateway holds an amount. Changing ours behind it is how a charge and
    // a booking come to disagree.
    const { service, bookingUpdate } = setup({ providerRef: 'pi_123' });
    await expect(service.applyCoupon(USER, 'bk-1', 'FIRST10')).rejects.toThrow(/already started/i);
    expect(bookingUpdate).not.toHaveBeenCalled();
  });

  it('refuses once the payment has moved past REQUIRES_PAYMENT', async () => {
    const { service } = setup({ paymentStatus: PaymentStatus.SUCCEEDED });
    await expect(service.applyCoupon(USER, 'bk-1', 'FIRST10')).rejects.toThrow(/already started/i);
  });

  it('refuses on a booking that is no longer pending', async () => {
    const { service } = setup({ status: BookingStatus.CONFIRMED });
    await expect(service.applyCoupon(USER, 'bk-1', 'FIRST10')).rejects.toThrow(
      /no longer be re-priced/i,
    );
  });

  it("refuses to re-price somebody else's booking", async () => {
    const { service, bookingUpdate } = setup({ userId: 'someone-else' });
    await expect(service.applyCoupon(USER, 'bk-1', 'FIRST10')).rejects.toThrow(/forbidden/i);
    expect(bookingUpdate).not.toHaveBeenCalled();
  });
});
