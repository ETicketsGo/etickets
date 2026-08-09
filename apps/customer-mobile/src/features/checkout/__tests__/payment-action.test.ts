import { followPaymentAction } from '../api';
import type { PaymentIntent } from '../schema';

/**
 * `followPaymentAction` decides what to do with a URL that arrived over the network,
 * which makes it the app's only remote-controlled navigation. These tests pin the three
 * branches, and in particular pin the refusal — a regression there would let a
 * compromised or spoofed response send the user somewhere of its choosing.
 */

// jest hoists mock factories above these declarations, so the names must carry the
// `mock` prefix that jest whitelists — otherwise the factory closes over a TDZ binding.
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

const intent = (clientActionUrl: string | null): PaymentIntent => ({
  providerRef: 'ref_123',
  clientActionUrl,
  status: 'REQUIRES_PAYMENT',
});

beforeEach(() => {
  mockPost.mockReset().mockResolvedValue({ data: {} });
  mockOpenAuthSession.mockReset().mockResolvedValue({ type: 'success' });
});

describe('followPaymentAction', () => {
  it('POSTs a relative action to our own API, stripping the duplicated /api prefix', async () => {
    // apiClient's baseURL already ends in /api, so posting the URL verbatim would hit
    // /api/api/payments/... — a 404 that looks like a payment failure.
    const result = await followPaymentAction(
      intent('/api/payments/bk_1/mock-pay'),
      'etickets://booking/bk_1',
    );

    expect(mockPost).toHaveBeenCalledWith('/payments/bk_1/mock-pay', {});
    expect(mockOpenAuthSession).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: 'completed' });
  });

  /**
   * REGRESSION: this call used to be `apiClient.post(path)` with no second argument, so
   * axios sent no request body. Nest then hands `@Body()` `undefined`, and a Zod object
   * schema rejects undefined even when every field in it has a default — the gateway's
   * `{ outcome: enum.default('succeeded') }` 400d before any payment logic ran.
   *
   * The whole booking flow died there on a real Android device: seats held, money not
   * taken, and "The request failed validation." on screen. The previous version of the
   * test above asserted `toHaveBeenCalledWith(path)` with no body, so it pinned the
   * broken shape rather than catching it. An explicit body assertion is the fix.
   */
  it('sends an empty object body, because a bodyless POST fails server validation', async () => {
    await followPaymentAction(intent('/api/payments/bk_1/mock-pay'), 'etickets://booking/bk_1');

    const [, body] = mockPost.mock.calls[0];
    expect(body).toBeDefined();
    expect(body).toEqual({});
  });

  it('opens an absolute https provider page in the system browser', async () => {
    const result = await followPaymentAction(
      intent('https://checkout.stripe.com/c/pay/cs_test_123'),
      'etickets://booking/bk_1',
    );

    expect(mockOpenAuthSession).toHaveBeenCalledWith(
      'https://checkout.stripe.com/c/pay/cs_test_123',
      'etickets://booking/bk_1',
    );
    expect(mockPost).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: 'completed' });
  });

  it('reports dismissal when the user closes the browser without finishing', async () => {
    mockOpenAuthSession.mockResolvedValue({ type: 'cancel' });

    const result = await followPaymentAction(intent('https://pay.example.com/x'), 'etickets://b');

    // Crucially NOT 'completed' — the hold is still alive and the user can retry.
    expect(result).toEqual({ kind: 'dismissed' });
  });

  it.each([
    ['http://insecure.example.com/pay', 'plain http'],
    ['javascript:alert(1)', 'a script URL'],
    ['intent://scan/#Intent;scheme=zxing;end', 'an Android intent URL'],
    ['file:///etc/passwd', 'a file URL'],
  ])('refuses to follow %s (%s)', async (url) => {
    const result = await followPaymentAction(intent(url), 'etickets://b');

    expect(result.kind).toBe('unsupported');
    expect(mockOpenAuthSession).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('reports unsupported when the provider returned no action at all', async () => {
    const result = await followPaymentAction(intent(null), 'etickets://b');

    expect(result.kind).toBe('unsupported');
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockOpenAuthSession).not.toHaveBeenCalled();
  });
});
