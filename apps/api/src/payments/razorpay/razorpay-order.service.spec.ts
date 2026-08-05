import { RazorpayOrderService, type RazorpayBookingContext } from './razorpay-order.service';
import type { MarketplaceSplit } from '@eticketsgo/shared-types';

const split: MarketplaceSplit = {
  totalMinor: 150000,
  subtotalMinor: 140000,
  taxMinor: 0,
  platformFeeMinor: 10000,
  organizerNetMinor: 140000,
};
const booking: RazorpayBookingContext = {
  id: 'b1',
  currency: 'INR',
  totalMinor: 150000,
  buyerName: 'Asha',
  buyerEmail: 'asha@example.test',
  userId: 'u1',
};

function makeService(opts: {
  payment?: Record<string, unknown> | null;
  bookingRow?: Record<string, unknown> | null;
  verifyResult?: boolean;
}) {
  const updates: Array<Record<string, unknown>> = [];
  const attempts: Array<Record<string, unknown>> = [];
  const createPayment = jest
    .fn()
    .mockResolvedValue({ providerRef: 'order_new', clientActionUrl: 'order_new' });
  const provider = {
    name: 'razorpay',
    createPayment,
    verifyCheckoutSignature: jest.fn().mockReturnValue(opts.verifyResult ?? true),
  };
  const prisma = {
    payment: {
      findUnique: jest.fn().mockResolvedValue(opts.payment ?? null),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return data;
      }),
    },
    booking: { findUnique: jest.fn().mockResolvedValue(opts.bookingRow ?? null) },
    paymentAttempt: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        attempts.push(data);
        return data;
      }),
    },
  };
  const resolver = { get: jest.fn().mockReturnValue(provider) };
  const config = {
    get: (k: string) =>
      ({ RAZORPAY_CHECKOUT_NAME: 'ETicketsGo', RAZORPAY_CALLBACK_URL: 'http://cb' })[k],
    getOrThrow: () => 'rzp_test_key',
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new RazorpayOrderService(
    prisma as never,
    resolver as never,
    config as never,
    audit as never,
  );
  return { service, prisma, provider, createPayment, updates, attempts };
}

describe('RazorpayOrderService.createOrder', () => {
  it('creates an Order and stores the split, provider, and order id (no PII in payload notes)', async () => {
    const { service, updates, createPayment } = makeService({
      payment: { status: 'REQUIRES_PAYMENT' },
    });
    const out = await service.createOrder(booking, split, { eventId: 'e1', organizerId: 'org1' });
    expect(createPayment).toHaveBeenCalled();
    expect(out.provider).toBe('razorpay');
    expect(out.razorpay.orderId).toBe('order_new');
    expect(out.razorpay.keyId).toBe('rzp_test_key');
    // key secret is never present
    expect(JSON.stringify(out)).not.toContain('secret');
    expect(updates[0]).toMatchObject({
      provider: 'razorpay',
      providerOrderId: 'order_new',
      organizerNetMinor: 140000,
    });
  });

  it('is retry-safe: an existing pending order is returned, no second Order created', async () => {
    const { service, createPayment } = makeService({
      payment: { status: 'PROCESSING', providerOrderId: 'order_existing' },
    });
    const out = await service.createOrder(booking, split, {});
    expect(createPayment).not.toHaveBeenCalled();
    expect(out.razorpay.orderId).toBe('order_existing');
  });
});

describe('RazorpayOrderService.verify', () => {
  const bookingRow = (over: Record<string, unknown> = {}) => ({
    id: 'b1',
    userId: 'u1',
    status: 'PENDING_PAYMENT',
    organizationId: 'org1',
    payment: { id: 'p1', providerOrderId: 'order_1' },
    ...over,
  });
  const validBody = {
    razorpay_order_id: 'order_1',
    razorpay_payment_id: 'pay_1',
    razorpay_signature: 'sig',
  };
  const user = { id: 'u1', roles: ['CUSTOMER'] } as never;

  it('verifies a valid signature, records the attempt, and does NOT confirm (webhook is authoritative)', async () => {
    const { service, attempts } = makeService({ bookingRow: bookingRow(), verifyResult: true });
    const out = await service.verify('b1', validBody, user);
    expect(out.status).toBe('processing');
    expect(attempts.some((a) => a.status === 'CREATED')).toBe(true);
  });

  it('rejects a signature mismatch and records a failed attempt', async () => {
    const { service, attempts } = makeService({ bookingRow: bookingRow(), verifyResult: false });
    await expect(service.verify('b1', validBody, user)).rejects.toThrow(/signature/i);
    expect(attempts.some((a) => a.status === 'FAILED')).toBe(true);
  });

  it('rejects when the returned order id does not match the stored order', async () => {
    const { service } = makeService({
      bookingRow: bookingRow({ payment: { id: 'p1', providerOrderId: 'other' } }),
    });
    await expect(service.verify('b1', validBody, user)).rejects.toThrow(/order id/i);
  });

  it('is idempotent when the booking is already confirmed', async () => {
    const { service } = makeService({ bookingRow: bookingRow({ status: 'CONFIRMED' }) });
    expect(await service.verify('b1', validBody, user)).toEqual({
      status: 'confirmed',
      bookingId: 'b1',
    });
  });
});
