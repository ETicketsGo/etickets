import {
  BookingStatus,
  NotificationType,
  RefundStatus,
  TicketStatus,
} from '@eticketsgo/shared-types';
import { RefundsService } from './refunds.service';
import { ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';
import { MetricsService } from '../metrics/metrics.service';

/**
 * A refund asked for through a guest access link is the SAME refund.
 *
 * ── WHY THIS SUITE IS MOSTLY COMPARISONS ───────────────────────────────────────────
 * The risk in adding a second door to the refund request was never that the door would not
 * open. It was that the rules behind it would be a second copy — the organizer's cutoff, the
 * cash refusal, the refundable-balance ceiling, the per-booking lock — and that the copy would
 * drift, silently, in whichever direction the next change to the account path happened to go.
 *
 * So most of these tests run the two entries against the same booking and compare what lands in
 * the database. A test that only asserted "the guest path creates a refund" would pass against a
 * duplicated body, which is the failure it exists to catch.
 */

const BUYER: RequestUser = {
  id: 'u1',
  email: 'bobby.tables@example.com',
  fullName: 'Bobby Tables',
  roles: [] as never,
};

interface Opts {
  /** Null for a guest booking, a user id for an account booking. */
  userId?: string | null;
  status?: BookingStatus;
  totalMinor?: number;
  paymentMethod?: 'ONLINE' | 'CASH';
  /** Hours before the show that refunds close, as the organizer set it. */
  refundCutoffHours?: number;
  refundsEnabled?: boolean;
  tickets?: { id: string; status: string; ticketTypeId: string; invites?: unknown[] }[];
  /** Accepted transfers on tk1, which a guest must not be able to cash in. */
  transferredTo?: string;
}

function setup(opts: Opts = {}) {
  const booking = {
    id: 'bk-1',
    userId: opts.userId === undefined ? null : opts.userId,
    organizationId: 'org-1',
    reference: 'ETG-IND-2026-000123',
    currency: 'INR',
    buyerEmail: 'bobby.tables@example.com',
    status: opts.status ?? BookingStatus.CONFIRMED,
    paymentMethod: opts.paymentMethod ?? 'ONLINE',
    totalMinor: opts.totalMinor ?? 100000,
    discountMinor: 0,
    seatBased: false,
    eventSessionId: 'sess-1',
    // Far enough out to clear the default 48-hour window.
    eventSession: { startsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
    event: {
      refundsEnabled: opts.refundsEnabled ?? true,
      refundCutoffHours: opts.refundCutoffHours ?? 48,
    },
    tickets: opts.tickets ?? [
      {
        id: 'tk1',
        status: TicketStatus.ACTIVE,
        ticketTypeId: 't1',
        seatId: null,
        invites: opts.transferredTo ? [{ acceptedByUserId: opts.transferredTo }] : [],
      },
    ],
    taxLines: [],
  };

  const refund = {
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'rf-new',
      ...data,
    })),
  };
  const tx = { $executeRaw: jest.fn().mockResolvedValue(0), refund };
  const prisma = {
    booking: { findUnique: jest.fn().mockResolvedValue(booking) },
    refund,
    bookingItem: {
      findMany: jest.fn().mockResolvedValue([{ ticketTypeId: 't1', unitPriceMinor: 5000 }]),
    },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const access = {
    // A customer, not staff: the buyer-scoped rules are the ones a guest has to match.
    isPlatformAdmin: jest.fn().mockReturnValue(false),
    assertMember: jest.fn().mockResolvedValue(undefined),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = {
    send: jest.fn().mockResolvedValue(undefined),
    sendCritical: jest.fn().mockResolvedValue(undefined),
  };

  const service = new RefundsService(
    prisma as never,
    {} as never,
    {} as never,
    access as never,
    audit as never,
    notifications as never,
    new MetricsService(),
    { issueCreditNote: jest.fn() } as never,
  );
  return { service, prisma, tx, audit, notifications, access, booking };
}

describe('a guest refund request lands in the same state as an account one', () => {
  it('creates an identical refund row, except for who asked', async () => {
    /*
      The whole point of the refactor, asserted as an equality rather than field by field: a new
      column added to the refund on one path and not the other fails here.
    */
    const asAccount = setup({ userId: 'u1' });
    await asAccount.service.request(BUYER, { bookingId: 'bk-1', reason: 'change of plan' });
    const accountRow = asAccount.tx.refund.create.mock.calls[0][0].data;

    const asGuest = setup();
    await asGuest.service.requestAsGuest({ bookingId: 'bk-1', reason: 'change of plan' });
    const guestRow = asGuest.tx.refund.create.mock.calls[0][0].data;

    expect(guestRow).toEqual({ ...accountRow, requestedByUserId: null });
    expect(guestRow.status).toBe(RefundStatus.REQUESTED);
    expect(guestRow.amountMinor).toBe(5000);
    expect(Number.isInteger(guestRow.amountMinor)).toBe(true);
  });

  it('records no actor user id, because there is no account to name', async () => {
    const { service, tx, audit } = setup();
    await service.requestAsGuest({ bookingId: 'bk-1', reason: 'change of plan' });
    expect(tx.refund.create.mock.calls[0][0].data.requestedByUserId).toBeNull();
    expect(audit.record.mock.calls[0][0].actorUserId).toBeNull();
  });

  it('says in the audit trail that it came from a guest access link', async () => {
    /*
      With no actor user id, a guest refund is otherwise indistinguishable from a
      system-generated one in the audit log — and "somebody holding the emailed link asked for
      this" is the fact a dispute turns on.
    */
    const { service, audit } = setup();
    await service.requestAsGuest({ bookingId: 'bk-1', reason: 'change of plan' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'REFUND_REQUESTED',
        metadata: expect.objectContaining({ via: 'GUEST_ACCESS_LINK' }),
      }),
    );

    const account = setup({ userId: 'u1' });
    await account.service.request(BUYER, { bookingId: 'bk-1', reason: 'change of plan' });
    expect(account.audit.record.mock.calls[0][0].metadata.via).toBe('ACCOUNT');
  });

  it('takes the advisory lock and reads prior refunds exactly as the account path does', async () => {
    // The lock is what stops two requests for the same tickets both being created and both
    // paid. A second entry that forgot it would pass every other test in this file.
    const { service, tx } = setup();
    await service.requestAsGuest({ bookingId: 'bk-1', reason: 'change of plan' });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.refund.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ bookingId: 'bk-1' }) }),
    );
  });
});

describe('the eligibility rules are not re-implemented for guests', () => {
  it("honours the organizer's refund cutoff", async () => {
    const { service, tx } = setup({ refundCutoffHours: 24 * 60 });
    await expect(
      service.requestAsGuest({ bookingId: 'bk-1', reason: 'change of plan' }),
    ).rejects.toMatchObject({ code: ErrorCodes.REFUND_NOT_ELIGIBLE });
    expect(tx.refund.create).not.toHaveBeenCalled();
  });

  it('honours an organizer who does not offer refunds at all', async () => {
    const { service } = setup({ refundsEnabled: false });
    await expect(
      service.requestAsGuest({ bookingId: 'bk-1', reason: 'change of plan' }),
    ).rejects.toMatchObject({ code: ErrorCodes.REFUND_NOT_ELIGIBLE });
  });

  it('refuses a booking paid in cash at the venue', async () => {
    const { service } = setup({ paymentMethod: 'CASH' });
    await expect(
      service.requestAsGuest({ bookingId: 'bk-1', reason: 'change of plan' }),
    ).rejects.toMatchObject({ code: ErrorCodes.REFUND_NOT_ELIGIBLE });
  });

  it('refuses a booking that is not in a refundable state', async () => {
    const { service } = setup({ status: BookingStatus.PENDING_PAYMENT });
    await expect(
      service.requestAsGuest({ bookingId: 'bk-1', reason: 'change of plan' }),
    ).rejects.toMatchObject({ code: ErrorCodes.REFUND_NOT_ELIGIBLE });
  });

  it('refuses when the amount would exceed what was paid', async () => {
    const { service } = setup({ totalMinor: 1000 });
    await expect(
      service.requestAsGuest({ bookingId: 'bk-1', reason: 'change of plan' }),
    ).rejects.toMatchObject({ code: ErrorCodes.REFUND_NOT_ELIGIBLE });
  });

  it('will not cash in a ticket that has been transferred away', async () => {
    /*
      A guest holds every ticket that has NOT moved on, which is the rule stated positively
      rather than `holder === null`. Written as its own test because the account path compares
      against a real user id and a guest has none: had the guest predicate been the same
      comparison, a ticket whose holder cannot be named would have read as "yes, yours".
    */
    const { service, tx } = setup({ transferredTo: 'u2' });
    await expect(
      service.requestAsGuest({ bookingId: 'bk-1', reason: 'change of plan' }),
    ).rejects.toMatchObject({ code: ErrorCodes.REFUND_NOT_ELIGIBLE });
    expect(tx.refund.create).not.toHaveBeenCalled();
  });

  it('refuses outright once the booking belongs to an account', async () => {
    /*
      An access-token row outlives a claim, so "the emailed link stops moving money once the
      booking has an owner" has to be true in the service that moves the money too, not only in
      the one that reads the booking.
    */
    const { service, tx } = setup({ userId: 'u1' });
    await expect(
      service.requestAsGuest({ bookingId: 'bk-1', reason: 'change of plan' }),
    ).rejects.toMatchObject({ code: ErrorCodes.FORBIDDEN, status: 403 });
    expect(tx.refund.create).not.toHaveBeenCalled();
  });
});

describe('the buyer is told a refund was requested', () => {
  it('emails the address that paid, inside the transaction that records the request', async () => {
    /*
      This is the notice that makes a forwardable link survivable: whoever holds the link could
      ask for this refund, so the person whose money it is finds out while it is still a request.
      Enqueued in the same transaction, so "a refund was asked for" and "the buyer knows" cannot
      come apart — the stub captures the transaction client, which IS the assertion.
    */
    const { service, notifications, tx } = setup();
    await service.requestAsGuest({ bookingId: 'bk-1', reason: 'change of plan' });

    expect(notifications.sendCritical).toHaveBeenCalledTimes(1);
    const [client, message] = notifications.sendCritical.mock.calls[0];
    expect(client).toBe(tx);
    expect(message).toMatchObject({
      type: NotificationType.REFUND_REQUESTED,
      // No account behind a guest booking, so the address is the only recipient there is.
      userId: null,
      toEmail: 'bobby.tables@example.com',
      bookingId: 'bk-1',
    });
    expect(message.payload).toMatchObject({
      refundId: 'rf-new',
      reference: 'ETG-IND-2026-000123',
      currency: 'INR',
      amountMinor: 5000,
    });
  });

  it('is not sent when the refund was refused', async () => {
    // Nothing was requested, so nobody is told something was.
    const { service, notifications } = setup({ refundsEnabled: false });
    await service
      .requestAsGuest({ bookingId: 'bk-1', reason: 'change of plan' })
      .catch(() => undefined);
    expect(notifications.sendCritical).not.toHaveBeenCalled();
  });

  it('leaves the account path exactly as it was, sending nothing', async () => {
    /*
      A signed-in buyer asking for their own refund sees it in their wallet and has never been
      emailed about it. Adding that is a product decision; it is not a side effect of closing the
      forwarded-link hole, and this pins it so the change would have to be deliberate.
    */
    const { service, notifications } = setup({ userId: 'u1' });
    await service.request(BUYER, { bookingId: 'bk-1', reason: 'change of plan' });
    expect(notifications.sendCritical).not.toHaveBeenCalled();
    expect(notifications.send).not.toHaveBeenCalled();
  });
});
