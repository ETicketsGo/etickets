import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { SquarePaymentProvider } from './square-payment.provider';
import { PaymentProviderError } from '../domain/payment-errors';

function mockFetch(routes: { match: string; ok?: boolean; status?: number; body: unknown }[]) {
  return jest.fn((url: string, _init?: { body?: string; headers?: Record<string, string> }) => {
    void _init;
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error(`unexpected fetch: ${url}`);
    return Promise.resolve({
      ok: route.ok ?? true,
      status: route.status ?? 200,
      text: async () => JSON.stringify(route.body),
    });
  });
}

const WEBHOOK_URL = 'https://etg.test/api/payments/square/webhook';
const SIGN_KEY = 'sign_key_123';

function makeProvider(over: Record<string, string> = {}): SquarePaymentProvider {
  const values: Record<string, string> = {
    SQUARE_ACCESS_TOKEN: 'tok',
    SQUARE_LOCATION_ID: 'LOC1',
    SQUARE_API_BASE_URL: 'https://connect.squareupsandbox.com',
    SQUARE_WEBHOOK_SIGNATURE_KEY: SIGN_KEY,
    SQUARE_WEBHOOK_URL: WEBHOOK_URL,
    ...over,
  };
  const config = { get: (k: string) => values[k] } as unknown as ConfigService;
  return new SquarePaymentProvider(config);
}

const input = {
  bookingId: 'bk_1',
  amountMinor: 2000,
  currency: 'USD',
  buyerEmail: 'a@b.c',
  idempotencyKey: 'bk_1',
};

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (global as any).fetch;
});

describe('SquarePaymentProvider', () => {
  it('declares capabilities and the square webhook header', () => {
    const p = makeProvider();
    expect(p.name).toBe('square');
    expect(p.webhookSignatureHeader).toBe('x-square-hmacsha256-signature');
    expect(p.capabilities.supportsApplePay).toBe(true);
  });

  it('createPayment creates a payment link (amount in minor units) and returns the url', async () => {
    const fetch = mockFetch([
      {
        match: '/online-checkout/payment-links',
        body: { payment_link: { id: 'PL1', url: 'https://sq/checkout', order_id: 'ORD1' } },
      },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = fetch;
    const res = await makeProvider().createPayment(input);
    expect(res).toEqual({
      providerRef: 'ORD1',
      clientActionUrl: 'https://sq/checkout',
      status: 'REQUIRES_PAYMENT',
    });
    const body = JSON.parse((fetch.mock.calls[0][1] as { body: string }).body);
    expect(body.order.line_items[0].base_price_money.amount).toBe(2000);
    expect(body.order.reference_id).toBe('bk_1');
  });

  it('verifyWebhook accepts a correctly HMAC-signed body and parses the event', async () => {
    const rawBody = JSON.stringify({
      type: 'payment.updated',
      data: {
        object: {
          payment: {
            id: 'PAY1',
            status: 'COMPLETED',
            reference_id: 'bk_1',
            amount_money: { amount: 2000, currency: 'USD' },
          },
        },
      },
    });
    const signature = createHmac('sha256', SIGN_KEY)
      .update(WEBHOOK_URL + rawBody)
      .digest('base64');
    const event = await makeProvider().verifyWebhook({ rawBody, signature });
    expect(event).toEqual({
      type: 'payment.succeeded',
      providerRef: 'PAY1',
      bookingId: 'bk_1',
      amountMinor: 2000,
    });
  });

  it('verifyWebhook rejects a wrong signature', async () => {
    await expect(
      makeProvider().verifyWebhook({ rawBody: '{}', signature: 'wrong' }),
    ).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it('refund posts to /v2/refunds with amount + currency', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = mockFetch([
      { match: '/v2/refunds', body: { refund: { id: 'RF1', status: 'COMPLETED' } } },
    ]);
    const res = await makeProvider().refund({
      providerRef: 'PAY1',
      amountMinor: 500,
      currency: 'USD',
    });
    expect(res).toEqual({ providerRef: 'RF1', status: 'COMPLETED' });
  });

  it('refund fails fast without a currency', async () => {
    await expect(
      makeProvider().refund({ providerRef: 'PAY1', amountMinor: 500 }),
    ).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it('healthCheck hits /v2/locations and reports test mode', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = mockFetch([{ match: '/v2/locations', body: { locations: [] } }]);
    expect(await makeProvider().healthCheck()).toEqual({ healthy: true, mode: 'test' });
  });
});
