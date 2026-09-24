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
  upiEnabled?: boolean;
  /** The account row behind `booking.userId`, for the Razorpay contact prefill. */
  user?: { phone: string | null; phoneVerifiedAt: Date | null } | null;
  /** A database that will not answer, to prove a prefill cannot stop a payment. */
  userLookupFails?: boolean;
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
    user: {
      findUnique: jest.fn(async () => {
        if (opts.userLookupFails) throw new Error('database unavailable');
        return opts.user ?? null;
      }),
    },
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
  const methods = { upiEnabled: jest.fn().mockResolvedValue(opts.upiEnabled ?? false) };
  const service = new RazorpayOrderService(
    prisma as never,
    resolver as never,
    config as never,
    audit as never,
    methods as never,
  );
  return { service, prisma, provider, createPayment, updates, attempts, methods };
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

  /*
    Whether Checkout may lead with "Pay by any UPI App". The answer comes from the account
    (RazorpayMethodsService), asked with the public key id and the booking's currency.
  */
  it('tells the storefront UPI is enabled when the account offers it', async () => {
    const { service, methods } = makeService({
      payment: { status: 'REQUIRES_PAYMENT' },
      upiEnabled: true,
    });
    const out = await service.createOrder(booking, split, {});
    expect(out.razorpay.upiEnabled).toBe(true);
    expect(methods.upiEnabled).toHaveBeenCalledWith('rzp_test_key', 'INR');
  });

  it('tells the storefront UPI is NOT enabled when the account does not offer it', async () => {
    const { service } = makeService({ payment: { status: 'REQUIRES_PAYMENT' }, upiEnabled: false });
    const out = await service.createOrder(booking, split, {});
    expect(out.razorpay.upiEnabled).toBe(false);
    // Everything else the Checkout needs is still there.
    expect(out.razorpay).toMatchObject({
      keyId: 'rzp_test_key',
      orderId: 'order_new',
      amountMinor: 150000,
      currency: 'INR',
      callbackUrl: 'http://cb',
    });
  });

  it('carries upiEnabled on the retry-safe path too', async () => {
    const { service } = makeService({
      payment: { status: 'PROCESSING', providerOrderId: 'order_existing' },
      upiEnabled: true,
    });
    const out = await service.createOrder(booking, split, {});
    expect(out.razorpay.upiEnabled).toBe(true);
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

/**
 * The phone number Razorpay insists on.
 *
 * Asked by the owner after a QA purchase: "razorpay is asking mobile and email is mandatory
 * details, I hope it is not from our end right?". It is Razorpay Checkout's own rule and we
 * cannot switch it off - but we were prefilling only the name and the email, so a signed-in
 * buyer typed a number they had already proved to us, on the last screen before paying.
 *
 * What may be prefilled is narrow on purpose. Only the account's stored `phone`, which exists
 * only after an OTP was answered. Never the booking's own contact fields: a guest types those,
 * and prefilling a payment screen with an unproved number is how a stranger's phone gets onto
 * somebody's payment.
 */
describe('the Razorpay contact prefill', () => {
  const verified = { phone: '+919876500000', phoneVerifiedAt: new Date('2026-01-01') };

  it('prefills the account’s verified phone', async () => {
    const { service } = makeService({ payment: { status: 'REQUIRES_PAYMENT' }, user: verified });
    const out = await service.createOrder(booking, split, { eventId: 'e1', organizerId: 'org1' });
    expect(out.razorpay.prefill).toEqual({
      name: 'Asha',
      email: 'asha@example.test',
      contact: '+919876500000',
    });
  });

  it('sends no contact when the number was never verified', async () => {
    // An unverified number is not stored at all, so this is the shape of a half-written row.
    const { service } = makeService({
      payment: { status: 'REQUIRES_PAYMENT' },
      user: { phone: '+919876500000', phoneVerifiedAt: null },
    });
    const out = await service.createOrder(booking, split, { eventId: 'e1', organizerId: 'org1' });
    expect(out.razorpay.prefill).not.toHaveProperty('contact');
  });

  it('sends no contact for a guest, who has no account to read one from', async () => {
    const { service, prisma } = makeService({ payment: { status: 'REQUIRES_PAYMENT' } });
    const out = await service.createOrder({ ...booking, userId: null }, split, {
      eventId: 'e1',
      organizerId: 'org1',
    });
    expect(out.razorpay.prefill).not.toHaveProperty('contact');
    // And no pointless query: there is nobody to look up.
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('still opens the checkout when the account cannot be read at all', async () => {
    // A convenience must never be able to stop somebody paying.
    const { service } = makeService({
      payment: { status: 'REQUIRES_PAYMENT' },
      userLookupFails: true,
    });
    const out = await service.createOrder(booking, split, { eventId: 'e1', organizerId: 'org1' });
    expect(out.razorpay.orderId).toBe('order_new');
    expect(out.razorpay.prefill).not.toHaveProperty('contact');
  });
});
