import { Logger } from '@nestjs/common';
import {
  METHODS_FAILURE_TTL_MS,
  METHODS_TIMEOUT_MS,
  METHODS_TTL_MS,
  RazorpayMethodsService,
} from './razorpay-methods.service';

/**
 * Whether the storefront may pin "Pay by any UPI App" to the top of Razorpay Checkout.
 *
 * The block is only safe when the account actually offers UPI — the QA account does not —
 * so every way of NOT knowing must answer false and Checkout must still open.
 */

/** A fake, obviously-not-real public key id. */
const KEY = 'rzp_test_FAKEKEY000000';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('RazorpayMethodsService', () => {
  let fetchMock: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-12T10:00:00Z'));
    fetchMock = jest.spyOn(global, 'fetch');
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('asks the public preferences preflight with the key id and currency, and nothing secret', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ methods: { upi: true } }));
    await new RazorpayMethodsService().upiEnabled(KEY, 'INR');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(`${url.origin}${url.pathname}`).toBe('https://api.razorpay.com/v1/preferences');
    expect(url.searchParams.get('key_id')).toBe(KEY);
    expect(url.searchParams.get('currency')).toBe('INR');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(init.headers ?? {})).not.toMatch(/authorization/i);
  });

  it('answers true when the account reports UPI enabled', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ methods: { upi: true, card: true } }));
    await expect(new RazorpayMethodsService().upiEnabled(KEY)).resolves.toBe(true);
  });

  it('answers false when the account reports UPI disabled (the QA account today)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ methods: { upi: false, card: true } }));
    await expect(new RazorpayMethodsService().upiEnabled(KEY)).resolves.toBe(false);
  });

  it('answers false when methods.upi is missing or not a boolean', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ methods: { card: true } }));
    await expect(new RazorpayMethodsService().upiEnabled(KEY)).resolves.toBe(false);
    fetchMock.mockResolvedValueOnce(jsonResponse({ methods: { upi: 'yes' } }));
    await expect(new RazorpayMethodsService().upiEnabled(KEY)).resolves.toBe(false);
  });

  it('caches the answer: a second call within the TTL does not ask again', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ methods: { upi: true } }));
    const svc = new RazorpayMethodsService();

    await expect(svc.upiEnabled(KEY)).resolves.toBe(true);
    jest.advanceTimersByTime(METHODS_TTL_MS - 1_000);
    await expect(svc.upiEnabled(KEY)).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks again once the TTL has passed, so switching UPI on in the dashboard shows up without a deploy', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ methods: { upi: false } }))
      .mockResolvedValueOnce(jsonResponse({ methods: { upi: true } }));
    const svc = new RazorpayMethodsService();

    await expect(svc.upiEnabled(KEY)).resolves.toBe(false);
    jest.advanceTimersByTime(METHODS_TTL_MS + 1);
    await expect(svc.upiEnabled(KEY)).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares one lookup between concurrent payments', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ methods: { upi: true } }));
    const svc = new RazorpayMethodsService();

    const answers = await Promise.all([svc.upiEnabled(KEY), svc.upiEnabled(KEY)]);

    expect(answers).toEqual([true, true]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed on an HTTP error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'BAD_REQUEST_ERROR' } }, 500));
    await expect(new RazorpayMethodsService().upiEnabled(KEY)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 500'));
  });

  it('fails closed on a network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(new RazorpayMethodsService().upiEnabled(KEY)).resolves.toBe(false);
  });

  it('fails closed on a body that is not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('<html>gateway error</html>', { status: 200 }));
    await expect(new RazorpayMethodsService().upiEnabled(KEY)).resolves.toBe(false);
  });

  it('fails closed on a timeout, aborting the request instead of holding the buyer up', async () => {
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          signal = init.signal ?? undefined;
          signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })),
          );
        }),
    );

    const answer = new RazorpayMethodsService().upiEnabled(KEY);
    await jest.advanceTimersByTimeAsync(METHODS_TIMEOUT_MS);

    await expect(answer).resolves.toBe(false);
    expect(signal?.aborted).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('timed out'));
  });

  it('remembers a failure only briefly, then asks again', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse({ methods: { upi: true } }));
    const svc = new RazorpayMethodsService();

    await expect(svc.upiEnabled(KEY)).resolves.toBe(false);
    // An outage must not add a 3s wait to every payment...
    jest.advanceTimersByTime(METHODS_FAILURE_TTL_MS - 1_000);
    await expect(svc.upiEnabled(KEY)).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // ...nor hide UPI for the full ten minutes once Razorpay is answering again.
    jest.advanceTimersByTime(2_000);
    await expect(svc.upiEnabled(KEY)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never writes the key id into the log', async () => {
    fetchMock.mockRejectedValue(new TypeError(`fetch failed for ...?key_id=${KEY}`));
    await new RazorpayMethodsService().upiEnabled(KEY);
    expect(warn).toHaveBeenCalled();
    for (const call of warn.mock.calls) expect(JSON.stringify(call)).not.toContain(KEY);
  });
});
