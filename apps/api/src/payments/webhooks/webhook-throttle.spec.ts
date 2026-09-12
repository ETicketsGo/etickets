import 'reflect-metadata';
import { RazorpayWebhookController } from '../razorpay/razorpay-webhook.controller';
import { StripeWebhookController } from './stripe/stripe-webhook.controller';
import { PaymentsController } from '../payments.controller';

/**
 * Payment webhooks are exempt from the global per-IP throttle.
 *
 * A provider delivers from a handful of addresses, so during a sale spike 120 requests a
 * minute from one of them is ordinary traffic — and every 429 is a payment confirmation that
 * arrives late, or after the hold has expired. These routes authenticate by signature.
 *
 * `@SkipThrottle()` records `THROTTLER:SKIP<name>` for the default throttler; the guard reads
 * it from the handler and then the class.
 */
const SKIP_DEFAULT = 'THROTTLER:SKIPdefault';

describe('payment webhook throttling', () => {
  it.each([
    ['Razorpay', RazorpayWebhookController],
    ['Stripe', StripeWebhookController],
  ])('the dedicated %s webhook controller is not throttled', (_name, controller) => {
    expect(Reflect.getMetadata(SKIP_DEFAULT, controller)).toBe(true);
  });

  it('the generic webhook routes are not throttled', () => {
    expect(Reflect.getMetadata(SKIP_DEFAULT, PaymentsController.prototype.webhook)).toBe(true);
    expect(Reflect.getMetadata(SKIP_DEFAULT, PaymentsController.prototype.routedWebhook)).toBe(
      true,
    );
  });

  it('the rest of the payments controller keeps its throttle', () => {
    // Collecting cash and simulating a payment are ordinary requests from people.
    expect(Reflect.getMetadata(SKIP_DEFAULT, PaymentsController)).toBeUndefined();
    expect(
      Reflect.getMetadata(SKIP_DEFAULT, PaymentsController.prototype.collectCash),
    ).toBeUndefined();
    expect(Reflect.getMetadata(SKIP_DEFAULT, PaymentsController.prototype.mockPay)).toBeUndefined();
  });
});
