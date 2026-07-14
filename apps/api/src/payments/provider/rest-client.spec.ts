import { currencyExponent, minorToDecimalString, requestJson } from './rest-client';
import { PaymentErrorCode, PaymentProviderError } from '../domain/payment-errors';

describe('currency formatting', () => {
  it('knows minor-unit exponents', () => {
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('BHD')).toBe(3);
  });
  it('formats minor units as decimal strings', () => {
    expect(minorToDecimalString(1050, 'USD')).toBe('10.50');
    expect(minorToDecimalString(5, 'USD')).toBe('0.05');
    expect(minorToDecimalString(1000, 'JPY')).toBe('1000');
    expect(minorToDecimalString(1234, 'BHD')).toBe('1.234');
  });
});

describe('requestJson error classification', () => {
  const okFetch = (status: number, body: unknown) =>
    jest.fn(() =>
      Promise.resolve({ ok: status < 400, status, text: async () => JSON.stringify(body) }),
    );

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (global as any).fetch;
  });

  it('returns parsed data on 2xx', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = okFetch(200, { hello: 'world' });
    const res = await requestJson<{ hello: string }>('x', 'http://t');
    expect(res.data.hello).toBe('world');
  });

  it('maps 401 to AUTHENTICATION_FAILED (terminal)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = okFetch(401, { message: 'nope' });
    await expect(requestJson('x', 'http://t')).rejects.toMatchObject({
      code: PaymentErrorCode.AUTHENTICATION_FAILED,
    });
  });

  it('maps 5xx to PROVIDER_UNAVAILABLE (retryable)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = okFetch(503, { message: 'down' });
    const err = await requestJson('x', 'http://t').catch((e) => e);
    expect(err).toBeInstanceOf(PaymentProviderError);
    expect(err.retryable).toBe(true);
  });

  it('maps a connection failure to PROVIDER_UNAVAILABLE', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = jest.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    await expect(requestJson('x', 'http://t')).rejects.toMatchObject({
      code: PaymentErrorCode.PROVIDER_UNAVAILABLE,
    });
  });
});
