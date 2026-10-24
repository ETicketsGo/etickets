import { followPaymentAction } from '../api';
import { paymentIntentSchema, type PaymentIntent } from '../schema';
import { setRazorpayOpenerForTests } from '@/services/razorpay-checkout';

/**
 * The Razorpay branch of followPaymentAction.
 *
 * For a Razorpay booking the API returns an ORDER, and `clientActionUrl` holds the order
 * id. Before this branch existed the app read that id as a URL, refused it as "not a
 * secure web address", and no Indian booking could be paid in the app at all.
 */

const mockPost = jest.fn();
jest.mock('@/services/api-client', () => ({
  apiClient: { post: (...args: unknown[]) => mockPost(...args) },
}));
const mockOpenAuthSession = jest.fn();
jest.mock('expo-web-browser', () => ({
  openAuthSessionAsync: (...args: unknown[]) => mockOpenAuthSession(...args),
}));
jest.mock('expo-linking', () => ({ createURL: (p: string) => `etickets://${p}` }));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid' }));

/** The /pay response as the QA API sends it for an INR booking (razorpay-order.service.ts). */
const apiResponse = {
  providerRef: 'order_Abc123',
  clientActionUrl: 'order_Abc123',
  status: 'REQUIRES_PAYMENT',
  provider: 'razorpay',
  razorpay: {
    keyId: 'rzp_test_public',
    orderId: 'order_Abc123',
    amountMinor: 154938,
    currency: 'INR',
    name: 'ETicketsGo',
    description: 'Event ticket purchase',
    prefill: { name: 'Riya Rao', email: 'riya@example.com' },
    callbackUrl: 'https://qa.eticketsgo.com/checkout/razorpay/callback',
    upiEnabled: false,
  },
};

const intent = (): PaymentIntent => paymentIntentSchema.parse(apiResponse);
const signed = {
  razorpay_payment_id: 'pay_1',
  razorpay_order_id: 'order_Abc123',
  razorpay_signature: 'sig',
};

const mockOpen = jest.fn();
beforeEach(() => {
  mockPost.mockReset().mockResolvedValue({ data: {} });
  mockOpenAuthSession.mockReset();
  mockOpen.mockReset();
  setRazorpayOpenerForTests(mockOpen);
});
afterAll(() => setRazorpayOpenerForTests(null));

describe('followPaymentAction with a Razorpay order', () => {
  it('keeps the order when parsing the /pay response', () => {
    expect(intent().razorpay?.orderId).toBe('order_Abc123');
  });

  it('opens native checkout with the server order, never a browser', async () => {
    mockOpen.mockResolvedValue(signed);

    await followPaymentAction(intent(), 'etickets://booking/bk_1', 'bk_1');

    expect(mockOpenAuthSession).not.toHaveBeenCalled();
    expect(mockOpen).toHaveBeenCalledTimes(1);
    expect(mockOpen.mock.calls[0][0]).toMatchObject({
      key: 'rzp_test_public',
      order_id: 'order_Abc123',
      amount: 154938,
      currency: 'INR',
      prefill: { name: 'Riya Rao', email: 'riya@example.com' },
    });
  });

  it('sends the signature to the server to verify, and reports completed', async () => {
    mockOpen.mockResolvedValue(signed);

    const result = await followPaymentAction(intent(), 'etickets://booking/bk_1', 'bk_1');

    expect(mockPost).toHaveBeenCalledWith('/bookings/bk_1/payments/razorpay/verify', signed);
    expect(result).toEqual({ kind: 'completed' });
  });

  it('still reports completed when verify fails, so the booking status decides', async () => {
    // The webhook, not /verify, confirms the booking. A lost connection during verify
    // must not tell someone who paid that they did not.
    mockOpen.mockResolvedValue(signed);
    mockPost.mockRejectedValue(new Error('network'));

    const result = await followPaymentAction(intent(), 'etickets://booking/bk_1', 'bk_1');

    expect(result).toEqual({ kind: 'completed' });
  });

  it('reports failed with the provider reason when checkout is closed or declined', async () => {
    mockOpen.mockRejectedValue({
      code: 2,
      description: JSON.stringify({ error: { description: 'Payment declined by bank' } }),
    });

    const result = await followPaymentAction(intent(), 'etickets://booking/bk_1', 'bk_1');

    expect(result).toEqual({ kind: 'failed', reason: 'Payment declined by bank' });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('does not verify a success that carries no signature', async () => {
    mockOpen.mockResolvedValue({ razorpay_payment_id: 'pay_1' });

    const result = await followPaymentAction(intent(), 'etickets://booking/bk_1', 'bk_1');

    expect(result).toEqual({ kind: 'failed', reason: null });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('refuses without a booking id rather than paying an order it cannot link', async () => {
    const result = await followPaymentAction(intent(), 'etickets://b');

    expect(result.kind).toBe('unsupported');
    expect(mockOpen).not.toHaveBeenCalled();
  });
});
