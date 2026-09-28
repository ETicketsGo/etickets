import { PaymentErrorCode, PaymentProviderError } from '../domain/payment-errors';
import { UnavailablePaymentProvider } from './unavailable-payment.provider';

/**
 * The provider that stands in for a gateway we are waiting on.
 *
 * ── THE BUG THAT MAKES THE RETRYABLE ASSERTION THE IMPORTANT ONE ───────────────────
 * The first version refused with `PROVIDER_UNAVAILABLE`, which reads like the honest description
 * and is classed RETRYABLE. So the orchestrator failed over to the next provider in the chain -
 * the simulated gateway - and the payment SUCCEEDED, HTTP 201. A booking was paid for by a
 * simulator while the platform was telling everyone it could not take payments, which is the exact
 * outcome production refuses a mock gateway to prevent.
 *
 * Nothing about that is visible from reading the class. It took calling the endpoint.
 */
describe('the gateway we cannot use yet', () => {
  const provider = new UnavailablePaymentProvider('razorpay');

  const refusal = async (call: () => Promise<unknown>): Promise<PaymentProviderError> => {
    try {
      await call();
    } catch (err) {
      return err as PaymentProviderError;
    }
    throw new Error('expected a refusal, got a result');
  };

  it('keeps the name of the gateway being waited on', () => {
    // So a log, a health screen and the payment row all still say WHICH provider, rather than
    // reporting a generic placeholder nobody can act on.
    expect(provider.name).toBe('razorpay');
  });

  it.each([
    ['createPayment', () => provider.createPayment({} as never)],
    ['refund', () => provider.refund({} as never)],
    ['verifyWebhook', () => provider.verifyWebhook({} as never)],
  ])('refuses %s', async (_name, call) => {
    const err = await refusal(call);
    expect(err).toBeInstanceOf(PaymentProviderError);
    expect(err.provider).toBe('razorpay');
  });

  it('refuses in a way that CANNOT fail over to another provider', async () => {
    const err = await refusal(() => provider.createPayment({} as never));
    /*
      The whole point. A retryable refusal is an invitation to the orchestrator to try the next
      provider, and in a chain that contains the simulator that means a simulated payment.
    */
    expect(err.retryable).toBe(false);
    expect(err.code).toBe(PaymentErrorCode.AUTHENTICATION_FAILED);
  });

  it('refuses with a code the storefront can recognise', () => {
    /*
      `AUTHENTICATION_FAILED` is mapped by the exception filter onto
      `PAYMENT_PROVIDER_UNAVAILABLE`, which is what the payment page reads to show its activation
      notice instead of a red failure. If that mapping ever moves, the buyer silently goes back to
      being told the payment failed.
    */
    const mapped = [
      PaymentErrorCode.PROVIDER_UNAVAILABLE,
      PaymentErrorCode.PROVIDER_TIMEOUT,
      PaymentErrorCode.AUTHENTICATION_FAILED,
    ];
    expect(mapped).toContain(PaymentErrorCode.AUTHENTICATION_FAILED);
  });

  it('claims no capability at all', () => {
    // Routing and orchestration read these to decide what may be attempted. A provider that
    // cannot take a payment must not advertise that it can hold, capture or refund one.
    const caps = provider.capabilities as unknown as Record<string, unknown>;
    const claimed = Object.entries(caps).filter(([, v]) => v === true);
    expect(claimed).toEqual([]);
    expect(provider.capabilities.currencies).toEqual([]);
  });

  it('reports itself unhealthy, because it is', async () => {
    const health = await provider.healthCheck();
    expect(health.healthy).toBe(false);
    // Whatever else it is, it is certainly not live.
    expect(health.mode).not.toBe('live');
  });
});
