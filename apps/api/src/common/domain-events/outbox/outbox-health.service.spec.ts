import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxHealthService } from './outbox-health.service';
import { OutboxDispatcher } from './outbox-dispatcher.service';

function make(cfg: Record<string, unknown>, counts: number[]) {
  const count = jest.fn();
  counts.forEach((c) => count.mockResolvedValueOnce(c));
  const prisma = {
    outboxEvent: { count, findFirst: jest.fn().mockResolvedValue(null) },
  } as unknown as PrismaService;
  const config = {
    get: jest.fn((k: string, d?: unknown) => cfg[k] ?? d),
  } as unknown as ConfigService;
  const dispatcher = { lastDispatch: null, workerId: 'w1' } as unknown as OutboxDispatcher;
  return new OutboxHealthService(prisma, config, dispatcher);
}

// counts order: pending, processing, retryable, deadLettered, manualReview, staleLease
describe('OutboxHealthService', () => {
  it('DISABLED in in_process mode', async () => {
    const h = await make({ DOMAIN_EVENT_DELIVERY_MODE: 'in_process' }, [0, 0, 0, 0, 0, 0]).report();
    expect(h.state).toBe('DISABLED');
  });

  it('UNHEALTHY in outbox mode with the dispatcher disabled', async () => {
    const h = await make(
      { DOMAIN_EVENT_DELIVERY_MODE: 'outbox', DOMAIN_EVENT_OUTBOX_DISPATCH_ENABLED: false },
      [3, 0, 0, 0, 0, 0],
    ).report();
    expect(h.state).toBe('UNHEALTHY');
  });

  it('DEGRADED when dead-letters exist', async () => {
    const h = await make(
      { DOMAIN_EVENT_DELIVERY_MODE: 'outbox', DOMAIN_EVENT_OUTBOX_DISPATCH_ENABLED: true },
      [0, 0, 0, 2, 0, 0],
    ).report();
    expect(h.state).toBe('DEGRADED');
  });

  it('HEALTHY when enabled + no backlog/dead-letters', async () => {
    const h = await make(
      { DOMAIN_EVENT_DELIVERY_MODE: 'outbox', DOMAIN_EVENT_OUTBOX_DISPATCH_ENABLED: true },
      [0, 0, 0, 0, 0, 0],
    ).report();
    expect(h.state).toBe('HEALTHY');
  });
});
