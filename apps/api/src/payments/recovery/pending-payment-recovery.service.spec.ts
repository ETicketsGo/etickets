import { PendingPaymentRecoveryService } from './pending-payment-recovery.service';

/**
 * The guard's decisions, including the ones that must NOT release stock.
 *
 * Every test here answers the same question in a different state of the world: is this
 * lapsed booking an abandoned cart, or is it a payment we have not been told about?
 */
describe('PendingPaymentRecoveryService', () => {
  function make(
    providerImpl: Record<string, unknown> | null,
    processVerifiedEvent = jest.fn().mockResolvedValue({ status: 'confirmed' }),
  ) {
    const resolver = {
      get: jest.fn(() => {
        if (!providerImpl) throw new Error('no such provider');
        return providerImpl;
      }),
    };
    const payments = { processVerifiedEvent };
    const metrics = { recordPaymentWebhook: jest.fn() };
    const service = new PendingPaymentRecoveryService(
      resolver as never,
      payments as never,
      metrics as never,
    );
    return { service, payments, metrics, processVerifiedEvent };
  }

  const gatewayOpened = {
    id: 'bk1',
    payment: { provider: 'razorpay', status: 'PROCESSING', providerOrderId: 'order_1' },
  };

  describe('which bookings are even asked about', () => {
    const { service } = make({});

    it('asks about a booking whose buyer opened the gateway', () => {
      expect(service.needsProviderCheck(gatewayOpened)).toBe(true);
    });

    it('does not ask about a booking with no payment at all', () => {
      expect(service.needsProviderCheck({ id: 'b', payment: null })).toBe(false);
    });

    it('does not ask about a cart abandoned before the payment screen', () => {
      /*
        This is the common case and the reason the guard is affordable: a booking still at
        REQUIRES_PAYMENT never reached a gateway, so there is nothing to ask and no network
        call is made. A provider outage therefore cannot freeze ordinary inventory.
      */
      expect(
        service.needsProviderCheck({
          id: 'b',
          payment: { provider: 'razorpay', status: 'REQUIRES_PAYMENT', providerOrderId: null },
        }),
      ).toBe(false);
    });

    it('does not ask when there is no order id to ask about', () => {
      expect(
        service.needsProviderCheck({
          id: 'b',
          payment: { provider: 'razorpay', status: 'PROCESSING', providerOrderId: null },
        }),
      ).toBe(false);
    });
  });

  it('releases when the provider says nobody paid', async () => {
    const { service, processVerifiedEvent } = make({
      findOrderPayments: jest.fn().mockResolvedValue([]),
    });
    await expect(service.guardExpiry(gatewayOpened)).resolves.toBe('release');
    expect(processVerifiedEvent).not.toHaveBeenCalled();
  });

  it('recovers through the canonical confirm path when the provider holds a capture', async () => {
    const { service, processVerifiedEvent } = make({
      findOrderPayments: jest.fn().mockResolvedValue([
        {
          providerRef: 'pay_TkVxCS4BmDljlf',
          status: 'CAPTURED',
          amountMinor: 51_918,
          currency: 'INR',
        },
      ]),
    });

    await expect(service.guardExpiry(gatewayOpened)).resolves.toBe('recovered');

    /*
      The event is deliberately the SAME shape a verified webhook produces, handed to the
      SAME entry point. That is what makes recovery exactly-once without a second
      fulfillment path: `confirm` claims the booking with a conditional update, so a late
      webhook racing this produces one confirmation, and an unpayable booking lands in
      `recordUnappliedCapture` rather than being silently fulfilled.
    */
    expect(processVerifiedEvent).toHaveBeenCalledTimes(1);
    expect(processVerifiedEvent).toHaveBeenCalledWith({
      type: 'payment.succeeded',
      bookingId: 'bk1',
      providerRef: 'pay_TkVxCS4BmDljlf',
      amountMinor: 51_918,
    });
  });

  describe('every way of not knowing holds the stock back', () => {
    it('holds back when the provider call throws', async () => {
      const { service, processVerifiedEvent } = make({
        findOrderPayments: jest.fn().mockRejectedValue(new Error('ETIMEDOUT')),
      });
      await expect(service.guardExpiry(gatewayOpened)).resolves.toBe('hold_back');
      expect(processVerifiedEvent).not.toHaveBeenCalled();
    });

    it('holds back when the adapter cannot look an order up', async () => {
      // An adapter without the capability can never clear a booking for release. Absence of
      // the ability to check is not evidence that nothing was paid.
      await expect(make({}).service.guardExpiry(gatewayOpened)).resolves.toBe('hold_back');
    });

    it('holds back when the provider cannot be resolved at all', async () => {
      await expect(make(null).service.guardExpiry(gatewayOpened)).resolves.toBe('hold_back');
    });

    it('holds back - and keeps the stock - when recovery itself fails', async () => {
      /*
        The subtle one. We now KNOW money was captured, and the confirm path refused (a
        wrong amount, a cancelled session). Releasing the seat at this point would be the
        incident with full knowledge, so the booking stays put for the next sweep and a
        person.
      */
      const { service } = make(
        {
          findOrderPayments: jest
            .fn()
            .mockResolvedValue([
              { providerRef: 'pay_1', status: 'CAPTURED', amountMinor: 1, currency: 'INR' },
            ]),
        },
        jest.fn().mockRejectedValue(new Error('amount mismatch')),
      );
      await expect(service.guardExpiry(gatewayOpened)).resolves.toBe('hold_back');
    });
  });

  it('never throws out of the guard, so one bad gateway cannot stall the whole sweep', async () => {
    const { service } = make({
      findOrderPayments: jest.fn().mockRejectedValue(new Error('boom')),
    });
    // Resolving rather than rejecting IS the assertion: the sweep processes bookings in a
    // loop, and a throw here would strand every lapsed booking behind this one.
    await expect(service.guardExpiry(gatewayOpened)).resolves.toBe('hold_back');
  });

  it('emits a distinct metric per outcome, so recovery is visible without reading logs', async () => {
    const { service, metrics } = make({
      findOrderPayments: jest
        .fn()
        .mockResolvedValue([
          { providerRef: 'pay_1', status: 'CAPTURED', amountMinor: 10, currency: 'INR' },
        ]),
    });
    await service.guardExpiry(gatewayOpened);
    expect(metrics.recordPaymentWebhook).toHaveBeenCalledWith(
      'razorpay',
      'expiry_capture_recovered',
    );
  });
});
