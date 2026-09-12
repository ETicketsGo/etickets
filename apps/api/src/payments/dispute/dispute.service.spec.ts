import { DisputeService, mapDisputeStatus } from './dispute.service';

describe('mapDisputeStatus', () => {
  it.each([
    ['needs_response', 'NEEDS_RESPONSE'],
    ['warning_needs_response', 'NEEDS_RESPONSE'],
    ['under_review', 'UNDER_REVIEW'],
    ['warning_under_review', 'UNDER_REVIEW'],
    ['won', 'WON'],
    ['lost', 'LOST'],
    ['warning_closed', 'WARNING_CLOSED'],
    ['charge_refunded', 'CLOSED'],
  ])('%s → %s', (stripe, expected) => {
    expect(mapDisputeStatus(stripe)).toBe(expected);
  });
});

function makeService() {
  const disputes: Array<Record<string, unknown>> = [];
  const prisma = {
    payment: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'p1',
        booking: { id: 'b1', organizationId: 'org1', eventId: 'e1' },
      }),
    },
    dispute: {
      // No row yet by default: the first delivery about a dispute creates it.
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      upsert: jest.fn(async ({ create }: { create: Record<string, unknown> }) => {
        disputes.push(create);
        return create;
      }),
    },
    booking: { update: jest.fn().mockResolvedValue({}) },
    user: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = { send: jest.fn().mockResolvedValue(undefined) };
  const settlements = { applyDispute: jest.fn().mockResolvedValue(undefined) };
  const service = new DisputeService(
    prisma as never,
    audit as never,
    notifications as never,
    settlements as never,
  );
  return { service, prisma, settlements, disputes };
}

describe('DisputeService.syncFromWebhook', () => {
  it('mirrors an open dispute, flags the booking, and blocks the settlement', async () => {
    const { service, prisma, settlements, disputes } = makeService();
    await service.syncFromWebhook({
      id: 'dp_1',
      payment_intent: 'pi_1',
      amount: 5000,
      currency: 'USD',
      reason: 'fraudulent',
      status: 'needs_response',
    });
    expect(disputes[0]).toMatchObject({
      providerDisputeId: 'dp_1',
      status: 'NEEDS_RESPONSE',
      eventId: 'e1',
    });
    expect(prisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'DISPUTED' } }),
    );
    expect(settlements.applyDispute).toHaveBeenCalledWith(
      'e1',
      'usd',
      expect.objectContaining({ open: true, lost: false, amountMinor: 5000 }),
    );
  });

  it('records a lost dispute for settlement recovery', async () => {
    const { service, settlements } = makeService();
    await service.syncFromWebhook({
      id: 'dp_2',
      payment_intent: 'pi_1',
      amount: 5000,
      currency: 'usd',
      status: 'lost',
    });
    expect(settlements.applyDispute).toHaveBeenCalledWith(
      'e1',
      'usd',
      expect.objectContaining({ lost: true }),
    );
  });

  /*
    Providers repeat a closed dispute's webhook, and every "lost" deducted the amount from the
    settlement again. Only the delivery that flips the dispute to LOST may record the loss.
  */
  it('does not record the loss again when the dispute was already lost', async () => {
    const { service, prisma, settlements } = makeService();
    prisma.dispute.findUnique.mockResolvedValue({ id: 'd1' });
    prisma.dispute.updateMany.mockResolvedValue({ count: 0 }); // already LOST
    await service.syncFromWebhook({
      id: 'dp_2',
      payment_intent: 'pi_1',
      amount: 5000,
      currency: 'usd',
      status: 'lost',
    });
    expect(prisma.dispute.updateMany).toHaveBeenCalledWith({
      where: { id: 'd1', status: { not: 'LOST' } },
      data: { status: 'LOST' },
    });
    expect(settlements.applyDispute).toHaveBeenCalledWith(
      'e1',
      'usd',
      expect.objectContaining({ lost: false }),
    );
  });

  it('records the loss when this delivery is the one that flips an open dispute to LOST', async () => {
    const { service, prisma, settlements } = makeService();
    prisma.dispute.findUnique.mockResolvedValue({ id: 'd1' });
    await service.syncFromWebhook({
      id: 'dp_2',
      payment_intent: 'pi_1',
      amount: 5000,
      currency: 'usd',
      status: 'lost',
    });
    expect(settlements.applyDispute).toHaveBeenCalledWith(
      'e1',
      'usd',
      expect.objectContaining({ lost: true }),
    );
  });
});
