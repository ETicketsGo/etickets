import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../../metrics/metrics.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncReconciliationService } from './sync-reconciliation.service';

function make(data: { mappings?: unknown[]; stuck?: unknown[]; stale?: unknown[] }) {
  const prisma = {
    providerMapping: { findMany: jest.fn().mockResolvedValue(data.mappings ?? []) },
    rawProviderEvent: { findMany: jest.fn().mockResolvedValue(data.stuck ?? []) },
    providerSyncCheckpoint: { findMany: jest.fn().mockResolvedValue(data.stale ?? []) },
  } as unknown as PrismaService;
  const config = { get: jest.fn().mockReturnValue(false) } as unknown as ConfigService;
  return new SyncReconciliationService(prisma, config, new MetricsService());
}

describe('SyncReconciliationService', () => {
  it('classifies mappings needing review', async () => {
    const svc = make({
      mappings: [
        {
          providerCode: 'mock',
          externalEntityType: 'SESSION',
          externalEntityId: 's1',
          status: 'AMBIGUOUS',
        },
      ],
    });
    const res = await svc.reconcile({});
    expect(res.mismatches[0].class).toBe('MAPPING_REVIEW_REQUIRED');
    expect(res.manualReviewRequired).toBe(1);
  });

  it('escalates terminal BOOKING/REFUND events to booking review', async () => {
    const svc = make({
      stuck: [{ providerCode: 'mock', eventType: 'provider.booking.status', id: 'r1' }],
    });
    const res = await svc.reconcile({});
    expect(res.mismatches[0].class).toBe('BOOKING_REVIEW_REQUIRED');
  });

  it('flags a failing checkpoint as provider-refresh-required', async () => {
    const svc = make({ stale: [{ providerCode: 'mock', resource: 'changes' }] });
    const res = await svc.reconcile({});
    expect(res.mismatches[0].class).toBe('PROVIDER_REFRESH_REQUIRED');
  });

  it('never auto-repairs (P4)', async () => {
    const svc = make({
      mappings: [
        {
          providerCode: 'mock',
          externalEntityType: 'SESSION',
          externalEntityId: 's1',
          status: 'UNMAPPED',
        },
      ],
    });
    const res = await svc.reconcile({});
    expect(res.autoRepaired).toBe(0);
  });
});
