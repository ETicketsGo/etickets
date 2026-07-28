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
});
