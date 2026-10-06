import { BookingsService } from './bookings.service';

/**
 * THE REGRESSION TEST FOR THE 2026-10-06 PRODUCTION INCIDENT.
 *
 * A real UPI payment of Rs 519.18 was captured. Every webhook delivery was rejected because
 * the webhook secret did not match. Ten minutes later the expiry sweep released the
 * inventory, and the end state was: money taken, booking EXPIRED, no ticket, and nothing
 * anywhere recording that a customer had paid.
 * `docs/incidents/2026-10-06-payment-capture-without-confirmation.md`
 *
 * -- WHY IT DRIVES THE SWEEP ITSELF ---------------------------------------------------
 * The guard is also unit-tested in isolation, but a passing guard that nothing calls is
 * exactly what the platform had: `recordUnappliedCapture` was correct and unreachable. So
 * this test calls the real `releaseExpiredHolds` with the real `expirePendingBooking`
 * underneath and asserts on the two things that actually hurt - the EXPIRED write and the
 * inventory release.
 *
 * -- FALSIFICATION --------------------------------------------------------------------
 * Delete the `if (this.recovery)` guard from `releaseExpiredHolds` and
 * `does not expire or release a booking the provider has taken money for` fails by
 * reproducing the incident precisely: `claim` receives an EXPIRED write and `release` is
 * called, while no discrepancy is recorded anywhere. That is the state this file exists to
 * make impossible.
 */
describe('the expiry sweep and a payment it was never told about', () => {
  const LAPSED = new Date(Date.now() - 60_000);

  /** The production booking, reduced to the fields the sweep touches. */
  function candidate(payment: unknown) {
    return {
      id: 'cmuw9j097000ua6sotkgz7v0q',
      eventSessionId: 'sess1',
      holdExpiresAt: LAPSED,
      seatBased: false,
      items: [{ ticketTypeId: 'tt1', addOnId: null, quantity: 1 }],
      payment,
    };
  }

  function makeService(
    booking: ReturnType<typeof candidate>,
    guardExpiry: jest.Mock,
    needsProviderCheck = jest.fn().mockReturnValue(true),
  ) {
    const claim = jest.fn().mockResolvedValue({ count: 1 });
    const release = jest.fn().mockResolvedValue(undefined);
    const tx = {
      booking: { updateMany: claim },
      payment: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const prisma = {
      booking: { findMany: jest.fn().mockResolvedValue([booking]) },
      $transaction: jest.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    };
    const inventory = { forSeating: jest.fn(() => ({ release })) };
    const addOnInventory = { release: jest.fn() };
    const recovery = { guardExpiry, needsProviderCheck };

    const service = new BookingsService(
      prisma as never,
      {} as never, // pricing
      {} as never, // pricingStrategies
      { record: jest.fn() } as never, // audit
      inventory as never,
      addOnInventory as never,
      { recordPaymentWebhook: jest.fn() } as never, // metrics
      {} as never, // lockShadow
      {} as never, // bookingShadow
      undefined as never, // config
      undefined as never, // payments
      undefined as never, // policyService
      recovery as never,
    );
    return { service, claim, release, recovery };
  }

  it('does not expire or release a booking the provider has taken money for', async () => {
    // The guard reports it recovered the booking through the canonical confirm path.
    const guardExpiry = jest.fn().mockResolvedValue('recovered');
    const { service, claim, release } = makeService(
      candidate({
        provider: 'razorpay',
        status: 'PROCESSING',
        providerOrderId: 'order_TkVvx7pyLnoLTR',
      }),
      guardExpiry,
    );

    const expired = await service.releaseExpiredHolds(undefined, { consultProvider: true });

    expect(guardExpiry).toHaveBeenCalledTimes(1);
    /*
      The three assertions that are the incident. Nothing wrote EXPIRED, nothing handed the
      stock back, and the sweep counted no expiry. Remove the guard and all three invert.
    */
    expect(claim).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(expired).toBe(0);
  });

  it('does not release when the provider could not be asked', async () => {
    // Scenario 4: we do not know. The seat stays held rather than being given away on an
    // assumption. The next sweep asks again.
    const { service, claim, release } = makeService(
      candidate({ provider: 'razorpay', status: 'PROCESSING', providerOrderId: 'order_1' }),
      jest.fn().mockResolvedValue('hold_back'),
    );

    await expect(service.releaseExpiredHolds(undefined, { consultProvider: true })).resolves.toBe(
      0,
    );
    expect(claim).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('still expires an ordinary abandoned cart, which is what the sweep is for', async () => {
    /*
      Scenario 1, and the test that stops the fix becoming a different bug. A guard that
      never releases anything would leak every seat on the platform, so the ordinary case
      has to keep working: the provider says nobody paid, and the stock goes back exactly as
      before.
    */
    const { service, claim, release } = makeService(
      candidate({ provider: 'razorpay', status: 'PROCESSING', providerOrderId: 'order_1' }),
      jest.fn().mockResolvedValue('release'),
    );

    const expired = await service.releaseExpiredHolds(undefined, { consultProvider: true });

    expect(expired).toBe(1);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('defers a gateway booking rather than releasing it blind when it cannot ask', async () => {
    /*
      `create()` runs this sweep inline on the booking hot path and must not make a network
      call. It therefore does NOT get to release a booking that reached the gateway: it
      recognises the dangerous set and leaves it for the worker, which does consult the
      provider. Releasing blind here would reopen the incident from the other caller.
    */
    const guardExpiry = jest.fn();
    const { service, claim, release } = makeService(
      candidate({ provider: 'razorpay', status: 'PROCESSING', providerOrderId: 'order_1' }),
      guardExpiry,
      jest.fn().mockReturnValue(true),
    );

    const expired = await service.releaseExpiredHolds('sess1');

    expect(guardExpiry).not.toHaveBeenCalled(); // no provider call on the hot path
    expect(claim).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(expired).toBe(0);
  });

  it('lets the hot path release a cart that never reached the gateway', async () => {
    // The common case must stay fast AND keep working inline: no order exists, so there is
    // nothing to ask anybody about.
    const { service, claim, release } = makeService(
      candidate({ provider: 'razorpay', status: 'REQUIRES_PAYMENT', providerOrderId: null }),
      jest.fn(),
      jest.fn().mockReturnValue(false),
    );

    const expired = await service.releaseExpiredHolds('sess1');

    expect(expired).toBe(1);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
