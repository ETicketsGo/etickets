import { RazorpayOrderService } from './razorpay-order.service';

/**
 * Where Razorpay returns the buyer after they pay.
 *
 * ── THE DEFECT THIS LOCKS DOWN ─────────────────────────────────────────────────────
 * `RAZORPAY_CALLBACK_URL` used to default to `http://localhost:3000/...`. The moment real
 * test keys were added to QA, that string was handed to Razorpay — so a customer who paid
 * would have been redirected to a machine that is not theirs, losing the confirmation
 * AFTER the money moved. It failed silently, because a default is not a missing value.
 *
 * It is the third variable on this platform to ship a localhost default (invite links and
 * the password-reset link were the first two), which is why the fix derives it from the one
 * place that already knows where the customer site lives instead of adding a fourth knob.
 */
describe('Razorpay checkout callback URL', () => {
  /** Only the config is exercised, so the rest of the service is never constructed. */
  const callbackFor = (env: Record<string, string | undefined>) => {
    const svc = Object.create(RazorpayOrderService.prototype) as RazorpayOrderService;
    (svc as unknown as { config: { get: (k: string) => string | undefined } }).config = {
      get: (k: string) => env[k],
    };
    return (svc as unknown as { checkoutCallbackUrl: () => string }).checkoutCallbackUrl();
  };

  it('derives from the customer site, so there is nothing to forget', () => {
    expect(callbackFor({ CUSTOMER_WEB_URL: 'https://qa.eticketsgo.com', APP_ENV: 'QA' })).toBe(
      'https://qa.eticketsgo.com/checkout/razorpay/callback',
    );
  });

  it('tolerates a trailing slash rather than emitting a double one', () => {
    expect(callbackFor({ CUSTOMER_WEB_URL: 'https://qa.eticketsgo.com/', APP_ENV: 'QA' })).toBe(
      'https://qa.eticketsgo.com/checkout/razorpay/callback',
    );
  });

  it('honours an explicit override, for a callback that is not the storefront', () => {
    expect(
      callbackFor({
        RAZORPAY_CALLBACK_URL: 'https://pay.example.test/return',
        CUSTOMER_WEB_URL: 'https://qa.eticketsgo.com',
        APP_ENV: 'QA',
      }),
    ).toBe('https://pay.example.test/return');
  });

  it('still points at localhost on a laptop, where that is correct', () => {
    expect(callbackFor({ APP_ENV: 'LOCAL' })).toBe(
      'http://localhost:3000/checkout/razorpay/callback',
    );
  });

  it('REFUSES to start a payment rather than return a buyer to localhost', () => {
    /*
      The whole point. An error an operator can read and fix in a minute, instead of a
      customer who pays and lands nowhere — and nobody finds out until they complain.
      Keyed on APP_ENV because QA and UAT both run NODE_ENV=production.
    */
    expect(() => callbackFor({ APP_ENV: 'QA' })).toThrow(/CUSTOMER_WEB_URL/);
    expect(() => callbackFor({ APP_ENV: 'PRODUCTION' })).toThrow(/returned to localhost/);
  });
});
