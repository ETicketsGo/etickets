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
  LocalBookingOrchestrator,
  EventsService,
  EventSellabilitySweepService,
  FinanceReconciliationService,
  NotificationService,
  NotificationFallbackService,
  ProviderEventReplayService,
  ShowCancellationFanoutService,
  ShowReminderService,
  PrismaService,
  RazorpayWebhookProcessor,
  SeatOverridesService,
  SettlementService,
  StripeWebhookProcessor,
  SyncEventProcessor,
  SyncPollingService,
  OutboxDispatcher,
  OutboxRetentionService,
  bullConnectionFromUrl,
  bullPrefix,
} from '@eticketsgo/api';
import { metricsAccess } from '@eticketsgo/shared-types';
import { renderWorkerMetrics, sampleQueueMetrics } from './metrics';

/**
 * The Redis this worker drives its queues through, or a refusal to start.
 *
 * `redis://localhost:6379` is the developer default. In a deployed container there is no Redis on
 * localhost, so a worker that lost REDIS_URL used to start, report itself up, and never expire a
 * hold or send a notification. Keyed on APP_ENV rather than NODE_ENV because QA and UAT run with
 * NODE_ENV=production. Mirrors `resolveRedisUrl` in the API's config, which the API's index does
 * not export; the application context below enforces that one as well.
 */
function redisUrlForEnvironment(): string {
  const appEnv = (process.env.APP_ENV ?? '').trim().toUpperCase() || 'LOCAL';
  const url = (process.env.REDIS_URL ?? '').trim();
  if (['LOCAL', 'DEV', 'TEST'].includes(appEnv)) return url || 'redis://localhost:6379';
  if (!url)
    throw new Error(`REDIS_URL is not set, and APP_ENV=${appEnv} has no Redis on localhost.`);
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    // Not echoed: the URL carries the Redis password.
    throw new Error(`REDIS_URL is not a valid URL (APP_ENV=${appEnv}).`);
  }
  if (
    ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(host) ||
    host.endsWith('.localhost') ||
    host.startsWith('127.')
  ) {
    throw new Error(`REDIS_URL points at ${host}, and APP_ENV=${appEnv} has no Redis there.`);
  }
  return url;
}
// PaaS platforms (Railway, Heroku, Render…) inject the port to listen on as PORT and probe the
// health endpoint there. Honour it first so the platform health check reaches us; WORKER_PORT
// stays supported for compose/k8s deployments that pin :4100, and 4100 remains the default.
const RAW_WORKER_PORT = Number(process.env.PORT ?? process.env.WORKER_PORT ?? 4100);
const WORKER_PORT =
  Number.isInteger(RAW_WORKER_PORT) && RAW_WORKER_PORT >= 0 && RAW_WORKER_PORT <= 65535
    ? RAW_WORKER_PORT
    : 4100;
// Guarded like the intervals below: a blank or mistyped value is 0 or NaN, and BullMQ refuses a
// repeat of either, which crash-loops the worker on a configuration typo.
const RAW_EXPIRY_MS = Number(process.env.HOLD_EXPIRY_INTERVAL_MS ?? 60_000);
const EXPIRY_EVERY_MS =
  Number.isFinite(RAW_EXPIRY_MS) && RAW_EXPIRY_MS > 0 ? RAW_EXPIRY_MS : 60_000;
/*
  Every five seconds, not thirty.

  This sweep used to carry only DEFERRED notifications -- reminders queued days ahead -- so a
  thirty-second granularity was irrelevant. It now carries every notification the platform
  sends, because delivery moved off the request path and behind this table, and thirty seconds
  is a long time to wait for the email containing the ticket you just paid for.

  Guard against a non-numeric env value (Number('') === 0, Number('x') === NaN).
*/
const RAW_SWEEP_MS = Number(process.env.NOTIFICATION_SWEEP_INTERVAL_MS ?? 5_000);
const NOTIFICATION_SWEEP_MS =
  Number.isFinite(RAW_SWEEP_MS) && RAW_SWEEP_MS > 0 ? RAW_SWEEP_MS : 5_000;
/*
  A minute, not five seconds. The fallback sweep asks whether enough TIME has passed with
  nothing effective; running it at the dispatch cadence would ask that question hundreds of
  times per answer, and the answer cannot change faster than the wait it is measuring.
*/
const RAW_FALLBACK_MS = Number(process.env.NOTIFICATION_FALLBACK_INTERVAL_MS ?? 60_000);
const FALLBACK_SWEEP_MS =
  Number.isFinite(RAW_FALLBACK_MS) && RAW_FALLBACK_MS > 0 ? RAW_FALLBACK_MS : 60_000;
/*
  A minute for the cancellation guarantee, and five for reminders.

  Neither is a latency-sensitive path: the cancellation fan-out is started immediately by the
  domain-event handler and this sweep is the safety net behind it, and a reminder twenty-four
  hours ahead does not care about five minutes. Running either at the dispatch cadence would
  ask an expensive question hundreds of times per useful answer.
*/
const RAW_CANCELLATION_MS = Number(process.env.NOTIFICATION_FANOUT_INTERVAL_MS ?? 60_000);
const CANCELLATION_SWEEP_MS =
  Number.isFinite(RAW_CANCELLATION_MS) && RAW_CANCELLATION_MS > 0 ? RAW_CANCELLATION_MS : 60_000;
/*
  Hourly, and deliberately not faster.

  This asks whether a PUBLISHED listing has become unsellable, which changes only when
  somebody edits configuration or a rate order takes effect. Running it every few seconds
  would re-answer a question whose answer moves a handful of times a week, against every
  live event, for nothing. An hour is well inside "before the organizer's day is ruined" and
  well outside "expensive".
*/
const RAW_SELLABILITY_MS = Number(process.env.EVENT_SELLABILITY_INTERVAL_MS ?? 3_600_000);
const SELLABILITY_SWEEP_MS =
  Number.isFinite(RAW_SELLABILITY_MS) && RAW_SELLABILITY_MS > 0 ? RAW_SELLABILITY_MS : 3_600_000;
const RAW_REMINDER_MS = Number(process.env.NOTIFICATION_REMINDER_INTERVAL_MS ?? 300_000);
const REMINDER_SWEEP_MS =
  Number.isFinite(RAW_REMINDER_MS) && RAW_REMINDER_MS > 0 ? RAW_REMINDER_MS : 300_000;
const RAW_METRICS_MS = Number(process.env.QUEUE_METRICS_INTERVAL_MS ?? 15_000);
const QUEUE_METRICS_MS =
  Number.isFinite(RAW_METRICS_MS) && RAW_METRICS_MS > 0 ? RAW_METRICS_MS : 15_000;
const QUEUE_NAME = 'holds';

// Error tracking — a complete no-op unless SENTRY_DSN is set. Manual capture only.
const SENTRY_ENABLED = Boolean(process.env.SENTRY_DSN);
if (SENTRY_ENABLED) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    // APP_ENV before NODE_ENV: QA and UAT run NODE_ENV=production, and their worker errors were
    // filed under `production`. Same order as resolveSentryEnvironment in the API.
    environment:
      process.env.SENTRY_ENVIRONMENT?.trim() ||
      process.env.APP_ENV?.trim().toLowerCase() ||
      process.env.NODE_ENV?.trim() ||
      'development',
    // Fall back to the commit SHA the platform injects (Railway sets RAILWAY_GIT_COMMIT_SHA)
    // so worker errors are attributable to a deploy without setting a variable by hand.
    release: process.env.SENTRY_RELEASE || process.env.RAILWAY_GIT_COMMIT_SHA || undefined,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    // Drop consecutive identical errors client-side (node has no default dedupe).
    integrations: [Sentry.dedupeIntegration()],
    // Belt-and-suspenders PII scrub: strip request cookies/body/query, auth/cookie
    // headers, and any user identity from every outgoing event. Never throws.
    beforeSend(event) {
      try {
        /*
          Some API routes carry a credential in the path (webhook secrets, invitation and share
          tokens), and a URL or transaction name can ship it to Sentry. The API redacts those
          segments with redactSecretSegments; the worker cannot import it (the API package
          exports only its index), and it serves no such route and records no HTTP
          transactions -- so both are dropped outright rather than copying the route list here.
        */
        delete event.transaction;
        if (event.request) {
          delete event.request.url;
          delete event.request.cookies;
          delete event.request.data;
          delete event.request.query_string;
          const headers = event.request.headers;
          if (headers)
            for (const key of Object.keys(headers)) {
              const k = key.toLowerCase();
              if (k === 'authorization' || k === 'cookie' || k === 'set-cookie')
                delete headers[key];
            }
        }
        delete event.user;
      } catch {
        /* best-effort */
      }
      return event;
    },
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
  // Before anything else, so a refusal is logged and captured through main()'s catch below.
  const REDIS_URL = redisUrlForEnvironment();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const bookings = app.get(BookingsService);
  const bookingOrchestrator = app.get(LocalBookingOrchestrator);
  const events = app.get(EventsService);
  const prisma = app.get(PrismaService);
  const notifications = app.get(NotificationService);
  const fallbacks = app.get(NotificationFallbackService);
  const callbackReplay = app.get(ProviderEventReplayService);
  /*
    How often verified delivery callbacks that beat their message's provider reference are
    retried. The fast path applies them the moment the reference is written; this is the net
    under it, so a minute is plenty and cheap -- the query only reads rows that are waiting.
  */
  const RAW_REPLAY_MS = Number(process.env.NOTIFICATION_CALLBACK_REPLAY_INTERVAL_MS ?? 60_000);
  const CALLBACK_REPLAY_MS =
    Number.isFinite(RAW_REPLAY_MS) && RAW_REPLAY_MS > 0 ? RAW_REPLAY_MS : 60_000;
  const cancellationFanout = app.get(ShowCancellationFanoutService);
  const reminders = app.get(ShowReminderService);
  const sellability = app.get(EventSellabilitySweepService);
  const finance = app.get(FinanceReconciliationService);
  const auth = app.get(AuthService);
  const stripeWebhooks = app.get(StripeWebhookProcessor);
  const razorpayWebhooks = app.get(RazorpayWebhookProcessor);
  const settlements = app.get(SettlementService);
  const seatOverrides = app.get(SeatOverridesService);
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
  // Same guard as every other interval: a blank or mistyped value must not crash-loop the worker.
  const DAY_MS = 24 * 3600 * 1000;
  const RAW_RECONCILE_MS = Number(process.env.RECONCILE_INTERVAL_MS ?? DAY_MS);
  const RECONCILE_EVERY_MS =
    Number.isFinite(RAW_RECONCILE_MS) && RAW_RECONCILE_MS > 0 ? RAW_RECONCILE_MS : DAY_MS;
  const RAW_TOKEN_PRUNE_MS = Number(process.env.TOKEN_PRUNE_INTERVAL_MS ?? DAY_MS);
  const TOKEN_PRUNE_EVERY_MS =
    Number.isFinite(RAW_TOKEN_PRUNE_MS) && RAW_TOKEN_PRUNE_MS > 0 ? RAW_TOKEN_PRUNE_MS : DAY_MS;

  // A plain options object avoids a type clash between our ioredis and the one
  // bundled inside bullmq. Parsed from the full REDIS_URL (credentials, db index and TLS
  // included) via the same helper the API's queue producers use, so both sides address the
  // identical managed Redis. The IORedis instance below is used only for health pings.
  const redisConnection = bullConnectionFromUrl(REDIS_URL);
  const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  // Env-scoped BullMQ prefix (P6.2): MUST match the API producers' prefix so staging/production
  // never share a queue keyspace on a shared Redis. Both derive it from APP_ENV.
  const BULL_PREFIX = bullPrefix(process.env.APP_ENV);
  const queue = new Queue(QUEUE_NAME, { connection: redisConnection, prefix: BULL_PREFIX });

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

  // Repeatable sweep that delivers due notifications. Idempotent: dispatchDue only acts on
  // rows still PENDING/SCHEDULED and past their scheduledFor.
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

  // Cross-channel fallback: a cancelled show whose preferred channels produced nothing gets
  // an SMS, once, after the wait its policy declares. Idempotent -- the fallback is created
  // through the ordinary send path and its intent key makes a second sweep a no-op.
  await queue.add(
    'notification-fallbacks',
    {},
    {
      repeat: { every: FALLBACK_SWEEP_MS },
      jobId: 'notification-fallbacks',
      removeOnComplete: 50,
      removeOnFail: 50,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
    },
  );

  // Delivery callbacks that arrived before their message was recorded: applied, or
  // dead-lettered once the correlation window has passed. Idempotent -- each row is claimed
  // with a conditional update and delivery state only ever moves forward.
  await queue.add(
    'notification-callback-replay',
    {},
    {
      repeat: { every: CALLBACK_REPLAY_MS },
      jobId: 'notification-callback-replay',
      removeOnComplete: 50,
      removeOnFail: 50,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
    },
  );

  /*
    Tells the remaining ticket holders about a cancelled show.

    The domain-event handler starts the fan-out the moment a show is cancelled, so this is
    not the fast path -- it is the GUARANTEE. It asks the data who still has no cancellation
    notice, which means it recovers on its own from a failed handler, a disabled outbox or a
    process that died mid-batch, and it needs no cursor to do it.
  */
  await queue.add(
    'notification-cancellation-fanout',
    {},
    {
      repeat: { every: CANCELLATION_SWEEP_MS },
      jobId: 'notification-cancellation-fanout',
      removeOnComplete: 50,
      removeOnFail: 50,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
    },
  );

  /*
    Published events that nobody can buy from.

    The publish gate refuses an unsellable event, so anything this finds became unsellable
    AFTERWARDS -- a price edited above a ceiling, a room reassigned, a rate order taking
    effect. The listing stays up and the checkout refuses, and nothing about that situation
    produces a signal on its own: the first person to notice is a customer.
  */
  await queue.add(
    'event-sellability-sweep',
    {},
    {
      repeat: { every: SELLABILITY_SWEEP_MS },
      jobId: 'event-sellability-sweep',
      removeOnComplete: 50,
      removeOnFail: 50,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
    },
  );

  // Show reminders. OFF unless NOTIFICATION_REMINDERS_ENABLED -- turning it on starts
  // messaging every ticket holder about every future show, which is a product launch.
  await queue.add(
    'notification-reminders',
    {},
    {
      repeat: { every: REMINDER_SWEEP_MS },
      jobId: 'notification-reminders',
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
      if (job.name === 'event-sellability-sweep') {
        const summary = await sellability.sweep();
        // Logged only when something is actually wrong. An hourly "0 unsellable" line is
        // noise that makes the hour something IS wrong harder to spot.
        if (summary.unsellable > 0) {
          log('warn', 'published events that cannot be sold', { ...summary });
        }
        return summary;
      }
      if (job.name === 'notification-cancellation-fanout') {
        const summary = await cancellationFanout.sweep();
        if (summary.notified > 0) log('info', 'show cancellation fanout', { ...summary });
        return summary;
      }
      if (job.name === 'notification-reminders') {
        /*
          The tolerance must be at least as wide as the interval between ticks, or a show
          whose exact reminder moment fell between two runs is never reminded about at all.
          Generous is safe: a show caught twice still produces one message, because the
          dedupe key decides that in the database.
        */
        const summary = await reminders.runDue(new Date(), {
          toleranceMinutes: Math.max(30, Math.ceil(REMINDER_SWEEP_MS / 60_000) * 2),
        });
        if (summary.reminded > 0) log('info', 'sent show reminders', { ...summary });
        return summary;
      }
      if (job.name === 'notification-fallbacks') {
        /*
          Opens a paid channel only where the free ones produced nothing after the wait the
          event declares. It runs on its own, slower schedule because it is asking a question
          about time having passed -- checking every five seconds would answer "no" several
          hundred times for every time it answers "yes".
        */
        const summary = await fallbacks.runDue();
        if (summary.opened > 0) log('info', 'opened notification fallbacks', { ...summary });
        return summary;
      }
      if (job.name === 'notification-callback-replay') {
        const summary = await callbackReplay.sweep();
        if (summary.applied + summary.deadLettered > 0) {
          log('info', 'replayed delivery callbacks', { ...summary });
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
      // ADR-042 §4/§19 (P5.2B): AFTER the authoritative PostgreSQL release, reconcile any
      // booking workflows to EXPIRED (active mode only; idempotent; never re-releases
      // inventory, never expires a confirmed booking). Isolated so a workflow lag never
      // undoes the release.
      try {
        const swept = await bookingOrchestrator.sweepExpiredWorkflows();
        if (swept.expired > 0) log('info', 'expired booking workflows', swept);
      } catch (err) {
        log('warn', 'workflow expiry sweep failed (reconcilable)', {
          error: (err as Error).message,
        });
      }
      /*
        Lapsed seat overrides ride the SAME tick as hold expiry, deliberately.

        It is the identical operational question — "what deadline has passed" — at the
        identical cadence, and a second repeatable job would mean another queue key, another
        retry policy and another thing to notice is broken. Isolated in its own try/catch so
        a sweep failure can never undo the hold release above, exactly like the workflow
        sweep. Bounded per tick; a large backlog drains over successive ticks rather than
        stalling bookings behind one long UPDATE.
      */
      let overridesReleased = 0;
      try {
        const swept = await seatOverrides.expireLapsedOverrides();
        overridesReleased = swept.released;
        if (swept.released > 0) {
          log('info', 'released expired seat overrides', {
            released: swept.released,
            backlogRemaining: swept.more,
          });
        }
      } catch (err) {
        log('warn', 'seat override expiry sweep failed (retried next tick)', {
          error: (err as Error).message,
        });
      }

      const completed = await events.completePastEvents();
      if (completed > 0) log('info', 'completed past events', { completed });
      // Promote settlements whose event has just completed to ELIGIBLE (awaiting approval).
      const { promoted } = await settlements.promoteCompletedEvents();
      if (promoted > 0) log('info', 'promoted settlements to eligible', { promoted });
      return { released, overridesReleased, completed, promoted };
    },
    { connection: redisConnection, prefix: BULL_PREFIX },
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
    { connection: redisConnection, prefix: BULL_PREFIX, concurrency: 8 },
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
      /*
        The worker owns the queue, so it exposes queue metrics itself; Prometheus scrapes
        both API (:4000/api/metrics) and worker (:4100/metrics).

        Same scrape token as the API, decided by the same function, because two
        implementations of one access rule drift and the half that drifts is the half
        nobody is looking at. The worker has no public Railway domain today — this is here
        so that giving it one later is not silently the moment queue metrics go public.
      */
      const decision = metricsAccess({
        token: process.env.METRICS_TOKEN,
        authorization: req.headers.authorization,
        appEnv: process.env.APP_ENV,
      });
      if (decision !== 'allow') {
        const status = decision === 'disabled' ? 404 : 401;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: status === 404 ? 'Not found' : 'Unauthorized' }));
        return;
      }
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
  // Bind 0.0.0.0 explicitly, for the same reason the API does: the platform health check
  // reaches the container from outside its network namespace.
  health.listen(WORKER_PORT, '0.0.0.0', () =>
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
