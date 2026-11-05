import { SuppressionReason } from '@eticketsgo/shared-types';
import { scopeForReason } from '../notifications/delivery/suppression.service';
import { CampaignEventsService, mappingFor } from './campaign-events.service';

/**
 * What one SES event does to a campaign recipient, and which suppression it writes.
 *
 *   Reject           FAILED, event REJECTED, no suppression (SES refused the content)
 *   DeliveryDelay    DEFERRED from ACCEPTED, no suppression (SES is still trying)
 *   Bounce Permanent BOUNCED, ALL-scope suppression (the address is dead)
 *   Complaint        COMPLAINED, MARKETING-only suppression plus this organizer's own
 *                    suppression; never ALL, so tickets still go
 */
describe('mappingFor (SES event -> campaign recipient)', () => {
  it('Reject -> FAILED, event REJECTED, no suppression', () => {
    const m = mappingFor({ providerStatus: 'Reject' });
    expect(m).toMatchObject({ to: 'FAILED', event: 'REJECTED' });
    expect(m!.suppress).toBeUndefined();
  });

  it('DeliveryDelay -> DEFERRED from ACCEPTED only, no suppression', () => {
    const m = mappingFor({ providerStatus: 'DeliveryDelay' });
    expect(m).toMatchObject({ to: 'DEFERRED', from: ['ACCEPTED'], event: 'DEFERRED' });
    expect(m!.suppress).toBeUndefined();
  });

  it('RenderingFailure -> FAILED, event REJECTED, no suppression', () => {
    const m = mappingFor({ providerStatus: 'RenderingFailure' });
    expect(m).toMatchObject({ to: 'FAILED', event: 'REJECTED' });
    expect(m!.suppress).toBeUndefined();
  });

  it('Bounce Permanent -> BOUNCED with a HARD_BOUNCE suppression; Transient suppresses nothing', () => {
    expect(mappingFor({ providerStatus: 'Bounce', failureCode: 'Permanent' })).toMatchObject({
      to: 'BOUNCED',
      suppress: SuppressionReason.HARD_BOUNCE,
    });
    expect(
      mappingFor({ providerStatus: 'Bounce', failureCode: 'Transient' })!.suppress,
    ).toBeUndefined();
  });

  it('Complaint -> COMPLAINED with a COMPLAINT suppression', () => {
    expect(mappingFor({ providerStatus: 'Complaint' })).toMatchObject({
      to: 'COMPLAINED',
      event: 'COMPLAINED',
      suppress: SuppressionReason.COMPLAINT,
    });
  });
});

describe('CampaignEventsService.apply', () => {
  const recipient = {
    id: 'r1',
    campaignId: 'c1',
    organizationId: 'org-1',
    emailHash: 'hash-1',
    destinationMask: 'ab***@b.test',
    userId: null as string | null,
    status: 'ACCEPTED',
    deliveredAt: null,
  };

  function harness(status = 'ACCEPTED') {
    const prisma = {
      campaignRecipient: {
        findFirst: jest.fn().mockResolvedValue({ ...recipient, status }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      campaignEvent: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      organizerSuppression: { upsert: jest.fn().mockResolvedValue({}) },
      user: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const suppression = { suppress: jest.fn().mockResolvedValue(undefined) };
    const consent = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new CampaignEventsService(
      prisma as never,
      {} as never,
      suppression as never,
      consent as never,
      { register: jest.fn() } as never,
      { register: jest.fn() } as never,
    );
    const apply = (providerStatus: string, failureCode?: string) =>
      service.apply({
        provider: 'ses',
        providerMessageId: 'm1',
        providerStatus,
        failureCode: failureCode ?? null,
        eventId: `m1:${providerStatus}`,
      } as never);
    return { prisma, suppression, apply };
  }

  const statusWritten = (prisma: ReturnType<typeof harness>['prisma']) =>
    prisma.campaignRecipient.updateMany.mock.calls[0]?.[0]?.data?.status;
  const eventWritten = (prisma: ReturnType<typeof harness>['prisma']) =>
    prisma.campaignEvent.createMany.mock.calls[0]?.[0]?.data?.[0]?.type;

  it('Reject: recipient FAILED, event REJECTED, no suppression of any kind', async () => {
    const { prisma, suppression, apply } = harness();
    expect(await apply('Reject')).toBe('applied');
    expect(statusWritten(prisma)).toBe('FAILED');
    expect(eventWritten(prisma)).toBe('REJECTED');
    expect(suppression.suppress).not.toHaveBeenCalled();
    expect(prisma.organizerSuppression.upsert).not.toHaveBeenCalled();
  });

  it('DeliveryDelay: recipient DEFERRED from ACCEPTED, no suppression', async () => {
    const { prisma, suppression, apply } = harness('ACCEPTED');
    await apply('DeliveryDelay');
    expect(statusWritten(prisma)).toBe('DEFERRED');
    expect(eventWritten(prisma)).toBe('DEFERRED');
    expect(suppression.suppress).not.toHaveBeenCalled();
    expect(prisma.organizerSuppression.upsert).not.toHaveBeenCalled();
  });

  it('DeliveryDelay after DELIVERED does not move the recipient back', async () => {
    const { prisma, apply } = harness('DELIVERED');
    await apply('DeliveryDelay');
    expect(prisma.campaignRecipient.updateMany).not.toHaveBeenCalled();
  });

  it('Bounce Permanent: BOUNCED and an ALL-scope HARD_BOUNCE suppression', async () => {
    const { prisma, suppression, apply } = harness();
    await apply('Bounce', 'Permanent');
    expect(statusWritten(prisma)).toBe('BOUNCED');
    expect(suppression.suppress).toHaveBeenCalledTimes(1);
    const arg = suppression.suppress.mock.calls[0][0];
    expect(arg).toMatchObject({ channel: 'email', reason: SuppressionReason.HARD_BOUNCE });
    // No explicit scope: the reason's own scope applies, which is ALL for a hard bounce.
    expect(arg.scope).toBeUndefined();
    expect(prisma.organizerSuppression.upsert).not.toHaveBeenCalled();
  });

  it('Complaint: COMPLAINED, a MARKETING-only suppression and the organizer suppression, never ALL', async () => {
    const { prisma, suppression, apply } = harness();
    await apply('Complaint');
    expect(statusWritten(prisma)).toBe('COMPLAINED');
    expect(suppression.suppress).toHaveBeenCalledTimes(1);
    const arg = suppression.suppress.mock.calls[0][0];
    expect(arg.reason).toBe(SuppressionReason.COMPLAINT);
    expect(arg.scope === undefined || arg.scope === 'MARKETING').toBe(true);
    expect(scopeForReason(SuppressionReason.COMPLAINT)).toBe('MARKETING');
    expect(prisma.organizerSuppression.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.organizerSuppression.upsert.mock.calls[0][0].create).toMatchObject({
      organizationId: 'org-1',
      channel: 'email',
      destinationHash: 'hash-1',
      reason: SuppressionReason.COMPLAINT,
    });
  });
});
