#!/usr/bin/env node
/**
 * Redis / BullMQ deployment-contract validation against a PASSWORD-PROTECTED Redis.
 *
 * This is the test that would have caught the defect this branch fixes. Three call sites
 * built their BullMQ connection from `new URL(REDIS_URL)` keeping only host and port,
 * silently discarding the username, password, database index, and TLS scheme. Against a
 * passwordless local Redis that is invisible — everything passes. Against any managed
 * Redis (Railway, ElastiCache, Upstash) every queue dies with NOAUTH while the API's own
 * ioredis client, which receives the whole URL, connects perfectly — so it presents as a
 * worker bug rather than a configuration one.
 *
 * So the first assertion here is deliberately inverted: it reconstructs the OLD parsing
 * and requires it to FAIL. A test that only proves the new code works would still pass if
 * someone reverted the fix against a passwordless Redis.
 *
 * Covers: credential/db/TLS parsing, BullMQ authentication, enqueue+consume on the real
 * `holds` queue, repeatable jobs, delayed jobs, restart-without-job-loss, and the
 * QA-versus-UAT namespace isolation that keeps one environment from eating another's work.
 *
 * Usage:
 *   REDIS_URL="redis://:val-redis-pw@127.0.0.1:56379" \
 *     node scripts/deploy/validate-redis-bullmq.mjs
 *
 * Requires the stack in deploy/railway/validation/docker-compose.qa-validate.yml (or any
 * Redis that genuinely requires a password). Exit 0 = all checks pass.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

// Imported from the COMPILED API so the harness exercises the exact code the container
// runs, not a re-implementation. That means the API must be built first — fail with a
// usable instruction rather than an opaque ERR_MODULE_NOT_FOUND.
const HELPER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../apps/api/dist/common/redis-namespace.js',
);
if (!existsSync(HELPER)) {
  console.error(
    `\nCannot find the compiled helper at:\n  ${HELPER}\n\n` +
      'Build the API first:\n  npm run packages:build && npm run db:generate && npx turbo run build --filter=@eticketsgo/api\n',
  );
  process.exit(1);
}
// pathToFileURL, not the bare path: a dynamic import of an absolute Windows path
// ("C:\...") is rejected with ERR_UNSUPPORTED_ESM_URL_SCHEME.
const { bullConnectionFromUrl, bullPrefix } = await import(pathToFileURL(HELPER).href);

const REDIS_URL = process.env.REDIS_URL ?? 'redis://:val-redis-pw@127.0.0.1:56379';
const QUEUE_NAME = 'holds';
const results = [];
let failed = 0;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for `predicate()` to become truthy, or throw after `timeoutMs`. */
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  console.log(`\nRedis/BullMQ validation against ${REDIS_URL.replace(/:[^:@/]*@/, ':***@')}\n`);

  // ── 1. The regression guard: the OLD parsing must fail against this Redis ──────────
  console.log('1. Credential parsing');
  {
    const url = new URL(REDIS_URL);
    const legacy = new IORedis({
      host: url.hostname,
      port: Number(url.port) || 6379,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    let legacyFailed = false;
    let reason = '';
    try {
      await legacy.connect();
      await legacy.ping();
    } catch (err) {
      legacyFailed = true;
      reason = String(err.message).split('\n')[0];
    }
    legacy.disconnect();
    record(
      'host+port-only parsing (the old code) is REJECTED by an authenticated Redis',
      legacyFailed,
      legacyFailed
        ? reason
        : 'it connected — this Redis does NOT require a password, so this run cannot detect the regression',
    );
  }

  // ── 2. The fix: full-URL parsing authenticates ────────────────────────────────────
  const conn = bullConnectionFromUrl(REDIS_URL);
  record(
    'bullConnectionFromUrl preserves the password',
    Boolean(conn.password),
    `host=${conn.host} port=${conn.port} username=${conn.username ?? '(none)'} password=${conn.password ? '(present)' : '(MISSING)'} db=${conn.db ?? '(default)'} tls=${conn.tls ? 'on' : 'off'}`,
  );
  {
    const client = new IORedis({ ...conn, lazyConnect: true });
    let ok = false;
    let detail = '';
    try {
      await client.connect();
      ok = (await client.ping()) === 'PONG';
    } catch (err) {
      detail = String(err.message).split('\n')[0];
    }
    client.disconnect();
    record('a client built from those options authenticates', ok, detail || 'PONG');
  }

  // TLS + db-index parsing are pure-function properties; assert them without needing a
  // TLS-enabled server, which is not practical to stand up locally.
  {
    const tlsConn = bullConnectionFromUrl('rediss://user:pw@example.com:6380/4');
    record(
      'rediss:// enables TLS and /4 selects the database',
      tlsConn.tls !== undefined && tlsConn.db === 4 && tlsConn.username === 'user',
      `tls=${JSON.stringify(tlsConn.tls)} db=${tlsConn.db} username=${tlsConn.username}`,
    );
  }

  // ── 3. BullMQ over the authenticated connection, on the QA namespace ──────────────
  console.log('\n2. BullMQ connectivity and namespacing');
  const qaPrefix = bullPrefix('QA');
  record('QA BullMQ prefix is environment-scoped', qaPrefix === 'etg:qa:bull', qaPrefix);

  const queue = new Queue(QUEUE_NAME, { connection: conn, prefix: qaPrefix });
  await queue.waitUntilReady();
  record('BullMQ Queue authenticates and is ready', true, `${qaPrefix}:${QUEUE_NAME}`);

  // ── 4. Enqueue and consume ────────────────────────────────────────────────────────
  console.log('\n3. Job round-trip');
  const processed = [];
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      processed.push(job.name);
      return { handled: job.name };
    },
    { connection: conn, prefix: qaPrefix },
  );
  await worker.waitUntilReady();

  await queue.add('validate-roundtrip', { probe: true }, { removeOnComplete: false });
  await waitFor(() => processed.includes('validate-roundtrip'), 15000, 'round-trip job');
  record('a job enqueued by the producer is consumed by the worker', true, 'validate-roundtrip');

  // ── 5. Delayed jobs ───────────────────────────────────────────────────────────────
  const delayStart = Date.now();
  await queue.add('validate-delayed', {}, { delay: 1500, removeOnComplete: false });
  const delayedCount = await queue.getDelayedCount();
  record('a delayed job is held in the delayed set', delayedCount >= 1, `delayed=${delayedCount}`);
  await waitFor(() => processed.includes('validate-delayed'), 20000, 'delayed job');
  const waited = Date.now() - delayStart;
  record('the delayed job fires only after its delay', waited >= 1400, `fired after ${waited}ms`);

  // ── 6. Repeatable jobs (how the real schedule is expressed) ───────────────────────
  await queue.add(
    'validate-repeatable',
    {},
    { repeat: { every: 1200 }, jobId: 'validate-repeatable' },
  );
  const schedulers = await queue.getJobSchedulers().catch(() => null);
  const repeatables = schedulers ?? (await queue.getRepeatableJobs().catch(() => []));
  record(
    'a repeatable job registers a schedule',
    Array.isArray(repeatables) && repeatables.length >= 1,
    `${Array.isArray(repeatables) ? repeatables.length : 0} schedule(s)`,
  );
  const beforeRepeat = processed.filter((n) => n === 'validate-repeatable').length;
  await waitFor(
    () => processed.filter((n) => n === 'validate-repeatable').length > beforeRepeat + 1,
    20000,
    'repeatable job to fire twice',
  );
  record(
    'the repeatable job fires on its interval',
    true,
    `${processed.filter((n) => n === 'validate-repeatable').length} executions`,
  );

  // ── 7. Environment isolation: a UAT-namespaced consumer must not see QA work ──────
  // On Railway the instances are separate, so this proves the namespace is genuine
  // defence-in-depth rather than the isolation resting on the instance boundary alone.
  console.log('\n4. Cross-environment isolation (same Redis, different APP_ENV)');
  const uatPrefix = bullPrefix('UAT');
  record('UAT prefix differs from QA', uatPrefix !== qaPrefix, `${qaPrefix} vs ${uatPrefix}`);

  const uatSeen = [];
  const uatWorker = new Worker(
    QUEUE_NAME,
    async (job) => {
      uatSeen.push(job.name);
    },
    { connection: conn, prefix: uatPrefix },
  );
  await uatWorker.waitUntilReady();

  // Pause the QA worker so the QA job sits claimable. If the namespaces leaked, the idle
  // UAT worker is the only consumer running and would pick it up.
  await worker.pause();
  await queue.add('qa-only-job', { secret: 'qa' }, { removeOnComplete: false });
  await sleep(4000);
  record(
    'a UAT-namespaced worker CANNOT consume a QA job',
    !uatSeen.includes('qa-only-job'),
    uatSeen.length ? `UAT consumed: ${uatSeen.join(', ')}` : 'UAT consumed nothing (correct)',
  );

  // ── 8. Restart with jobs queued — nothing is lost ─────────────────────────────────
  console.log('\n5. Worker restart with pending jobs');
  const waitingBefore = await queue.getWaitingCount();
  record('a job is waiting while the consumer is down', waitingBefore >= 1, `waiting=${waitingBefore}`);

  await worker.close(); // simulate the worker being redeployed/restarted
  await sleep(500);
  const waitingAfterClose = await queue.getWaitingCount();
  record(
    'the job survives the worker shutdown (durable in Redis)',
    waitingAfterClose >= 1,
    `waiting=${waitingAfterClose}`,
  );

  const restarted = [];
  const worker2 = new Worker(
    QUEUE_NAME,
    async (job) => {
      restarted.push(job.name);
    },
    { connection: conn, prefix: qaPrefix },
  );
  await worker2.waitUntilReady();
  await waitFor(() => restarted.includes('qa-only-job'), 20000, 'restarted worker to drain backlog');
  record('the restarted worker picks the job up — no loss', true, 'qa-only-job processed after restart');

  // ── 9. Keyspace inspection: everything QA wrote is under the QA root ──────────────
  console.log('\n6. Keyspace inspection');
  {
    const client = new IORedis({ ...conn, lazyConnect: true });
    await client.connect();
    const keys = [];
    let cursor = '0';
    do {
      const [next, batch] = await client.scan(cursor, 'MATCH', 'etg:*', 'COUNT', 500);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    const qaKeys = keys.filter((k) => k.startsWith('etg:qa:'));
    const foreign = keys.filter((k) => !k.startsWith('etg:qa:') && !k.startsWith('etg:uat:'));
    record('QA wrote keys under etg:qa:*', qaKeys.length > 0, `${qaKeys.length} key(s)`);
    record(
      'no key was written outside a recognised environment namespace',
      foreign.length === 0,
      foreign.length ? `stray: ${foreign.slice(0, 5).join(', ')}` : 'none',
    );
    client.disconnect();
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────────────
  await uatWorker.close();
  await worker2.close();
  await queue.obliterate({ force: true }).catch(() => undefined);
  await queue.close();

  console.log(
    `\n${failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`} — ${results.length} assertions\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nvalidation harness error: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
