import { BookingStatus, PaymentStatus } from '@eticketsgo/shared-types';
import { BookingsService } from './bookings.service';

/**
 * A buyer cancelling their own unpaid booking, on the default (non-orchestrated) path.
 *
 * `POST /bookings/:id/cancel` answered "not available" unless booking orchestration was active,
 * which it is not by default — so a buyer who changed their mind at the payment screen could
 * only close the tab, and the seats stayed held against nobody until the timer ran out.
 *
 * The release itself is the claim-first helper the expiry sweep uses (see its own spec). These
 * are about who may cancel, what may be cancelled, and that a lost claim releases nothing.
 */
const OWNER = { id: 'u-1', email: 'b@t.test', fullName: 'B', roles: [] } as never;
const STRANGER = { id: 'u-2', email: 's@t.test', fullName: 'S', roles: [] } as never;
const ADMIN = { id: 'admin-1', email: 'a@t.test', fullName: 'A', roles: ['ADMIN'] } as never;

function setup(
  over: {
    status?: string;
    userId?: string | null;
    claimCount?: number;
    paymentStatus?: string;
  } = {},
) {
  const booking = {
    id: 'bk-1',
    organizationId: 'org-1',
    userId: over.userId === undefined ? 'u-1' : over.userId,
    status: over.status ?? BookingStatus.PENDING_PAYMENT,
    eventSessionId: 'sess-1',
    holdExpiresAt: new Date(Date.now() + 5 * 60_000),
    seatBased: true,
    items: [{ ticketTypeId: 'tt-1', addOnId: null, quantity: 2 }],
    payment: { status: over.paymentStatus ?? PaymentStatus.REQUIRES_PAYMENT },
  };
  const tx = {
    booking: { updateMany: jest.fn().mockResolvedValue({ count: over.claimCount ?? 1 }) },
    payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const strategy = { release: jest.fn().mockResolvedValue(undefined) };
  const inventory = { forSeating: jest.fn().mockReturnValue(strategy) };
  const addOnInventory = { release: jest.fn().mockResolvedValue(undefined) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const prisma = {
    booking: {
      findUnique: jest
        .fn()
        .mockResolvedValueOnce(booking)
        // What a re-read finds after a lost claim: somebody else got there first.
        .mockResolvedValue({ status: BookingStatus.CONFIRMED }),
    },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const stub = {} as never;
  const service = new BookingsService(
    prisma as never,
    stub, // pricing
    stub, // pricingStrategies
    audit as never,
    inventory as never,
    addOnInventory as never,
    stub, // metrics
    stub, // lockShadow
    stub, // bookingShadow
  );
  return { service, prisma, tx, strategy, inventory, audit };
}

describe('BookingsService.cancelUnpaid', () => {
  it('cancels the owner’s unpaid booking and releases its hold', async () => {
    const { service, tx, strategy, inventory, audit } = setup();
    await expect(service.cancelUnpaid(OWNER, 'bk-1')).resolves.toEqual({
      id: 'bk-1',
      status: BookingStatus.CANCELLED,
      refundPending: false,
    });

    expect(tx.booking.updateMany).toHaveBeenCalledWith({
      where: { id: 'bk-1', status: BookingStatus.PENDING_PAYMENT },
      data: expect.objectContaining({ status: BookingStatus.CANCELLED }),
    });
    expect(inventory.forSeating).toHaveBeenCalledWith(true);
    expect(strategy.release).toHaveBeenCalledTimes(1);
    expect(tx.booking.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      strategy.release.mock.invocationCallOrder[0],
    );
    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: { bookingId: 'bk-1', status: PaymentStatus.REQUIRES_PAYMENT },
      data: { status: PaymentStatus.FAILED },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'BOOKING_CANCELLED',
        entityId: 'bk-1',
        actorUserId: 'u-1',
      }),
    );
  });

  it('lets platform staff cancel somebody else’s unpaid booking', async () => {
    const { service, strategy } = setup();
    await service.cancelUnpaid(ADMIN, 'bk-1');
    expect(strategy.release).toHaveBeenCalledTimes(1);
  });

  it('refuses a stranger before anything is touched', async () => {
    const { service, prisma } = setup();
    await expect(service.cancelUnpaid(STRANGER, 'bk-1')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a signed-in user on a guest booking, which is nobody’s to cancel here', async () => {
    const { service, prisma } = setup({ userId: null });
    await expect(service.cancelUnpaid(OWNER, 'bk-1')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a confirmed booking and points at refunds instead', async () => {
    const { service, prisma } = setup({ status: BookingStatus.CONFIRMED });
    await expect(service.cancelUnpaid(OWNER, 'bk-1')).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringMatching(/refund/i),
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a booking that has already expired', async () => {
    const { service, prisma } = setup({ status: BookingStatus.EXPIRED });
    await expect(service.cancelUnpaid(OWNER, 'bk-1')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('releases nothing when a confirmation or sweep claimed the booking first', async () => {
    const { service, strategy, tx, audit } = setup({ claimCount: 0 });
    await expect(service.cancelUnpaid(OWNER, 'bk-1')).rejects.toMatchObject({
      code: 'CONFLICT',
      // Answered with what the booking actually became, re-read after the lost claim.
      message: expect.stringMatching(/refund/i),
    });
    expect(strategy.release).not.toHaveBeenCalled();
    expect(tx.payment.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('still cancels while a payment is PROCESSING, leaving that payment for its webhook', async () => {
    // A late capture lands on a booking that can no longer be paid and is filed as a finance
    // discrepancy by the confirm path, rather than issuing tickets for released seats.
    const { service, tx, strategy } = setup({ paymentStatus: PaymentStatus.PROCESSING });
    await service.cancelUnpaid(OWNER, 'bk-1');
    expect(strategy.release).toHaveBeenCalledTimes(1);
    expect(tx.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bookingId: 'bk-1', status: PaymentStatus.REQUIRES_PAYMENT },
      }),
    );
  });
});

/**
 * A guest cancelling their own unpaid booking.
 *
 * Reported from QA: "I click on cancel booking and select yes cancel nothing is happening, still on
 * review and pay". The route answered 409 for every guest, on the reasoning that nothing tied a
 * guest booking to the browser that made it. `guestSessionHash` is that tie, and it is written in
 * every orchestration mode - so the reason had expired, and the buyer was left watching a countdown
 * while the seats stayed held against nobody.
 *
 * Who may cancel is the router's question, because the credential arrives in a header: it demands
 * `BOUND` from the same verifier the guest payment route uses, and its own spec covers that. These
 * are about the service half - that a guest's release is the account holder's release, and that the
 * guest door does not open onto an account holder's booking.
 */
describe('BookingsService.cancelUnpaidAsGuest', () => {
  it('releases the hold exactly as an account holder’s cancel does', async () => {
    const { service, tx, strategy, inventory } = setup({ userId: null });
    await expect(service.cancelUnpaidAsGuest('bk-1')).resolves.toEqual({
      id: 'bk-1',
      status: BookingStatus.CANCELLED,
      refundPending: false,
    });

    // Claim first, release second - the same order, because it is the same code path.
    expect(tx.booking.updateMany).toHaveBeenCalledWith({
      where: { id: 'bk-1', status: BookingStatus.PENDING_PAYMENT },
      data: expect.objectContaining({ status: BookingStatus.CANCELLED }),
    });
    expect(inventory.forSeating).toHaveBeenCalledWith(true);
    expect(strategy.release).toHaveBeenCalledTimes(1);
    expect(tx.booking.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      strategy.release.mock.invocationCallOrder[0],
    );
    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: { bookingId: 'bk-1', status: PaymentStatus.REQUIRES_PAYMENT },
      data: { status: PaymentStatus.FAILED },
    });
  });

  it('records the cancel with no actor, because a guest is not a user', async () => {
    const { service, audit } = setup({ userId: null });
    await service.cancelUnpaidAsGuest('bk-1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'BOOKING_CANCELLED',
        entityId: 'bk-1',
        actorUserId: null,
        metadata: expect.objectContaining({ cancelledBy: 'GUEST' }),
      }),
    );
  });

  it('refuses an account holder’s booking, whatever token was presented', async () => {
    // The token is checked before this is reached; the point here is that a booking with an owner
    // is not a guest booking, so this door is shut on it regardless.
    const { service, prisma } = setup({ userId: 'u-1' });
    await expect(service.cancelUnpaidAsGuest('bk-1')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a booking that is already paid for and points at refunds', async () => {
    const { service, prisma } = setup({ userId: null, status: BookingStatus.CONFIRMED });
    await expect(service.cancelUnpaidAsGuest('bk-1')).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringMatching(/refund/i),
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('releases nothing when a sweep or confirmation claimed the booking first', async () => {
    const { service, strategy, audit } = setup({ userId: null, claimCount: 0 });
    await expect(service.cancelUnpaidAsGuest('bk-1')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(strategy.release).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
