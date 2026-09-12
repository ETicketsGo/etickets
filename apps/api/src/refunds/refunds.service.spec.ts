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
  /** What the provider says about the refund it was asked for. */
  providerStatus?: 'COMPLETED' | 'PROCESSING' | 'FAILED';
  paymentMethod?: 'ONLINE' | 'CASH';
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
    paymentMethod: opts.paymentMethod ?? 'ONLINE',
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
      : jest
          .fn()
          .mockResolvedValue({ providerRef: 'rf_abc', status: opts.providerStatus ?? 'COMPLETED' }),
  };
  const access = accessStub();
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = {
    send: jest.fn().mockResolvedValue(undefined),
    // Critical notifications are written IN the domain transaction now, so the stub
    // captures the transaction client it was handed -- that IS the assertion.
    sendCritical: jest.fn().mockResolvedValue(undefined),
    fanOutCritical: jest.fn().mockResolvedValue(0),
  };
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

  /*
    Two refunds for the same ticket can both be approved. The provider used to be called
    first and the tickets inspected afterwards, so the second one paid out again and then
    voided nothing.
  */
  it('refuses before any money moves when a named ticket is no longer live', async () => {
    const { service, prisma, payments, tx } = setupProcess({
      approveClaimCount: 1,
      bookingTickets: [
        { id: 'tk1', status: TicketStatus.REFUNDED, ticketTypeId: 't1', seatId: null },
      ],
    });
    await expect(service.process(ADMIN, 'rf-1', 'APPROVE')).rejects.toMatchObject({
      code: ErrorCodes.CONFLICT,
    });
    expect(payments.refundPayment).not.toHaveBeenCalled();
    expect(tx.refund.update).not.toHaveBeenCalled();
    expect(prisma.refund.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: RefundStatus.FAILED } }),
    );
  });

  it('a refund the provider refused is FAILED, not COMPLETED, and cancels no tickets', async () => {
    const { service, prisma, tx, receipts } = setupProcess({
      approveClaimCount: 1,
      providerStatus: 'FAILED',
    });
    await expect(service.process(ADMIN, 'rf-1', 'APPROVE')).rejects.toBeInstanceOf(AppException);
    expect(prisma.refund.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: RefundStatus.FAILED }),
      }),
    );
    expect(tx.ticket.updateMany).not.toHaveBeenCalled();
    expect(receipts.issueCreditNote).not.toHaveBeenCalled();
  });

  it('a refund the provider accepted but has not paid stays PROCESSING', async () => {
    // Razorpay answers `pending`; `refund.processed` finalises it later.
    const { service, tx } = setupProcess({ approveClaimCount: 1, providerStatus: 'PROCESSING' });
    await service.process(ADMIN, 'rf-1', 'APPROVE');
    expect(tx.refund.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: RefundStatus.PROCESSING, providerRef: 'rf_abc' }),
      }),
    );
  });

  it('refuses to refund a cash booking online, before claiming it', async () => {
    const { service, prisma, payments } = setupProcess({
      approveClaimCount: 1,
      paymentMethod: 'CASH',
    });
    await expect(service.process(ADMIN, 'rf-1', 'APPROVE')).rejects.toThrow(/at the venue/);
    expect(prisma.refund.updateMany).not.toHaveBeenCalled();
    expect(payments.refundPayment).not.toHaveBeenCalled();
  });
});

describe('RefundsService.adminGet', () => {
  it('reads the refund by id rather than searching a page of the list', async () => {
    const { service, prisma } = setupProcess();
    await service.adminGet('rf-1');
    expect(prisma.refund.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'rf-1' } }),
    );
  });

  it('is NOT_FOUND for an id that does not exist', async () => {
    const { service, prisma } = setupProcess();
    (prisma.refund.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(service.adminGet('nope')).rejects.toMatchObject({ code: ErrorCodes.NOT_FOUND });
  });
});

// ---------------------------------------------------------------------------
// request()
// ---------------------------------------------------------------------------

interface RequestOpts {
  /** Tax lines snapshotted on the booking. Empty by default — the shipped state. */
  taxLines?: {
    label: string;
    rateBasisPoints: number;
    baseMinor: number;
    amountMinor: number;
    basis?: string | null;
    inclusive?: boolean | null;
  }[];
  bookingTickets: Array<{
    id: string;
    status: string;
    ticketTypeId: string;
    /** Accepted TRANSFER invites, as ACCEPTED_TRANSFERS loads them. */
    invites?: { acceptedByUserId: string | null }[];
  }>;
  /** Call as the buyer (u1) rather than as platform staff. */
  asBuyer?: boolean;
  ticketIds?: string[];
  priorRefunds?: Array<{ ticketIds: string[]; amountMinor: number; status: string }>;
  totalMinor?: number;
  subtotalMinor?: number;
  discountMinor?: number;
  paymentMethod?: 'ONLINE' | 'CASH';
  items?: Array<{ id?: string; ticketTypeId: string; unitPriceMinor: number; quantity?: number }>;
}

function setupRequest(opts: RequestOpts) {
  const booking = {
    id: 'b1',
    userId: 'u1',
    organizationId: 'org-1',
    status: BookingStatus.CONFIRMED,
    paymentMethod: opts.paymentMethod ?? 'ONLINE',
    totalMinor: opts.totalMinor ?? 100000,
    subtotalMinor: opts.subtotalMinor,
    discountMinor: opts.discountMinor ?? 0,
    // Session far in the future → passes the 48h refund-window policy.
    eventSession: { startsAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30) },
    tickets: opts.bookingTickets,
    taxLines: opts.taxLines ?? [],
  };
  const refund = {
    findMany: jest.fn().mockResolvedValue(opts.priorRefunds ?? []),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'rf-new',
      ...data,
    })),
  };
  // The open-refund read and the create run on the transaction client, behind a lock.
  const tx = { $executeRaw: jest.fn().mockResolvedValue(0), refund };
  const prisma = {
    booking: { findUnique: jest.fn().mockResolvedValue(booking) },
    refund,
    bookingItem: {
      findMany: jest
        .fn()
        .mockResolvedValue(opts.items ?? [{ ticketTypeId: 't1', unitPriceMinor: 5000 }]),
    },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const access = accessStub();
  if (opts.asBuyer) access.isPlatformAdmin.mockReturnValue(false);
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new RefundsService(
    prisma as never,
    {} as never,
    {} as never,
    access as never,
    audit as never,
    { send: jest.fn(), sendCritical: jest.fn() } as never,
    new MetricsService(),
    { issueCreditNote: jest.fn() } as never,
  );
  return { service, prisma, tx };
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

  /*
    Reported from QA: "Refund amount exceeds the remaining refundable balance" on a ₹522.82
    booking for one ₹499 ticket. The GST inside the ticket price was added on top of it, and the
    GST on the non-refunded fee went back too: ₹499 + ₹76.12 + ₹3.64 = ₹578.76.
  */
  describe('Indian GST: inside the ticket price, and on the fees', () => {
    const qaBooking = (over: Partial<RequestOpts> = {}) =>
      setupRequest({
        bookingTickets: [{ id: 'tk1', status: TicketStatus.ACTIVE, ticketTypeId: 't1' }],
        totalMinor: 52_282,
        items: [{ ticketTypeId: 't1', unitPriceMinor: 49_900, quantity: 1 }],
        taxLines: [
          {
            label: 'CGST',
            rateBasisPoints: 900,
            baseMinor: 42_288,
            amountMinor: 3_806,
            basis: 'TICKETS',
            inclusive: true,
          },
          {
            label: 'SGST',
            rateBasisPoints: 900,
            baseMinor: 42_288,
            amountMinor: 3_806,
            basis: 'TICKETS',
            inclusive: true,
          },
          {
            label: 'CGST',
            rateBasisPoints: 900,
            baseMinor: 2_018,
            amountMinor: 182,
            basis: 'FEES',
            inclusive: false,
          },
          {
            label: 'SGST',
            rateBasisPoints: 900,
            baseMinor: 2_018,
            amountMinor: 182,
            basis: 'FEES',
            inclusive: false,
          },
        ],
        ...over,
      });

    it('refunds the ticket price, with its GST inside it — not ₹578.76, and not refused', async () => {
      const { service, prisma } = qaBooking();
      await service.request(ADMIN, { bookingId: 'b1' } as never);
      expect(prisma.refund.create).toHaveBeenCalledWith(
        expect.objectContaining({
          // ₹499 back. The ₹76.12 of ticket GST is recorded as the tax inside it; the fee and
          // its ₹3.64 of GST stay, as fees always have.
          data: expect.objectContaining({ amountMinor: 49_900, taxMinor: 7_612 }),
        }),
      );
    });

    it('returns a share of the included GST for a partial refund', async () => {
      const { service, prisma } = qaBooking({
        bookingTickets: [
          { id: 'tk1', status: TicketStatus.ACTIVE, ticketTypeId: 't1' },
          { id: 'tk2', status: TicketStatus.ACTIVE, ticketTypeId: 't1' },
        ],
        items: [{ ticketTypeId: 't1', unitPriceMinor: 49_900, quantity: 2 }],
        totalMinor: 104_564,
        taxLines: [
          {
            label: 'CGST',
            rateBasisPoints: 900,
            baseMinor: 84_576,
            amountMinor: 7_612,
            basis: 'TICKETS',
            inclusive: true,
          },
        ],
      });
      await service.request(ADMIN, { bookingId: 'b1', ticketIds: ['tk1'] } as never);
      expect(prisma.refund.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ amountMinor: 49_900, taxMinor: 3_806 }),
        }),
      );
    });

    it('still ADDS a declared added tax on the tickets — a US-style sales tax', async () => {
      const { service, prisma } = setupRequest({
        bookingTickets: [{ id: 'tk1', status: TicketStatus.ACTIVE, ticketTypeId: 't1' }],
        totalMinor: 100_000,
        items: [{ ticketTypeId: 't1', unitPriceMinor: 5_000 }],
        taxLines: [
          {
            label: 'Sales tax',
            rateBasisPoints: 1_000,
            baseMinor: 6_000,
            amountMinor: 600,
            basis: 'TICKETS',
            inclusive: false,
          },
        ],
      });
      await service.request(ADMIN, { bookingId: 'b1' } as never);
      expect(prisma.refund.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ amountMinor: 5_500, taxMinor: 500 }),
        }),
      );
    });
  });

  /*
    A 50% coupon on two ₹500 tickets took ₹500. Refunding one ticket returned ₹500 — the whole
    payment — and the second ticket was then refused as exceeding the balance.
  */
  describe('a booking bought with a discount', () => {
    const couponBooking = (over: Partial<RequestOpts> = {}) =>
      setupRequest({
        bookingTickets: [
          { id: 'tk1', status: TicketStatus.ACTIVE, ticketTypeId: 't1' },
          { id: 'tk2', status: TicketStatus.ACTIVE, ticketTypeId: 't1' },
        ],
        items: [{ id: 'i1', ticketTypeId: 't1', unitPriceMinor: 50_000, quantity: 2 }],
        subtotalMinor: 100_000,
        discountMinor: 50_000,
        totalMinor: 52_000, // ₹500 for the tickets + ₹20 of fees
        ...over,
      });

    it('refunds a ticket at what was paid for it, not its pre-coupon price', async () => {
      const { service, prisma } = couponBooking();
      await service.request(ADMIN, { bookingId: 'b1', ticketIds: ['tk1'] } as never);
      expect(prisma.refund.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ amountMinor: 25_000 }) }),
      );
    });

    it('still refunds the second ticket after the first', async () => {
      const { service, prisma } = couponBooking({
        priorRefunds: [{ ticketIds: ['tk1'], amountMinor: 25_000, status: RefundStatus.COMPLETED }],
      });
      await service.request(ADMIN, { bookingId: 'b1', ticketIds: ['tk2'] } as never);
      expect(prisma.refund.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ amountMinor: 25_000 }) }),
      );
    });
  });

  it('prices two lines of the same ticket type at their own prices', async () => {
    // Keyed by type, the second line's price overwrote the first: 2 × ₹6 on a ₹10 booking.
    const { service, prisma } = setupRequest({
      bookingTickets: [
        { id: 'tk1', status: TicketStatus.ACTIVE, ticketTypeId: 't1' },
        { id: 'tk2', status: TicketStatus.ACTIVE, ticketTypeId: 't1' },
      ],
      items: [
        { id: 'i1', ticketTypeId: 't1', unitPriceMinor: 400, quantity: 1 },
        { id: 'i2', ticketTypeId: 't1', unitPriceMinor: 600, quantity: 1 },
      ],
      subtotalMinor: 1_000,
      totalMinor: 1_000,
    });
    await service.request(ADMIN, { bookingId: 'b1' } as never);
    expect(prisma.refund.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amountMinor: 1_000 }) }),
    );
  });

  /*
    An accepted transfer moves the ticket to its recipient, but the booking still names the
    buyer — who could give a ticket away and then refund it.
  */
  describe('a ticket the buyer has transferred away', () => {
    const BUYER = { id: 'u1', email: 'u1@example.test', fullName: 'Buyer', roles: [] as never };
    const transferredBooking = () =>
      setupRequest({
        asBuyer: true,
        bookingTickets: [
          {
            id: 'tk1',
            status: TicketStatus.ACTIVE,
            ticketTypeId: 't1',
            invites: [{ acceptedByUserId: 'friend-1' }],
          },
          { id: 'tk2', status: TicketStatus.ACTIVE, ticketTypeId: 't1', invites: [] },
        ],
        items: [{ id: 'i1', ticketTypeId: 't1', unitPriceMinor: 5000, quantity: 2 }],
      });

    it('is refused when the buyer names it — not quietly dropped from the request', async () => {
      // Named alongside a ticket the buyer still holds: dropping tk1 and refunding tk2 alone
      // would answer a different request than the one made.
      const { service, prisma } = transferredBooking();
      await expect(
        service.request(BUYER, { bookingId: 'b1', ticketIds: ['tk1', 'tk2'] } as never),
      ).rejects.toMatchObject({ code: ErrorCodes.REFUND_NOT_ELIGIBLE });
      expect(prisma.refund.create).not.toHaveBeenCalled();
    });

    it('is left out when the buyer refunds the whole booking', async () => {
      const { service, prisma } = transferredBooking();
      await service.request(BUYER, { bookingId: 'b1' } as never);
      expect(prisma.refund.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ ticketIds: ['tk2'], amountMinor: 5000 }),
        }),
      );
    });
  });

  it('refuses an online refund of a cash booking — that money is in the venue till', async () => {
    const { service, prisma } = setupRequest({
      bookingTickets: [{ id: 'tk1', status: TicketStatus.ACTIVE, ticketTypeId: 't1' }],
      paymentMethod: 'CASH',
    });
    await expect(service.request(ADMIN, { bookingId: 'b1' } as never)).rejects.toThrow(
      /at the venue/,
    );
    expect(prisma.refund.create).not.toHaveBeenCalled();
  });

  it('reads the open refunds only after taking the per-booking lock, in one transaction', async () => {
    // Two simultaneous requests for the same tickets both saw nothing covering them.
    const { service, prisma, tx } = setupRequest({
      bookingTickets: [{ id: 'tk1', status: TicketStatus.ACTIVE, ticketTypeId: 't1' }],
    });
    await service.request(ADMIN, { bookingId: 'b1' } as never);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    const lockedAt = tx.$executeRaw.mock.invocationCallOrder[0];
    expect(lockedAt).toBeLessThan(tx.refund.findMany.mock.invocationCallOrder[0]);
    expect(lockedAt).toBeLessThan(tx.refund.create.mock.invocationCallOrder[0]);
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
