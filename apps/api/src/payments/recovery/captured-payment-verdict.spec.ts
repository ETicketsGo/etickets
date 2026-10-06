import { verdictFromOrderPayments } from './captured-payment-verdict';
import type { PaymentStatusResult } from '../provider/payment-provider.interface';

/**
 * The policy at the heart of the 2026-10-06 incident: "nobody paid" and "I could not ask"
 * are different answers, and only one of them permits throwing a booking away.
 *
 * These are plain function tests on purpose. The thing that was wrong in production was a
 * judgement about three-valued evidence, not a wiring problem, so it is tested where the
 * judgement lives rather than through four layers of mocks.
 */
const paid = (over: Partial<PaymentStatusResult> = {}): PaymentStatusResult => ({
  providerRef: 'pay_1',
  status: 'CAPTURED',
  amountMinor: 51_918,
  currency: 'INR',
  ...over,
});

describe('verdictFromOrderPayments', () => {
  it('treats a null answer as unverifiable, NOT as "nobody paid"', () => {
    /*
      The assertion the incident turns on. A provider that cannot be reached must never be
      read as evidence that no payment exists - that is precisely how a captured payment
      becomes an abandoned cart.
    */
    const v = verdictFromOrderPayments(null, 'timeout');
    expect(v.kind).toBe('unverifiable');
    expect(v).toMatchObject({ reason: 'timeout' });
  });

  it('treats an EMPTY list as a real answer: nobody paid', () => {
    // An empty list is the provider saying so. That is releasable, and it is the ordinary
    // abandoned cart - the common case this guard must not slow down or block.
    expect(verdictFromOrderPayments([])).toEqual({ kind: 'none' });
  });

  it('reports a captured payment with the reference the confirm path needs', () => {
    expect(verdictFromOrderPayments([paid()])).toEqual({
      kind: 'captured',
      providerRef: 'pay_1',
      amountMinor: 51_918,
      currency: 'INR',
    });
  });

  it('counts SUCCEEDED as settled too, not only CAPTURED', () => {
    expect(verdictFromOrderPayments([paid({ status: 'SUCCEEDED' })]).kind).toBe('captured');
  });

  it('does not treat a failed attempt as payment', () => {
    expect(verdictFromOrderPayments([paid({ status: 'FAILED' })])).toEqual({ kind: 'none' });
  });

  it('finds the settled attempt among failed siblings', () => {
    /*
      Real orders carry several attempts - a declined card, then a successful UPI. Taking
      the first entry rather than the first SETTLED entry would read a paid order as unpaid
      and release it, which is the incident again by a different route.
    */
    const v = verdictFromOrderPayments([
      paid({ providerRef: 'pay_card', status: 'FAILED' }),
      paid({ providerRef: 'pay_upi', status: 'CAPTURED' }),
    ]);
    expect(v).toMatchObject({ kind: 'captured', providerRef: 'pay_upi' });
  });
});
