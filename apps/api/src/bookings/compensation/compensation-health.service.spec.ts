import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from '../../metrics/metrics.service';
import { CompensationHealthService } from './compensation-health.service';

function make(flags: Record<string, boolean> = {}) {
  const prisma = {
    bookingCompensation: {
      groupBy: jest.fn().mockResolvedValue([
        { state: 'READY', _count: { _all: 3 } },
        { state: 'DEAD_LETTERED', _count: { _all: 1 } },
        { state: 'MANUAL_REVIEW', _count: { _all: 2 } },
      ]),
      aggregate: jest
        .fn()
        .mockResolvedValueOnce({ _min: { availableAt: new Date(Date.now() - 120_000) } })
        .mockResolvedValueOnce({ _max: { completedAt: new Date() } }),
      count: jest.fn().mockResolvedValue(0),
    },
    bookingWorkflow: { count: jest.fn().mockResolvedValue(4) },
    $queryRaw: jest.fn().mockResolvedValue([{ n: BigInt(0) }]),
  } as unknown as PrismaService;
  const config = { get: jest.fn((k: string) => flags[k] ?? false) } as unknown as ConfigService;
  const svc = new CompensationHealthService(prisma, config, new MetricsService());
  return { svc };
}

describe('CompensationHealthService', () => {
  it('reports mode + bounded counts, never ids/PII', async () => {
    const { svc } = make({
      BOOKING_COMPENSATION_ENABLED: true,
      BOOKING_COMPENSATION_PLANNING_ENABLED: true,
    });
    const snap = (await svc.snapshot()) as Record<string, never>;
    expect(snap.mode).toEqual({ planning: true, execution: false });
    expect((snap.counts as Record<string, number>).ready).toBe(3);
    expect((snap.counts as Record<string, number>).deadLettered).toBe(1);
    expect((snap.counts as Record<string, number>).manualReview).toBe(2);
    expect(snap.oldestReadyAgeSeconds as number).toBeGreaterThanOrEqual(110);
    expect(snap.providerPendingBacklog).toBe(4);
    expect(snap.statusRecoveryBacklog).toBe(4);
    expect(snap.allocationDriftCount).toBe(0);
    // No id/PII fields leak into the health payload.
    expect(JSON.stringify(snap)).not.toMatch(/bookingId|userId|email|reservationId/i);
  });

  it('is unhealthy when dead-letters or allocation drift are present', async () => {
    const { svc } = make({ BOOKING_COMPENSATION_ENABLED: true });
    const snap = (await svc.snapshot()) as Record<string, unknown>;
    expect(snap.healthy).toBe(false); // 1 dead-letter seeded above
  });
});
