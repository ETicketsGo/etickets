import { CheckInResult, TicketStatus } from '@eticketsgo/shared-types';
import { CheckinsService } from './checkins.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';
import { MetricsService } from '../metrics/metrics.service';

const STAFF: RequestUser = {
  id: 'staff-1',
  email: 'checkin@eticketsgo.test',
  fullName: 'Gate Staff',
  roles: ['CHECKIN_STAFF'] as never,
};

const PAYLOAD = { ticketId: 'tk1', nonce: 'nonce-abc', eventSessionId: 'sess-1' };

interface TicketShape {
  id: string;
  nonce: string;
  status: string;
  organizationId: string;
  eventSessionId: string;
  serial: string;
  seatLabel: string | null;
  holderName: string | null;
  holderEmail: string | null;
  ticketType: { name: string };
  booking: { reference: string | null };
}

function ticket(over: Partial<TicketShape> = {}): TicketShape {
  return {
    id: 'tk1',
    nonce: 'nonce-abc',
    status: TicketStatus.ACTIVE,
    organizationId: 'org-1',
    eventSessionId: 'sess-1',
    serial: 'TKT-ABC',
    seatLabel: null,
    holderName: 'Ada',
    holderEmail: 'ada@example.test',
    ticketType: { name: 'General' },
    booking: { reference: 'ETG-IND-2026-000001' },
    ...over,
  };
}

function setup(opts: {
  verify?: () => typeof PAYLOAD;
  ticket?: TicketShape | null;
  updateCount?: number;
  assertMemberThrows?: boolean;
}) {
  const qr = {
    verify: jest.fn(opts.verify ?? (() => PAYLOAD)),
  };
  const prisma = {
    ticket: {
      findUnique: jest.fn().mockResolvedValue(opts.ticket === undefined ? ticket() : opts.ticket),
      updateMany: jest.fn().mockResolvedValue({ count: opts.updateCount ?? 1 }),
    },
    checkIn: { create: jest.fn().mockResolvedValue({}) },
  };
  const access = {
    assertMember: opts.assertMemberThrows
      ? jest
          .fn()
          .mockRejectedValue(new AppException(ErrorCodes.TENANT_FORBIDDEN, 'not a member', 403))
      : jest.fn().mockResolvedValue(undefined),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = { send: jest.fn().mockResolvedValue(undefined) };
  const service = new CheckinsService(
    prisma as never,
    qr as never,
    access as never,
    audit as never,
    notifications as never,
    new MetricsService(),
  );
  return { service, qr, prisma, access, audit, notifications };
}

describe('CheckinsService.scan', () => {
  it('SUCCESS: atomically flips ACTIVE → CHECKED_IN, logs, audits, notifies', async () => {
    const { service, prisma, audit, notifications } = setup({ updateCount: 1 });

    const out = await service.scan(STAFF, 'token', {});

    expect(out.result).toBe(CheckInResult.SUCCESS);
    expect(prisma.ticket.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tk1', status: TicketStatus.ACTIVE },
        data: { status: TicketStatus.CHECKED_IN },
      }),
    );
    expect(prisma.checkIn.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ result: CheckInResult.SUCCESS }) }),
    );
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(notifications.send).toHaveBeenCalledTimes(1);
    expect(out.ticket?.status).toBe(TicketStatus.CHECKED_IN);
  });

  it('DUPLICATE: the atomic transition affects 0 rows (already checked in)', async () => {
    const { service, prisma } = setup({ updateCount: 0 });
    const out = await service.scan(STAFF, 'token', {});
    expect(out.result).toBe(CheckInResult.DUPLICATE);
    expect(prisma.checkIn.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ result: CheckInResult.DUPLICATE }),
      }),
    );
  });

  it('INVALID: QR signature fails to verify', async () => {
    const { service, prisma } = setup({
      verify: () => {
        throw new AppException(ErrorCodes.QR_INVALID, 'bad sig', 400);
      },
    });
    const out = await service.scan(STAFF, 'token', {});
    expect(out.result).toBe(CheckInResult.INVALID);
    // Never touches the DB when the token can't be verified.
    expect(prisma.ticket.findUnique).not.toHaveBeenCalled();
  });

  it('INVALID: the ticket nonce does not match the QR payload', async () => {
    const { service } = setup({ ticket: ticket({ nonce: 'STALE-NONCE' }) });
    const out = await service.scan(STAFF, 'token', {});
    expect(out.result).toBe(CheckInResult.INVALID);
  });

  it('INVALID: ticket not found', async () => {
    const { service } = setup({ ticket: null });
    const out = await service.scan(STAFF, 'token', {});
    expect(out.result).toBe(CheckInResult.INVALID);
  });

  it('WRONG_SESSION: expectedSessionId differs from the ticket session', async () => {
    const { service, prisma } = setup({});
    const out = await service.scan(STAFF, 'token', { expectedSessionId: 'other-session' });
    expect(out.result).toBe(CheckInResult.WRONG_SESSION);
    // Guarded before the check-in write.
    expect(prisma.ticket.updateMany).not.toHaveBeenCalled();
    expect(prisma.checkIn.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ result: CheckInResult.WRONG_SESSION }),
      }),
    );
  });

  it('CANCELLED: a dead-status ticket (REFUNDED/CANCELLED/VOID) is rejected', async () => {
    const { service, prisma } = setup({ ticket: ticket({ status: TicketStatus.REFUNDED }) });
    const out = await service.scan(STAFF, 'token', {});
    expect(out.result).toBe(CheckInResult.CANCELLED);
    expect(prisma.ticket.updateMany).not.toHaveBeenCalled();
  });

  it('FORBIDDEN: staff is not a member of the ticket owner org (throws)', async () => {
    const { service } = setup({ assertMemberThrows: true });
    await expect(service.scan(STAFF, 'token', {})).rejects.toMatchObject({
      code: ErrorCodes.TENANT_FORBIDDEN,
    });
  });
});
