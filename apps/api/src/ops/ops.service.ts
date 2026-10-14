import { HttpStatus, Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { FEATURE_DEFAULTS, isFeatureEnabled, type FeatureFlag } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AppException, ErrorCodes } from '../common/errors';
import { HOLDS_QUEUE, HOLDS_QUEUE_NAME } from './holds-queue.provider';
import { AuditService } from '../audit/audit.service';
import { audited } from '../audit/audited';
import {
  BACKUP_EVIDENCE_ACTION,
  OFFSITE_BACKUP_EVIDENCE_ACTION,
  evaluateOffsiteFreshness,
  OPS_EVIDENCE_ENTITY,
  RESTORE_DRILL_EVIDENCE_ACTION,
  backupFailsHealth,
  evaluateBackupFreshness,
  type BackupFreshness,
} from './backup-freshness';
import { OpsAlertService, type OpsAlertStatus } from './alerts/ops-alert.service';

type CheckStatus = 'up' | 'down';

interface DependencyCheck {
  status: CheckStatus;
  latencyMs: number;
  error?: string;
}

interface QueueCheck {
  status: 'ok' | 'degraded' | 'down';
  latencyMs: number;
  /** Every failed job BullMQ still holds, however old. */
  failed?: number;
  /** Failed in the last RECENT_FAILURE_HOURS - the only ones that make the queue degraded. */
  recentFailed?: number;
  /** When the most recent failure happened (ISO), so "20 failed" can say "last on 9 Aug". */
  lastFailedAt?: string | null;
  error?: string;
}

/**
 * How recent a failed job must be to count against health.
 *
 * BullMQ keeps failed jobs until somebody removes them. QA showed "Queue Degraded" on
 * 2026-10-10 for 20 jobs that failed during a database outage on 9 Aug - two months of a red
 * health tile for something long over. Old failures stay listed (and retryable); they no longer
 * claim the system is unhealthy now.
 */
export const RECENT_FAILURE_HOURS = 24;

export interface OpsHealth {
  status: 'ok' | 'degraded';
  database: DependencyCheck;
  redis: DependencyCheck;
  queue: QueueCheck;
  storage: { status: 'not_configured' };
  /** Age of the newest VERIFIED database backup. Fails health in PRODUCTION when stale or absent. */
  backup: BackupFreshness;
  uptime: number;
  nodeEnv: string;
  /**
   * Which environment this is (LOCAL / QA / UAT / PRODUCTION). QA and UAT run NODE_ENV=production,
   * so labelling by NODE_ENV told an admin on QA they were looking at "production".
   */
  appEnv: string | null;
  /**
   * Whether money-critical failures reach a person by email, and when the last one fired.
   * Informational: it never changes `status`, because a missing alert list is a setup gap, not
   * a system that is down.
   */
  opsAlerts: OpsAlertStatus;
}

/** What health reports when the alert service is not wired (a hand-built service in a test). */
const ALERTS_ABSENT: OpsAlertStatus = {
  configured: false,
  status: 'not_configured',
  reason: 'The ops alert service is not available in this process.',
  recipients: 0,
  emailProvider: 'none',
  lastAlertAt: null,
  lastAlertKind: null,
};

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
    // Optional so a service built by hand in a unit test needs no audit double.
    @Optional() private readonly audit?: AuditService,
    @Optional() private readonly alerts?: OpsAlertService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.queue.close().catch(() => undefined);
  }

  // ─────────────────────────── Health ───────────────────────────

  async health(): Promise<OpsHealth> {
    const [database, redis, queue, backup, opsAlerts] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkQueue(),
      this.checkBackup(),
      this.alerts ? this.alerts.status().catch(() => ALERTS_ABSENT) : ALERTS_ABSENT,
    ]);
    const appEnv = this.config.get<string>('APP_ENV') ?? null;
    const backupRequired =
      (appEnv ?? '').toUpperCase() === 'PRODUCTION' ||
      this.config.get<string>('BACKUP_FRESHNESS_REQUIRED') === 'true';
    const healthy =
      database.status === 'up' &&
      redis.status === 'up' &&
      queue.status === 'ok' &&
      !backupFailsHealth(backup, backupRequired);
    return {
      status: healthy ? 'ok' : 'degraded',
      database,
      redis,
      queue,
      backup,
      // S3/blob storage is not configured yet — report it honestly.
      storage: { status: 'not_configured' },
      uptime: process.uptime(),
      nodeEnv: this.config.get<string>('NODE_ENV', 'development'),
      appEnv: this.config.get<string>('APP_ENV') ?? null,
      opsAlerts,
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

  /**
   * Age of the newest verified backup, read from the evidence row the nightly run writes.
   * Never throws: an unreadable table is 'unknown', not a 500 on the health endpoint.
   */
  private async checkBackup(): Promise<BackupFreshness> {
    const maxAge = Number(this.config.get<string>('BACKUP_MAX_AGE_HOURS'));
    const opts = Number.isFinite(maxAge) && maxAge > 0 ? { maxAgeHours: maxAge } : {};
    try {
      // The off-platform copy is optional: when no bucket is configured it is not even queried.
      const offsiteConfigured = Boolean(this.config.get<string>('BACKUP_OFFSITE_BUCKET')?.trim());
      const offsiteMaxAge = Number(this.config.get<string>('BACKUP_OFFSITE_MAX_AGE_HOURS'));
      const [backup, drill, offsiteRow] = await Promise.all([
        this.prisma.auditLog.findFirst({
          where: { action: BACKUP_EVIDENCE_ACTION, entityType: OPS_EVIDENCE_ENTITY },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true, entityId: true },
        }),
        this.prisma.auditLog.findFirst({
          where: { action: RESTORE_DRILL_EVIDENCE_ACTION, entityType: OPS_EVIDENCE_ENTITY },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        }),
        offsiteConfigured
          ? this.prisma.auditLog.findFirst({
              where: { action: OFFSITE_BACKUP_EVIDENCE_ACTION, entityType: OPS_EVIDENCE_ENTITY },
              orderBy: { createdAt: 'desc' },
              select: { createdAt: true, metadata: true },
            })
          : Promise.resolve(null),
      ]);
      const result = evaluateBackupFreshness(backup?.createdAt ?? null, new Date(), {
        ...opts,
        lastBackupName: backup?.entityId ?? null,
        lastRestoreDrillAt: drill?.createdAt ?? null,
      });
      if (offsiteConfigured) {
        const meta = (offsiteRow?.metadata ?? null) as { key?: unknown } | null;
        result.offsite = evaluateOffsiteFreshness(offsiteRow?.createdAt ?? null, new Date(), {
          ...(Number.isFinite(offsiteMaxAge) && offsiteMaxAge > 0
            ? { maxAgeHours: offsiteMaxAge }
            : {}),
          lastKey: typeof meta?.key === 'string' ? meta.key : null,
        });
      }
      return result;
    } catch {
      return {
        ...evaluateBackupFreshness(null, new Date(), opts),
        status: 'unknown',
      };
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
      if (failed === 0) {
        return {
          status: 'ok',
          latencyMs: Date.now() - start,
          failed,
          recentFailed: 0,
          lastFailedAt: null,
        };
      }
      // Newest first is not guaranteed, so read a bounded page and take the latest finish time.
      const jobs = await this.queue.getFailed(0, 199);
      const finishedAt = jobs
        .map((j) => Number(j.finishedOn ?? j.processedOn ?? j.timestamp ?? 0))
        .filter((t) => t > 0);
      const cutoff = Date.now() - RECENT_FAILURE_HOURS * 3600 * 1000;
      const recentFailed = finishedAt.filter((t) => t >= cutoff).length;
      const last = finishedAt.length ? Math.max(...finishedAt) : null;
      return {
        status: recentFailed > 0 ? 'degraded' : 'ok',
        latencyMs: Date.now() - start,
        failed,
        recentFailed,
        lastFailedAt: last ? new Date(last).toISOString() : null,
      };
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

  async retryFailed(
    actorUserId: string | null = null,
  ): Promise<{ retried: number; total: number }> {
    return audited(
      this.audit,
      {
        actorUserId,
        action: 'OPS_QUEUE_RETRY_ALL',
        entityType: 'Queue',
        entityId: HOLDS_QUEUE_NAME,
      },
      () => this.retryAllFailed(),
      (r) => ({ retried: r.retried, total: r.total }),
    );
  }

  private async retryAllFailed(): Promise<{ retried: number; total: number }> {
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

  async retryJob(
    id: string,
    actorUserId: string | null = null,
  ): Promise<{ id: string; retried: boolean }> {
    return audited(
      this.audit,
      {
        actorUserId,
        action: 'OPS_QUEUE_RETRY_JOB',
        entityType: 'QueueJob',
        entityId: id,
        metadata: { queue: HOLDS_QUEUE_NAME },
      },
      () => this.retrySingleJob(id),
    );
  }

  private async retrySingleJob(id: string): Promise<{ id: string; retried: boolean }> {
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
