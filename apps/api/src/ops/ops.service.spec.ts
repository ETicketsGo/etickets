import { OpsService } from './ops.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { RedisService } from '../redis/redis.service';
import type { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { AppException } from '../common/errors';

type QueueMock = {
  getJobCounts: jest.Mock;
  getFailed: jest.Mock;
  getRepeatableJobs: jest.Mock;
  getJob: jest.Mock;
  close: jest.Mock;
};

function makeService(overrides: {
  queryRaw?: jest.Mock;
  ping?: jest.Mock;
  queue?: Partial<QueueMock>;
}) {
  const prisma = {
    $queryRaw: overrides.queryRaw ?? jest.fn().mockResolvedValue([{ '?column?': 1 }]),
  } as unknown as PrismaService;
  const redis = {
    client: { ping: overrides.ping ?? jest.fn().mockResolvedValue('PONG') },
  } as unknown as RedisService;
  const config = {
    get: jest.fn((_k: string, d?: unknown) => d ?? 'test'),
  } as unknown as ConfigService;
  const queue = {
    getJobCounts: jest.fn().mockResolvedValue({ waiting: 0, active: 0, failed: 0, delayed: 0 }),
    getFailed: jest.fn().mockResolvedValue([]),
    getRepeatableJobs: jest.fn().mockResolvedValue([]),
    getJob: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    ...overrides.queue,
  } as unknown as Queue;
  return {
    service: new OpsService(prisma, redis, config, queue),
    queue: queue as unknown as QueueMock,
  };
}

describe('OpsService.health', () => {
  it('reports ok when database, redis and queue are all healthy', async () => {
    const { service } = makeService({
      queue: { getJobCounts: jest.fn().mockResolvedValue({ failed: 0 }) },
    });
    const health = await service.health();
    expect(health.status).toBe('ok');
    expect(health.database.status).toBe('up');
    expect(health.redis.status).toBe('up');
    expect(health.queue.status).toBe('ok');
    expect(health.storage).toEqual({ status: 'not_configured' });
    expect(typeof health.uptime).toBe('number');
  });

  it('reports database down (not thrown) when the query fails', async () => {
    const { service } = makeService({
      queryRaw: jest.fn().mockRejectedValue(new Error('connection refused')),
    });
    const health = await service.health();
    expect(health.status).toBe('degraded');
    expect(health.database.status).toBe('down');
    expect(health.database.error).toContain('connection refused');
  });

  it('reports redis down when ping does not return PONG', async () => {
    const { service } = makeService({ ping: jest.fn().mockResolvedValue('NOPE') });
    const health = await service.health();
    expect(health.status).toBe('degraded');
    expect(health.redis.status).toBe('down');
  });

  it('marks the queue degraded when there are failed jobs', async () => {
    const { service } = makeService({
      queue: { getJobCounts: jest.fn().mockResolvedValue({ failed: 3 }) },
    });
    const health = await service.health();
    expect(health.queue.status).toBe('degraded');
    expect(health.queue.failed).toBe(3);
    expect(health.status).toBe('degraded');
  });

  it('reports queue down when the queue client throws', async () => {
    const { service } = makeService({
      queue: { getJobCounts: jest.fn().mockRejectedValue(new Error('redis gone')) },
    });
    const health = await service.health();
    expect(health.queue.status).toBe('down');
    expect(health.queue.error).toContain('redis gone');
  });
});

describe('OpsService queues', () => {
  it('returns normalized job counts and repeatable schedules', async () => {
    const { service } = makeService({
      queue: {
        getJobCounts: jest.fn().mockResolvedValue({
          waiting: 2,
          active: 1,
          completed: 10,
          failed: 1,
          delayed: 0,
          paused: 0,
        }),
        getRepeatableJobs: jest
          .fn()
          .mockResolvedValue([
            { name: 'expire-holds', every: 60000, pattern: null, next: 1700000000000 },
          ]),
      },
    });
    const res = await service.queues();
    expect(res.name).toBe('holds');
    expect(res.counts.waiting).toBe(2);
    expect(res.counts.completed).toBe(10);
    expect(res.repeatable[0]).toMatchObject({ name: 'expire-holds', every: '60000' });
  });

  it('lists failed jobs with a bounded limit', async () => {
    const getFailed = jest.fn().mockResolvedValue([
      {
        id: '1',
        name: 'expire-holds',
        failedReason: 'boom',
        attemptsMade: 3,
        timestamp: 1700000000000,
      },
    ]);
    const { service } = makeService({ queue: { getFailed } });
    const res = await service.failedJobs(5);
    // getFailed(start, end) — end is inclusive, so limit 5 → (0, 4).
    expect(getFailed).toHaveBeenCalledWith(0, 4);
    expect(res.jobs[0]).toMatchObject({ id: '1', name: 'expire-holds', failedReason: 'boom' });
  });

  it('retries all failed jobs and counts successes, skipping errors', async () => {
    const ok = { retry: jest.fn().mockResolvedValue(undefined) };
    const bad = { retry: jest.fn().mockRejectedValue(new Error('not retryable')) };
    const getFailed = jest.fn().mockResolvedValue([ok, bad]);
    const { service } = makeService({ queue: { getFailed } });
    const res = await service.retryFailed();
    expect(res).toEqual({ retried: 1, total: 2 });
  });

  it('retries a single job by id', async () => {
    const retry = jest.fn().mockResolvedValue(undefined);
    const getJob = jest.fn().mockResolvedValue({ retry });
    const { service } = makeService({ queue: { getJob } });
    const res = await service.retryJob('abc');
    expect(retry).toHaveBeenCalled();
    expect(res).toEqual({ id: 'abc', retried: true });
  });

  it('throws NOT_FOUND when retrying a missing job', async () => {
    const { service } = makeService({ queue: { getJob: jest.fn().mockResolvedValue(null) } });
    await expect(service.retryJob('nope')).rejects.toBeInstanceOf(AppException);
  });
});

describe('OpsService.flags', () => {
  it('returns every feature flag with a resolved boolean', () => {
    const { service } = makeService({});
    const res = service.flags();
    expect(res.flags.length).toBeGreaterThan(0);
    expect(res.flags.every((f) => typeof f.enabled === 'boolean')).toBe(true);
    expect(res.note).toMatch(/env/i);
  });
});

describe('OpsService.onModuleDestroy', () => {
  it('closes the queue client', async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    const { service } = makeService({ queue: { close } });
    await service.onModuleDestroy();
    expect(close).toHaveBeenCalled();
  });
});
