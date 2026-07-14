import { HttpStatus, Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { FEATURE_DEFAULTS, isFeatureEnabled, type FeatureFlag } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AppException, ErrorCodes } from '../common/errors';
import { HOLDS_QUEUE, HOLDS_QUEUE_NAME } from './holds-queue.provider';

type CheckStatus = 'up' | 'down';

interface DependencyCheck {
  status: CheckStatus;
  latencyMs: number;
  error?: string;
}

interface QueueCheck {
  status: 'ok' | 'degraded' | 'down';
  latencyMs: number;
  failed?: number;
  error?: string;
}

export interface OpsHealth {
  status: 'ok' | 'degraded';
  database: DependencyCheck;
  redis: DependencyCheck;
  queue: QueueCheck;
  storage: { status: 'not_configured' };
  uptime: number;
  nodeEnv: string;
}

export interface QueueCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
}

export interface RepeatableJobInfo {
  name: string;
  every: string | null;
  pattern: string | null;
  next: string | null;
}

export interface FailedJob {
  id: string | null;
  name: string;
  failedReason: string | null;
  attemptsMade: number;
  timestamp: string | null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read-only operations intelligence: composes system health from the injected
 * Prisma/Redis/queue clients and drives failed-job retries on the `holds` queue.
 * Every health check is defensive — a failing dependency is reported as down,
 * never thrown as a 500. Owns the lifecycle of the injected queue client.
 */
@Injectable()
export class OpsService implements OnModuleDestroy {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    @Inject(HOLDS_QUEUE) private readonly queue: Queue,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.queue.close().catch(() => undefined);
  }

  // ─────────────────────────── Health ───────────────────────────

  async health(): Promise<OpsHealth> {
    const [database, redis, queue] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkQueue(),
    ]);
    const healthy = database.status === 'up' && redis.status === 'up' && queue.status === 'ok';
    return {
      status: healthy ? 'ok' : 'degraded',
      database,
      redis,
      queue,
      // S3/blob storage is not configured yet — report it honestly.
      storage: { status: 'not_configured' },
      uptime: process.uptime(),
      nodeEnv: this.config.get<string>('NODE_ENV', 'development'),
    };
  }

  private async checkDatabase(): Promise<DependencyCheck> {
    const start = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'up', latencyMs: Date.now() - start };
    } catch (err) {
      return { status: 'down', latencyMs: Date.now() - start, error: errorMessage(err) };
    }
  }

  private async checkRedis(): Promise<DependencyCheck> {
    const start = Date.now();
    try {
      const res = await this.redis.client.ping();
      const up = res === 'PONG';
      return up
        ? { status: 'up', latencyMs: Date.now() - start }
        : { status: 'down', latencyMs: Date.now() - start, error: `unexpected ping reply: ${res}` };
    } catch (err) {
      return { status: 'down', latencyMs: Date.now() - start, error: errorMessage(err) };
    }
  }

  private async checkQueue(): Promise<QueueCheck> {
    const start = Date.now();
    try {
      const counts = await this.queue.getJobCounts('waiting', 'active', 'failed', 'delayed');
      const failed = Number(counts.failed ?? 0);
      return { status: failed > 0 ? 'degraded' : 'ok', latencyMs: Date.now() - start, failed };
    } catch (err) {
      return { status: 'down', latencyMs: Date.now() - start, error: errorMessage(err) };
    }
  }

  // ─────────────────────────── Queues ───────────────────────────

  async queues(): Promise<{ name: string; counts: QueueCounts; repeatable: RepeatableJobInfo[] }> {
    const raw = await this.queue.getJobCounts(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed',
      'paused',
    );
    const counts: QueueCounts = {
      waiting: Number(raw.waiting ?? 0),
      active: Number(raw.active ?? 0),
      completed: Number(raw.completed ?? 0),
      failed: Number(raw.failed ?? 0),
      delayed: Number(raw.delayed ?? 0),
      paused: Number(raw.paused ?? 0),
    };

    let repeatable: RepeatableJobInfo[] = [];
    try {
      const jobs = await this.queue.getRepeatableJobs();
      repeatable = jobs.map((j) => ({
        name: j.name ?? '',
        every: j.every != null ? String(j.every) : null,
        pattern: j.pattern ?? null,
        next: typeof j.next === 'number' ? new Date(j.next).toISOString() : null,
      }));
    } catch {
      repeatable = [];
    }

    return { name: HOLDS_QUEUE_NAME, counts, repeatable };
  }

  async failedJobs(limit = 20): Promise<{ jobs: FailedJob[] }> {
    const bounded = Math.min(Math.max(Math.trunc(limit) || 20, 1), 100);
    const jobs = await this.queue.getFailed(0, bounded - 1);
    return { jobs: jobs.map((job) => this.toFailedJob(job)) };
  }

  async retryFailed(): Promise<{ retried: number; total: number }> {
    // Bound the batch so a huge backlog can't hang the request.
    const jobs = await this.queue.getFailed(0, 99);
    let retried = 0;
    for (const job of jobs) {
      try {
        await job.retry();
        retried += 1;
      } catch {
        // Skip jobs that are no longer retryable (e.g. already moved on).
      }
    }
    return { retried, total: jobs.length };
  }

  async retryJob(id: string): Promise<{ id: string; retried: boolean }> {
    const job = await this.queue.getJob(id);
    if (!job) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        `Job ${id} was not found.`,
        HttpStatus.NOT_FOUND,
      );
    }
    try {
      await job.retry();
    } catch (err) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `Job ${id} could not be retried: ${errorMessage(err)}`,
        HttpStatus.CONFLICT,
      );
    }
    return { id, retried: true };
  }

  private toFailedJob(job: {
    id?: string;
    name: string;
    failedReason?: string;
    attemptsMade: number;
    timestamp: number;
  }): FailedJob {
    return {
      id: job.id ?? null,
      name: job.name,
      failedReason: job.failedReason ?? null,
      attemptsMade: job.attemptsMade,
      timestamp: typeof job.timestamp === 'number' ? new Date(job.timestamp).toISOString() : null,
    };
  }

  // ─────────────────────────── Feature flags ───────────────────────────

  /**
   * Resolved feature flags for display. Toggling remains env-based
   * (FEATURE_<NAME> at boot) — there is no runtime override store in this sprint.
   */
  flags(): { flags: { key: FeatureFlag; enabled: boolean }[]; note: string } {
    const flags = (Object.keys(FEATURE_DEFAULTS) as FeatureFlag[]).map((key) => ({
      key,
      enabled: isFeatureEnabled(key),
    }));
    return {
      flags,
      note: 'Flags resolve from environment at boot (FEATURE_<NAME> / NEXT_PUBLIC_FEATURE_<NAME>). Toggling is env-based, not runtime.',
    };
  }
}
