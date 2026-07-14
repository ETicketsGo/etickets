import 'reflect-metadata';
import { createServer } from 'node:http';
import { NestFactory } from '@nestjs/core';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import * as Sentry from '@sentry/node';
import {
  AppModule,
  BookingsService,
  EventsService,
  NotificationService,
  PrismaService,
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

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name === 'dispatch-notifications') {
        const summary = await notifications.dispatchDue();
        if (summary.sent + summary.failed + summary.retried > 0) {
          log('info', 'dispatched scheduled notifications', { ...summary });
        }
        return summary;
      }
      if (job.name !== 'expire-holds') return;
      const released = await bookings.releaseExpiredHolds();
      if (released > 0) log('info', 'released expired holds', { released });
      const completed = await events.completePastEvents();
      if (completed > 0) log('info', 'completed past events', { completed });
      return { released, completed };
    },
    { connection: redisConnection },
  );

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
