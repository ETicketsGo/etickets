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
    // Platform staff need REFUND_APPROVE to decide a refund. The ADMIN fixture is a plain
    // admin, not a super admin, so the grant is genuinely looked up — held here so this
    // suite keeps testing the MONEY path. Refusal without it is covered separately below.
    adminGrant: {
      findFirst: jest.fn().mockResolvedValue({ id: 'grant-1' }),
    },
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
  const inventory = { forSeating: jest.fn().mockReturnValue(strategy) };
  const payments = {
    refundPayment: opts.providerThrows
      ? jest.fn().mockRejectedValue(new Error('provider down'))
      : jest.fn().mockResolvedValue({ providerRef: 'rf_abc' }),
  };
  const access = accessStub();
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = { send: jest.fn().mockResolvedValue(undefined) };
  const receipts = {
    issueCreditNote: jest.fn().mockResolvedValue(undefined),
    issueForBooking: jest.fn().mockResolvedValue(undefined),
  };

  const service = new RefundsService(
    prisma as never,
    payments as never,
    inventory as never,
    access as never,
    audit as never,
    notifications as never,
    new MetricsService(),
    receipts as never,
  );
  return { service, prisma, tx, strategy, payments, access, audit, notifications, receipts };
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
  /** Tax lines snapshotted on the booking. Empty by default — the shipped state. */
  taxLines?: { label: string; rateBasisPoints: number; baseMinor: number; amountMinor: number }[];
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
    taxLines: opts.taxLines ?? [],
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
    { issueCreditNote: jest.fn() } as never,
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

  /*
    Tax charged on a returned ticket goes back with it.

    Platform FEES are not refunded — that is long-standing policy and these tests pin it so a
    future change has to be deliberate. Tax is different in kind: it was collected because a
    taxable supply happened, and undoing the supply undoes the reason to hold it. Keeping it
    would leave the customer paying tax on a ticket they no longer own.
  */
  it('returns no tax when none was charged, which is the shipped default', async () => {
    const { service, prisma } = setupRequest({
      bookingTickets: [{ id: 'tk1', status: TicketStatus.ACTIVE, ticketTypeId: 't1' }],
      totalMinor: 100000,
      items: [{ ticketTypeId: 't1', unitPriceMinor: 5000 }],
    });
    await service.request(ADMIN, { bookingId: 'b1' } as never);
    expect(prisma.refund.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ amountMinor: 5000, taxMinor: 0 }),
      }),
    );
  });

  it('returns the tax charged on the ticket alongside it', async () => {
    const { service, prisma } = setupRequest({
      bookingTickets: [{ id: 'tk1', status: TicketStatus.ACTIVE, ticketTypeId: 't1' }],
      totalMinor: 100000,
      items: [{ ticketTypeId: 't1', unitPriceMinor: 5000 }],
      // 10% is a fixture rate, not a claim about any jurisdiction.
      taxLines: [
        { label: 'Fixture tax', rateBasisPoints: 1000, baseMinor: 6000, amountMinor: 600 },
      ],
    });
    await service.request(ADMIN, { bookingId: 'b1' } as never);
    // The rate re-applied to the 5000 actually being returned — 500, not the full 600 that
    // was charged on a base that also included the non-refunded fee.
    expect(prisma.refund.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ amountMinor: 5500, taxMinor: 500 }),
      }),
    );
  });

  it('never returns more tax than was charged on the line', async () => {
    // A refund larger than the taxed base (possible when the base was fee-only) must be
    // capped at the base, or the platform hands back tax it never collected.
    const { service, prisma } = setupRequest({
      bookingTickets: [{ id: 'tk1', status: TicketStatus.ACTIVE, ticketTypeId: 't1' }],
      totalMinor: 100000,
      items: [{ ticketTypeId: 't1', unitPriceMinor: 5000 }],
      taxLines: [
        { label: 'Fee-only tax', rateBasisPoints: 1000, baseMinor: 1000, amountMinor: 100 },
      ],
    });
    await service.request(ADMIN, { bookingId: 'b1' } as never);
    expect(prisma.refund.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ taxMinor: 100 }) }),
    );
  });

  it('sums several taxes independently, as a two-tax jurisdiction charges them', async () => {
    const { service, prisma } = setupRequest({
      bookingTickets: [{ id: 'tk1', status: TicketStatus.ACTIVE, ticketTypeId: 't1' }],
      totalMinor: 100000,
      items: [{ ticketTypeId: 't1', unitPriceMinor: 5000 }],
      taxLines: [
        { label: 'Federal', rateBasisPoints: 500, baseMinor: 5000, amountMinor: 250 },
        { label: 'Provincial', rateBasisPoints: 700, baseMinor: 5000, amountMinor: 350 },
      ],
    });
    await service.request(ADMIN, { bookingId: 'b1' } as never);
    expect(prisma.refund.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ amountMinor: 5600, taxMinor: 600 }),
      }),
    );
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

/*
  The split that motivated the permission model: a refund desk may investigate a request and
  may not pay it out. Under one ADMIN role this was inexpressible — anybody who could open
  the console could approve money.
*/
describe('RefundsService.process — platform staff need REFUND_APPROVE', () => {
  it('refuses an admin who holds no grant', async () => {
    const { service, prisma } = setupProcess({ approveClaimCount: 1 });
    (prisma.adminGrant.findFirst as jest.Mock).mockResolvedValue(null);
    await expect(service.process(ADMIN, 'rf-1', 'APPROVE')).rejects.toThrow(/REFUND_APPROVE/);
  });

  it('refuses them for a rejection too, since both are deciding the request', async () => {
    const { service, prisma } = setupProcess({ approveClaimCount: 1 });
    (prisma.adminGrant.findFirst as jest.Mock).mockResolvedValue(null);
    await expect(service.process(ADMIN, 'rf-1', 'REJECT')).rejects.toThrow(/REFUND_APPROVE/);
  });

  it('lets a super admin through without any grant row', async () => {
    // By role, not by rows — the recovery path must not be lockable away.
    const { service, prisma } = setupProcess({ approveClaimCount: 1 });
    (prisma.adminGrant.findFirst as jest.Mock).mockResolvedValue(null);
    const superAdmin = { ...ADMIN, roles: ['ADMIN', 'SUPER_ADMIN'] as never };
    await expect(service.process(superAdmin, 'rf-1', 'APPROVE')).resolves.toBeDefined();
  });
});
