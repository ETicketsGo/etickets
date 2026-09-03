import { CheckInResult, TicketStatus } from '@eticketsgo/shared-types';
import { CheckinsService } from './checkins.service';
import type { RequestUser } from '../common/decorators';
import { MetricsService } from '../metrics/metrics.service';

/**
 * A ticket we sold and do not admit.
 *
 * ── THE GAP THIS CLOSES ────────────────────────────────────────────────────────────
 * Selling a seat sourced from another cinema's system means the customer presents THAT
 * system's barcode at the door — their scanner has never heard of ours. A ticket had no
 * field for one, which is the concrete difference between an inventory integration that
 * exists in outline and one that can actually put somebody in a seat.
 *
 * ── WHY THE GATE HAS TO REFUSE, NOT SUCCEED ────────────────────────────────────────
 * Our scanner cannot open their door. Marking the ticket CHECKED_IN here would tell the
 * customer they were admitted while the gate still turns them away, and would leave our
 * records asserting an admission that never happened — which is worse than useless during a
 * dispute, because it is confidently wrong.
 *
 * Reported as EXTERNAL rather than INVALID. The ticket is genuine and paid for; the
 * check-in log is a record people read, and calling it invalid would be false in it.
 */
const STAFF: RequestUser = {
  id: 'staff-1',
  email: 'gate@eticketsgo.test',
  fullName: 'Gate Staff',
  roles: ['CHECKIN_STAFF'] as never,
};

const PAYLOAD = { ticketId: 'tk1', nonce: 'nonce-abc', eventSessionId: 'sess-1' };

const ticket = (over: Record<string, unknown> = {}) => ({
  id: 'tk1',
  nonce: 'nonce-abc',
  status: TicketStatus.ACTIVE,
  organizationId: 'org-1',
  eventSessionId: 'sess-1',
  serial: 'TKT-ABC',
  seatLabel: 'H-12',
  holderName: 'Ada',
  holderEmail: 'ada@example.test',
  ticketType: { name: 'General' },
  booking: { reference: 'ETG-IND-2026-000001' },
  vendorBarcode: null,
  vendorBarcodeFormat: null,
  vendorName: null,
  ...over,
});

function setup(t: Record<string, unknown>) {
  const prisma = {
    ticket: {
      findUnique: jest.fn().mockResolvedValue(t),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    checkIn: { create: jest.fn().mockResolvedValue({}) },
  };
  const service = new CheckinsService(
    prisma as never,
    { verify: jest.fn(() => PAYLOAD) } as never,
    { assertMember: jest.fn().mockResolvedValue(undefined) } as never,
    { record: jest.fn().mockResolvedValue(undefined) } as never,
    { send: jest.fn().mockResolvedValue(undefined) } as never,
    new MetricsService(),
  );
  return { service, prisma };
}

describe('a seat admitted by somebody else’s system', () => {
  it('refuses, and does NOT mark the ticket used', async () => {
    const { service, prisma } = setup(ticket({ vendorBarcode: 'PVR-8891726354' }));

    const out = await service.scan(STAFF, 'token', {});

    expect(out.result).toBe(CheckInResult.EXTERNAL);
    // The assertion that matters. A ticket flipped to CHECKED_IN here cannot be presented
    // again, so a wrong "success" would strand a paying customer at a door that refuses them.
    expect(prisma.ticket.updateMany).not.toHaveBeenCalled();
  });

  it('names who does admit them, when we know', async () => {
    // "Not here" leaves somebody standing at a gate working out where to go instead.
    const { service } = setup(
      ticket({ vendorBarcode: 'PVR-8891726354', vendorName: 'PVR Cinemas' }),
    );
    const out = await service.scan(STAFF, 'token', {});
    expect(out.message).toContain('PVR Cinemas');
  });

  it('still says something useful when we do not know the vendor', async () => {
    const { service } = setup(ticket({ vendorBarcode: 'X-1' }));
    const out = await service.scan(STAFF, 'token', {});
    expect(out.message).toMatch(/venue/i);
    expect(out.message).not.toContain('null');
  });

  it('writes EXTERNAL to the log, not INVALID', async () => {
    /*
      The log is evidence. A genuine ticket recorded as invalid reads, later, as a customer
      who tried to use a bad ticket — which is a different and worse story than the true one.
    */
    const { service, prisma } = setup(ticket({ vendorBarcode: 'X-1' }));
    await service.scan(STAFF, 'token', {});
    expect(prisma.checkIn.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ result: CheckInResult.EXTERNAL }),
      }),
    );
  });

  it('reports a refunded external ticket as REFUNDED, not as external', async () => {
    /*
      An ordering question worth being deliberate about, and the code had it the other way
      round until this test said so. A refunded external ticket should read as refunded —
      that is the actionable fact for whoever is holding it. "Scanned elsewhere" would send
      them to another gate that will also refuse them, with less to go on.
    */
    const { service } = setup(ticket({ vendorBarcode: 'X-1', status: TicketStatus.REFUNDED }));
    const out = await service.scan(STAFF, 'token', {});
    expect(out.result).toBe(CheckInResult.CANCELLED);
  });
});

describe('our own tickets are untouched', () => {
  it('still checks in normally when there is no vendor barcode', async () => {
    // The whole platform, today. Nothing about the ordinary path may change.
    const { service, prisma } = setup(ticket());
    const out = await service.scan(STAFF, 'token', {});
    expect(out.result).toBe(CheckInResult.SUCCESS);
    expect(prisma.ticket.updateMany).toHaveBeenCalled();
  });
});
