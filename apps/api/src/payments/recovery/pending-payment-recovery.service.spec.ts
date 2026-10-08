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

  describe('racing a genuine late webhook', () => {
    /*
      Scenarios 5 and 6: recovery finds the capture and a real webhook arrives too, in either
      order, possibly concurrently.

      Exactly-once is not re-implemented here and these tests say why. Recovery's entire
      effect is one call to `processVerifiedEvent` - the SAME entry point a verified webhook
      uses - whose idempotency is already proven at
      `payments/payments.service.spec.ts:439` ("a concurrent re-delivery (claim count 0)
      issues no tickets"). `confirm` claims the booking with a conditional update, so the
      loser of the race is told `already_confirmed` and writes nothing. What is left to prove
      is only that THIS code adds no second effect and draws the right conclusion from
      losing.
    */
    const capture = {
      findOrderPayments: jest
        .fn()
        .mockResolvedValue([
          { providerRef: 'pay_1', status: 'CAPTURED', amountMinor: 51_918, currency: 'INR' },
        ]),
    };

    it('treats losing the race as success, and still does not release the stock', async () => {
      // The webhook got there first. Nothing more to do - and crucially NOT 'release': the
      // booking is confirmed, so handing its seats back would void a paid ticket.
      const { service } = make(
        capture,
        jest.fn().mockResolvedValue({ status: 'already_confirmed', bookingId: 'bk1' }),
      );
      await expect(service.guardExpiry(gatewayOpened)).resolves.toBe('recovered');
    });

    it('defers to the canonical path when the booking can no longer be paid', async () => {
      /*
        The booking was already expired by an earlier sweep. The canonical path answers
        `captured_on_unpayable_booking`, which is where `recordUnappliedCapture` writes the
        finance discrepancy for a person to refund. Recovery must accept that and NOT invent
        a fulfilment of its own.
      */
      const { service } = make(
        capture,
        jest.fn().mockResolvedValue({ status: 'captured_on_unpayable_booking', bookingId: 'bk1' }),
      );
      await expect(service.guardExpiry(gatewayOpened)).resolves.toBe('recovered');
    });

    it('does exactly one thing, so it cannot double-confirm or double-issue', async () => {
      const processVerifiedEvent = jest.fn().mockResolvedValue({ status: 'confirmed' });
      const { service } = make(capture, processVerifiedEvent);

      await service.guardExpiry(gatewayOpened);

      // One call, and no other write surface exists on this service: it holds no Prisma
      // client, issues no tickets and creates no finance rows. That is the argument that it
      // cannot duplicate any of them.
      expect(processVerifiedEvent).toHaveBeenCalledTimes(1);
    });
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
