import 'reflect-metadata';
import { createServer } from 'node:http';
import { NestFactory } from '@nestjs/core';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import * as Sentry from '@sentry/node';
import {
  AppModule,
  AuthService,
  BookingsService,
  EventsService,
  FinanceReconciliationService,
  NotificationService,
  PrismaService,
  RazorpayWebhookProcessor,
  SettlementService,
  StripeWebhookProcessor,
  SyncEventProcessor,
  SyncPollingService,
  OutboxDispatcher,
  OutboxRetentionService,
} from '@eticketsgo/api';
import { renderWorkerMetrics, sampleQueueMetrics } from './metrics';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const WORKER_PORT = Number(process.env.WORKER_PORT ?? 4100);
const EXPIRY_EVERY_MS = Number(process.env.HOLD_EXPIRY_INTERVAL_MS ?? 60_000);
// Guard against a non-numeric env value (Number('') === 0, Number('x') === NaN).
const RAW_SWEEP_MS = Number(process.env.NOTIFICATION_SWEEP_INTERVAL_MS ?? 30_000);
const NOTIFICATION_SWEEP_MS =
  Number.isFinite(RAW_SWEEP_MS) && RAW_SWEEP_MS > 0 ? RAW_SWEEP_MS : 30_000;
const RAW_METRICS_MS = Number(process.env.QUEUE_METRICS_INTERVAL_MS ?? 15_000);
const QUEUE_METRICS_MS =
  Number.isFinite(RAW_METRICS_MS) && RAW_METRICS_MS > 0 ? RAW_METRICS_MS : 15_000;
const QUEUE_NAME = 'holds';

// Error tracking — a complete no-op unless SENTRY_DSN is set. Manual capture only.
const SENTRY_ENABLED = Boolean(process.env.SENTRY_DSN);
if (SENTRY_ENABLED) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: 0,
    sendDefaultPii: false,
  });
}

/** Capture to Sentry when enabled; otherwise a no-op. Never throws. */
function capture(error: unknown, tags?: Record<string, string>): void {
  if (!SENTRY_ENABLED) return;
  try {
    Sentry.withScope((scope) => {
      scope.setTag('service', 'worker');
      if (tags) for (const [k, v] of Object.entries(tags)) scope.setTag(k, v);
      Sentry.captureException(error);
    });
  } catch {
    /* best-effort */
  }
}

function log(
  level: 'info' | 'warn' | 'error',
  msg: string,
  extra: Record<string, unknown> = {},
): void {
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level, service: 'worker', msg, ...extra })}\n`,
  );
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const bookings = app.get(BookingsService);
  const events = app.get(EventsService);
  const prisma = app.get(PrismaService);
  const notifications = app.get(NotificationService);
  const finance = app.get(FinanceReconciliationService);
  const auth = app.get(AuthService);
  const stripeWebhooks = app.get(StripeWebhookProcessor);
  const razorpayWebhooks = app.get(RazorpayWebhookProcessor);
  const settlements = app.get(SettlementService);
  const syncProcessor = app.get(SyncEventProcessor);
  const syncPolling = app.get(SyncPollingService);
  const outboxDispatcher = app.get(OutboxDispatcher);
  const outboxRetention = app.get(OutboxRetentionService);
  const OUTBOX_POLL_MS = Number(process.env.DOMAIN_EVENT_OUTBOX_POLL_INTERVAL_MS ?? 1000);
  const OUTBOX_MAINT_MS = Number(process.env.OUTBOX_MAINTENANCE_INTERVAL_MS ?? 60_000);
  const SYNC_SWEEP_MS = Number(process.env.INVENTORY_SYNC_SWEEP_INTERVAL_MS ?? 30_000);
  const RAW_WEBHOOK_MS = Number(process.env.WEBHOOK_SWEEP_INTERVAL_MS ?? 15_000);
  const WEBHOOK_SWEEP_MS =
    Number.isFinite(RAW_WEBHOOK_MS) && RAW_WEBHOOK_MS > 0 ? RAW_WEBHOOK_MS : 15_000;
  const RECONCILE_EVERY_MS = Number(process.env.RECONCILE_INTERVAL_MS ?? 24 * 3600 * 1000);
  const TOKEN_PRUNE_EVERY_MS = Number(process.env.TOKEN_PRUNE_INTERVAL_MS ?? 24 * 3600 * 1000);

  // A plain options object avoids a type clash between our ioredis and the one
  // bundled inside bullmq. The IORedis instance is used only for health pings.
  const url = new URL(REDIS_URL);
  const redisConnection = {
    host: url.hostname,
    port: Number(url.port) || 6379,
    maxRetriesPerRequest: null as null,
  };
  const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue(QUEUE_NAME, { connection: redisConnection });

  // Idempotent, retryable repeatable job — releasing an already-released hold is a no-op.
  await queue.add(
    'expire-holds',
    {},
    {
      repeat: { every: EXPIRY_EVERY_MS },
      jobId: 'expire-holds',
      removeOnComplete: 50,
      removeOnFail: 50,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
    },
  );

  // Repeatable sweep that delivers due scheduled notifications. Idempotent:
  // dispatchDue only acts on rows still SCHEDULED and past their scheduledFor.
  await queue.add(
    'dispatch-notifications',
    {},
    {
      repeat: { every: NOTIFICATION_SWEEP_MS },
      jobId: 'dispatch-notifications',
      removeOnComplete: 50,
      removeOnFail: 50,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
    },
  );

  // Frequent sweep that processes durably-accepted Stripe webhook events (retry +
  // dead-letter). Idempotent: only RECEIVED/FAILED (past backoff) events are claimed.
  await queue.add(
    'process-webhooks',
    {},
    {
      repeat: { every: WEBHOOK_SWEEP_MS },
      jobId: 'process-webhooks',
      removeOnComplete: 50,
      removeOnFail: 50,
      attempts: 2,
      backoff: { type: 'exponential', delay: 5_000 },
    },
  );

  // Frequent sweep for external inventory sync (retry/dead-letter safety net + polling).
  // No-ops unless INVENTORY_SYNC_* flags are enabled.
  await queue.add(
    'inventory-sync-sweep',
    {},
    {
      repeat: {
        every: Number.isFinite(SYNC_SWEEP_MS) && SYNC_SWEEP_MS > 0 ? SYNC_SWEEP_MS : 30_000,
      },
      jobId: 'inventory-sync-sweep',
      removeOnComplete: 50,
      removeOnFail: 50,
      attempts: 2,
      backoff: { type: 'exponential', delay: 5_000 },
    },
  );

  // Transactional-outbox dispatch (ADR-041). Claims + delivers durable domain events.
  // No-op unless DOMAIN_EVENT_OUTBOX_DISPATCH_ENABLED. Also periodically recovers stale
  // leases + runs (disabled-by-default) retention.
  await queue.add(
    'outbox-dispatch',
    {},
    {
      repeat: {
        every: Number.isFinite(OUTBOX_POLL_MS) && OUTBOX_POLL_MS > 0 ? OUTBOX_POLL_MS : 1000,
      },
      jobId: 'outbox-dispatch',
      removeOnComplete: 20,
      removeOnFail: 20,
      attempts: 1,
    },
  );
  await queue.add(
    'outbox-maintenance',
    {},
    {
      repeat: {
        every: Number.isFinite(OUTBOX_MAINT_MS) && OUTBOX_MAINT_MS > 0 ? OUTBOX_MAINT_MS : 60_000,
      },
      jobId: 'outbox-maintenance',
      removeOnComplete: 20,
      removeOnFail: 20,
      attempts: 1,
    },
  );

  // Daily finance reconciliation — detects discrepancies into the triage queue.
  // Idempotent: detection dedupes open discrepancies for the same (env,type,ref).
  await queue.add(
    'reconcile-finance',
    {},
    {
      repeat: { every: RECONCILE_EVERY_MS },
      jobId: 'reconcile-finance',
      removeOnComplete: 20,
      removeOnFail: 20,
      attempts: 2,
      backoff: { type: 'exponential', delay: 30_000 },
    },
  );

  // Daily retention sweep — prune dead (expired/old-revoked) refresh tokens so the
  // PII-bearing table stays bounded. Idempotent: deleting already-gone rows is a no-op.
  await queue.add(
    'prune-tokens',
    {},
    {
      repeat: { every: TOKEN_PRUNE_EVERY_MS },
      jobId: 'prune-tokens',
      removeOnComplete: 20,
      removeOnFail: 20,
      attempts: 2,
      backoff: { type: 'exponential', delay: 30_000 },
    },
  );

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name === 'prune-tokens') {
        const pruned = await auth.pruneExpiredRefreshTokens();
        if (pruned > 0) log('info', 'pruned expired refresh tokens', { pruned });
        return { pruned };
      }
      if (job.name === 'reconcile-finance') {
        const summary = await finance.runDailyDetection();
        if (summary.created > 0) log('info', 'filed reconciliation discrepancies', { ...summary });
        return summary;
      }
      if (job.name === 'dispatch-notifications') {
        const summary = await notifications.dispatchDue();
        if (summary.sent + summary.failed + summary.retried > 0) {
          log('info', 'dispatched scheduled notifications', { ...summary });
        }
        return summary;
      }
      if (job.name === 'outbox-dispatch') {
        const r = await outboxDispatcher.dispatchBatch();
        if (r.claimed > 0) log('info', 'outbox dispatch', { ...r });
        return r;
      }
      if (job.name === 'outbox-maintenance') {
        const recovered = await outboxDispatcher.recoverStaleLeases();
        const purged = await outboxRetention.purge();
        if (recovered > 0 || purged.deliveredPurged + purged.deadLetterPurged > 0) {
          log('info', 'outbox maintenance', { recovered, ...purged });
        }
        return { recovered, ...purged };
      }
      if (job.name === 'inventory-sync-sweep') {
        // Safety-net sweep for durably-accepted sync events (retry/dead-letter) +
        // pull-based polling. No-ops unless the INVENTORY_SYNC_* flags are enabled.
        const swept = await syncProcessor.sweep();
        const polled = await syncPolling.pollAll();
        if (swept + polled > 0) log('info', 'inventory sync sweep', { swept, polled });
        return { swept, polled };
      }
      if (job.name === 'process-webhooks') {
        const stripe = await stripeWebhooks.processPending();
        const razorpay = await razorpayWebhooks.processPending();
        const processed = stripe.processed + razorpay.processed;
        if (processed > 0)
          log('info', 'processed provider webhooks', {
            stripe: stripe.processed,
            razorpay: razorpay.processed,
          });
        return { processed };
      }
      if (job.name !== 'expire-holds') return;
      const released = await bookings.releaseExpiredHolds();
      if (released > 0) log('info', 'released expired holds', { released });
      const completed = await events.completePastEvents();
      if (completed > 0) log('info', 'completed past events', { completed });
      // Promote settlements whose event has just completed to ELIGIBLE (awaiting approval).
      const { promoted } = await settlements.promoteCompletedEvents();
      if (promoted > 0) log('info', 'promoted settlements to eligible', { promoted });
      return { released, completed, promoted };
    },
    { connection: redisConnection },
  );

  // Dedicated Worker for the durable inventory-sync queue. Jobs carry only a
  // rawEventId; the processor reloads the event from PostgreSQL and claims it
  // atomically. Idempotent + no-op when processing is disabled.
  const syncWorker = new Worker(
    'inventory-sync-events',
    async (job) => {
      const rawEventId = (job.data as { rawEventId?: string })?.rawEventId;
      if (rawEventId) await syncProcessor.process(rawEventId);
    },
    { connection: redisConnection, concurrency: 8 },
  );
  syncWorker.on('failed', (job, err) => {
    log('error', 'inventory-sync job failed', { jobId: job?.id, error: err.message });
    capture(err, { jobId: job?.id ?? '-', jobName: 'inventory-sync' });
  });

  worker.on('failed', (job, err) => {
    log('error', 'job failed', { jobId: job?.id, error: err.message });
    capture(err, { jobId: job?.id ?? '-', jobName: job?.name ?? '-' });
  });
  worker.on('error', (err) => {
    log('error', 'worker error', { error: err.message });
    capture(err);
  });

  // Run once immediately on boot so restarts pick up any backlog promptly.
  await bookings
    .releaseExpiredHolds()
    .then((n) => n > 0 && log('info', 'startup sweep released holds', { released: n }));
  await events
    .completePastEvents()
    .then((n) => n > 0 && log('info', 'startup sweep completed past events', { completed: n }));

  // Sample queue depth into gauges on an interval (best-effort, never throws).
  await sampleQueueMetrics(queue);
  const metricsTimer = setInterval(() => void sampleQueueMetrics(queue), QUEUE_METRICS_MS);
  metricsTimer.unref?.();

  // Minimal health/readiness + Prometheus metrics endpoint.
  const health = createServer(async (req, res) => {
    if (req.url === '/metrics') {
      // The worker owns the queue, so it exposes queue metrics itself; Prometheus
      // scrapes both API (:4000/api/metrics) and worker (:4100/metrics).
      const { body, contentType } = await renderWorkerMetrics();
      res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
      res.end(body);
      return;
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.url === '/ready') {
      let db = false;
      let redis = false;
      try {
        await prisma.$queryRaw`SELECT 1`;
        db = true;
      } catch {
        /* down */
      }
      try {
        redis = (await connection.ping()) === 'PONG';
      } catch {
        /* down */
      }
      const ok = db && redis;
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: ok ? 'ok' : 'degraded', checks: { database: db, redis } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  health.listen(WORKER_PORT, () =>
    log('info', 'worker started', {
      port: WORKER_PORT,
      everyMs: EXPIRY_EVERY_MS,
      notificationSweepMs: NOTIFICATION_SWEEP_MS,
    }),
  );

  const shutdown = async (signal: string) => {
    log('info', 'shutting down', { signal });
    clearInterval(metricsTimer);
    await worker.close();
    await syncWorker.close();
    await queue.close();
    await connection.quit().catch(() => undefined);
    health.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  log('error', 'worker crashed', { error: err instanceof Error ? err.message : String(err) });
  capture(err, { phase: 'startup' });
  process.exit(1);
});
