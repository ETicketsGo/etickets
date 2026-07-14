import { ConfigService } from '@nestjs/config';
import { PayPalPaymentProvider } from './paypal-payment.provider';
import { PaymentProviderError } from '../domain/payment-errors';

/** Route a mocked fetch by URL substring → { ok, status, body }. */
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

function makeProvider(over: Record<string, string> = {}): PayPalPaymentProvider {
  const values: Record<string, string> = {
    PAYPAL_CLIENT_ID: 'id',
    PAYPAL_CLIENT_SECRET: 'secret',
    PAYPAL_WEBHOOK_ID: 'wh_1',
    PAYPAL_API_BASE_URL: 'https://api-m.sandbox.paypal.com',
    ...over,
  };
  const config = { get: (k: string) => values[k] } as unknown as ConfigService;
  return new PayPalPaymentProvider(config);
}

const input = {
  bookingId: 'bk_1',
  amountMinor: 1050,
  currency: 'USD',
  buyerEmail: 'a@b.c',
  idempotencyKey: 'bk_1',
};

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (global as any).fetch;
});

describe('PayPalPaymentProvider', () => {
  it('declares capabilities and the paypal webhook header', () => {
    const p = makeProvider();
    expect(p.name).toBe('paypal');
    expect(p.webhookSignatureHeader).toBe('paypal-transmission-sig');
    expect(p.capabilities.currencies).toContain('USD');
  });

  it('createPayment mints an order and returns the approval link (amount as decimal)', async () => {
    const fetch = mockFetch([
      { match: '/v1/oauth2/token', body: { access_token: 'tok' } },
      {
        match: '/v2/checkout/orders',
        body: { id: 'ORD1', links: [{ rel: 'payer-action', href: 'https://paypal/approve' }] },
      },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = fetch;
    const res = await makeProvider().createPayment(input);
    expect(res).toEqual({
      providerRef: 'ORD1',
      clientActionUrl: 'https://paypal/approve',
      status: 'REQUIRES_PAYMENT',
    });
    const orderCall = fetch.mock.calls.find((c) => String(c[0]).includes('/orders'));
    expect(
      JSON.parse((orderCall![1] as { body: string }).body).purchase_units[0].amount.value,
    ).toBe('10.50');
  });

  it('healthCheck reports test mode when the token call succeeds', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = mockFetch([{ match: '/oauth2/token', body: { access_token: 't' } }]);
    expect(await makeProvider().healthCheck()).toEqual({ healthy: true, mode: 'test' });
  });

  it('healthCheck reports unhealthy on auth failure', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = mockFetch([
      { match: '/oauth2/token', ok: false, status: 401, body: { error_description: 'bad creds' } },
    ]);
    const res = await makeProvider().healthCheck();
    expect(res.healthy).toBe(false);
  });

  it('refund posts a partial refund with the given currency', async () => {
    const fetch = mockFetch([
      { match: '/oauth2/token', body: { access_token: 't' } },
      { match: '/refund', body: { id: 'RF1', status: 'COMPLETED' } },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = fetch;
    const res = await makeProvider().refund({
      providerRef: 'CAP1',
      amountMinor: 500,
      currency: 'USD',
    });
    expect(res).toEqual({ providerRef: 'RF1', status: 'COMPLETED' });
  });

  it('verifyWebhook confirms via the verify endpoint then parses the event', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = mockFetch([
      { match: '/oauth2/token', body: { access_token: 't' } },
      { match: '/verify-webhook-signature', body: { verification_status: 'SUCCESS' } },
    ]);
    const rawBody = JSON.stringify({
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: {
        id: 'CAP1',
        custom_id: 'bk_1',
        amount: { value: '10.50', currency_code: 'USD' },
      },
    });
    const signature = JSON.stringify({ transmissionId: 't', transmissionSig: 's' });
    const event = await makeProvider().verifyWebhook({ rawBody, signature });
    expect(event).toEqual({
      type: 'payment.succeeded',
      providerRef: 'CAP1',
      bookingId: 'bk_1',
      amountMinor: 1050,
    });
  });

  it('verifyWebhook rejects a failed verification', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = mockFetch([
      { match: '/oauth2/token', body: { access_token: 't' } },
      { match: '/verify-webhook-signature', body: { verification_status: 'FAILURE' } },
    ]);
    await expect(
      makeProvider().verifyWebhook({ rawBody: '{}', signature: '{}' }),
    ).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it('detects live mode from a production base URL', () => {
    const p = makeProvider({ PAYPAL_API_BASE_URL: 'https://api-m.paypal.com' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = mockFetch([{ match: '/oauth2/token', body: { access_token: 't' } }]);
    return p.healthCheck().then((r) => expect(r.mode).toBe('live'));
  });
});
