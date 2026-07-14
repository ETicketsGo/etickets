import {
  BookingStatus,
  ExperienceType,
  PaymentStatus,
  RefundStatus,
  TicketStatus,
} from '@eticketsgo/shared-types';
import { RefundsService } from './refunds.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';
import { MetricsService } from '../metrics/metrics.service';

const ADMIN: RequestUser = {
  id: 'admin-1',
  email: 'admin@eticketsgo.test',
  fullName: 'Admin',
  roles: ['ADMIN'] as never,
};

/** Platform-admin access stub so authz is bypassed and we test the money path. */
const accessStub = () => ({
  isPlatformAdmin: jest.fn().mockReturnValue(true),
  assertMember: jest.fn().mockResolvedValue(undefined),
});

// ---------------------------------------------------------------------------
// process()
// ---------------------------------------------------------------------------

interface ProcessOpts {
  refundStatus?: string;
  ticketIds?: string[];
  approveClaimCount?: number;
  rejectClaimCount?: number;
  bookingTickets?: Array<{
    id: string;
    status: string;
    ticketTypeId: string;
    seatId: string | null;
  }>;
  providerThrows?: boolean;
}

function setupProcess(opts: ProcessOpts = {}) {
  const refund = {
    id: 'rf-1',
    bookingId: 'b1',
    organizationId: 'org-1',
    amountMinor: 5000,
    reason: 'customer request',
    status: opts.refundStatus ?? RefundStatus.REQUESTED,
    ticketIds: opts.ticketIds ?? ['tk1'],
  };
  const booking = {
    id: 'b1',
    userId: 'u1',
    buyerEmail: 'ada@example.test',
    eventSessionId: 'sess-1',
    totalMinor: 5000,
    tickets: opts.bookingTickets ?? [
      { id: 'tk1', status: TicketStatus.ACTIVE, ticketTypeId: 't1', seatId: 's1' },
    ],
    items: [{ ticketTypeId: 't1', unitPriceMinor: 5000 }],
    event: { experienceType: ExperienceType.EVENT },
  };

  const tx = {
    ticket: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    booking: { update: jest.fn().mockResolvedValue({}) },
    payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    refund: { update: jest.fn().mockResolvedValue({}) },
  };

  const prisma = {
    refund: {
      findUnique: jest.fn().mockResolvedValue(refund),
      updateMany: jest
        .fn()
        // First updateMany is the atomic claim (APPROVE→PROCESSING or REJECT→REJECTED).
        .mockResolvedValue({
          count:
            (opts.refundStatus ?? RefundStatus.REQUESTED) === RefundStatus.REQUESTED
              ? (opts.approveClaimCount ?? opts.rejectClaimCount ?? 1)
              : 0,
        }),
      update: jest.fn().mockResolvedValue({}),
    },
    booking: { findUnique: jest.fn().mockResolvedValue(booking) },
    payment: { findUnique: jest.fn().mockResolvedValue({ providerRef: 'pi_123' }) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };

  const strategy = { refund: jest.fn().mockResolvedValue(undefined) };
  const inventory = { forExperienceType: jest.fn().mockReturnValue(strategy) };
  const payments = {
    refundPayment: opts.providerThrows
      ? jest.fn().mockRejectedValue(new Error('provider down'))
      : jest.fn().mockResolvedValue({ providerRef: 'rf_abc' }),
  };
  const access = accessStub();
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = { send: jest.fn().mockResolvedValue(undefined) };

  const service = new RefundsService(
    prisma as never,
    payments as never,
    inventory as never,
    access as never,
    audit as never,
    notifications as never,
    new MetricsService(),
  );
  return { service, prisma, tx, strategy, payments, access, audit, notifications };
}

describe('RefundsService.process', () => {
  it('APPROVE happy path: claims, refunds provider once, voids tickets, settles statuses', async () => {
    const { service, prisma, tx, strategy, payments } = setupProcess({ approveClaimCount: 1 });

    await service.process(ADMIN, 'rf-1', 'APPROVE');

    // Atomic claim REQUESTED → PROCESSING.
    expect(prisma.refund.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rf-1', status: RefundStatus.REQUESTED },
        data: expect.objectContaining({ status: RefundStatus.PROCESSING }),
      }),
    );
    // Provider called exactly once.
    expect(payments.refundPayment).toHaveBeenCalledTimes(1);
    // Strategy refund got the voided ticket's type + seat.
    expect(strategy.refund).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        eventSessionId: 'sess-1',
        tickets: [{ ticketTypeId: 't1', seatId: 's1' }],
      }),
    );
    // Tickets voided → REFUNDED.
    expect(tx.ticket.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: TicketStatus.REFUNDED } }),
    );
    // No active tickets remain → booking + payment fully REFUNDED.
    expect(tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: BookingStatus.REFUNDED } }),
    );
    expect(tx.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: PaymentStatus.REFUNDED } }),
    );
    // Refund row completed.
    expect(tx.refund.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: RefundStatus.COMPLETED }),
      }),
    );
  });

  it('APPROVE with remaining active tickets settles as PARTIALLY_REFUNDED', async () => {
    const { service, tx } = setupProcess({
      approveClaimCount: 1,
      ticketIds: ['tk1'],
      bookingTickets: [
        { id: 'tk1', status: TicketStatus.ACTIVE, ticketTypeId: 't1', seatId: null },
        { id: 'tk2', status: TicketStatus.ACTIVE, ticketTypeId: 't1', seatId: null },
      ],
    });

    await service.process(ADMIN, 'rf-1', 'APPROVE');

    expect(tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: BookingStatus.PARTIALLY_REFUNDED } }),
    );
    expect(tx.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: PaymentStatus.PARTIALLY_REFUNDED } }),
    );
  });

  it('APPROVE lost the concurrent claim (count 0): CONFLICT and never calls the provider', async () => {
    const { service, payments } = setupProcess({ approveClaimCount: 0 });
    await expect(service.process(ADMIN, 'rf-1', 'APPROVE')).rejects.toMatchObject({
      code: ErrorCodes.CONFLICT,
    });
    expect(payments.refundPayment).not.toHaveBeenCalled();
  });

  it('REJECT claims REQUESTED → REJECTED', async () => {
    const { service, prisma, payments } = setupProcess({ rejectClaimCount: 1 });
    await service.process(ADMIN, 'rf-1', 'REJECT');
    expect(prisma.refund.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rf-1', status: RefundStatus.REQUESTED },
        data: expect.objectContaining({ status: RefundStatus.REJECTED }),
      }),
    );
    expect(payments.refundPayment).not.toHaveBeenCalled();
  });

  it('REJECT with a lost claim (count 0) throws CONFLICT', async () => {
    const { service } = setupProcess({ rejectClaimCount: 0 });
    await expect(service.process(ADMIN, 'rf-1', 'REJECT')).rejects.toMatchObject({
      code: ErrorCodes.CONFLICT,
    });
  });

  it('throws CONFLICT for a refund that is not REQUESTED', async () => {
    const { service } = setupProcess({ refundStatus: RefundStatus.COMPLETED });
    await expect(service.process(ADMIN, 'rf-1', 'APPROVE')).rejects.toBeInstanceOf(AppException);
  });

  it('provider failure marks the refund FAILED and rethrows', async () => {
    const { service, prisma } = setupProcess({ approveClaimCount: 1, providerThrows: true });
    await expect(service.process(ADMIN, 'rf-1', 'APPROVE')).rejects.toThrow('provider down');
    expect(prisma.refund.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rf-1' },
        data: { status: RefundStatus.FAILED },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// request()
// ---------------------------------------------------------------------------

interface RequestOpts {
  bookingTickets: Array<{ id: string; status: string; ticketTypeId: string }>;
  ticketIds?: string[];
  priorRefunds?: Array<{ ticketIds: string[]; amountMinor: number; status: string }>;
  totalMinor?: number;
  items?: Array<{ ticketTypeId: string; unitPriceMinor: number }>;
}

function setupRequest(opts: RequestOpts) {
  const booking = {
    id: 'b1',
    userId: 'u1',
    organizationId: 'org-1',
    status: BookingStatus.CONFIRMED,
    totalMinor: opts.totalMinor ?? 100000,
    // Session far in the future → passes the 48h refund-window policy.
    eventSession: { startsAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30) },
    tickets: opts.bookingTickets,
  };
  const prisma = {
    booking: { findUnique: jest.fn().mockResolvedValue(booking) },
    refund: {
      findMany: jest.fn().mockResolvedValue(opts.priorRefunds ?? []),
      create: jest.fn().mockResolvedValue({ id: 'rf-new' }),
    },
    bookingItem: {
      findMany: jest
        .fn()
        .mockResolvedValue(opts.items ?? [{ ticketTypeId: 't1', unitPriceMinor: 5000 }]),
    },
  };
  const access = accessStub();
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new RefundsService(
    prisma as never,
    {} as never,
    {} as never,
    access as never,
    audit as never,
    { send: jest.fn() } as never,
    new MetricsService(),
  );
  return { service, prisma };
}

describe('RefundsService.request hardening', () => {
  it('rejects when the supplied ticketIds are already REFUNDED', async () => {
    const { service } = setupRequest({
      bookingTickets: [{ id: 'tk1', status: TicketStatus.REFUNDED, ticketTypeId: 't1' }],
      ticketIds: ['tk1'],
    });
    await expect(
      service.request(ADMIN, { bookingId: 'b1', ticketIds: ['tk1'] } as never),
    ).rejects.toMatchObject({ code: ErrorCodes.REFUND_NOT_ELIGIBLE });
  });

  it('rejects tickets already covered by an open refund', async () => {
    const { service } = setupRequest({
      bookingTickets: [{ id: 'tk1', status: TicketStatus.ACTIVE, ticketTypeId: 't1' }],
      priorRefunds: [{ ticketIds: ['tk1'], amountMinor: 5000, status: RefundStatus.REQUESTED }],
    });
    await expect(service.request(ADMIN, { bookingId: 'b1' } as never)).rejects.toMatchObject({
      code: ErrorCodes.REFUND_NOT_ELIGIBLE,
    });
  });

  it('rejects when the refund amount would exceed the remaining balance', async () => {
    const { service } = setupRequest({
      bookingTickets: [{ id: 'tk1', status: TicketStatus.ACTIVE, ticketTypeId: 't1' }],
      totalMinor: 1000, // booking only paid 1000
      items: [{ ticketTypeId: 't1', unitPriceMinor: 5000 }], // ticket priced 5000
    });
    await expect(service.request(ADMIN, { bookingId: 'b1' } as never)).rejects.toMatchObject({
      code: ErrorCodes.REFUND_NOT_ELIGIBLE,
    });
  });

  it('creates a refund for genuinely refundable tickets', async () => {
    const { service, prisma } = setupRequest({
      bookingTickets: [{ id: 'tk1', status: TicketStatus.ACTIVE, ticketTypeId: 't1' }],
      totalMinor: 100000,
      items: [{ ticketTypeId: 't1', unitPriceMinor: 5000 }],
    });
    await service.request(ADMIN, { bookingId: 'b1' } as never);
    expect(prisma.refund.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ amountMinor: 5000, ticketIds: ['tk1'] }),
      }),
    );
  });
});
