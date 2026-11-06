#!/usr/bin/env node
/**
 * Two-replica drill for the API: load, failover, shared rate limit, concurrent webhook.
 *
 * READ THIS FIRST. It sends load and fake (signed only if you give a secret) webhooks to the
 * URLs you name. Point it at LOCAL containers or at QA only with approval. It never targets
 * production by itself, and refuses a URL containing "eticketsgo.com" unless
 * ALLOW_PUBLIC_HOST=yes. It writes nothing except the rows the API itself creates
 * (WebhookEvent rows for the fake event id, failed-login audit rows).
 *
 *   REPLICA_URLS=http://localhost:4301,http://localhost:4302 \
 *   STOP_CMD="docker stop -t 30 etg-ha-api-a" \
 *   WEBHOOK_SECRET=<the replicas' RAZORPAY_WEBHOOK_SECRET>   # optional
 *   node scripts/ha/two-replica-drill.mjs
 *
 * What it does, in order:
 *  1. Both replicas answer /api/ready (Postgres + Redis reachable from each).
 *  2. Shared rate limit: 30 failed logins from ONE client address, alternating replicas.
 *     A limit held per process lets ~2x the limit through; a shared (Redis) one lets the
 *     limit through once.
 *  3. Concurrent duplicate webhook (if WEBHOOK_SECRET): one signed Razorpay event sent 16 times
 *     at once, half to each replica. Every copy must be answered 2xx.
 *  4. Load + failover: CONCURRENCY clients for DURATION seconds through a local proxy that
 *     behaves like a health-checking load balancer: it polls each replica's /api/health every
 *     500 ms, routes round-robin to the healthy ones, and retries an idempotent GET ONCE on
 *     another replica when the first fails. Every client request carries a different client
 *     address (a crowd, not one IP), so the per-client rate limit does not dominate.
 *     At STOP_AT seconds it runs STOP_CMD (a graceful SIGTERM of replica A). Reports status
 *     counts and latency before, during and after the stop, and how many requests were
 *     retried (those reached a stopping replica and were saved by the balancer, not the API).
 *
 * Output: a JSON report on stdout. Exit 1 if any check fails.
 */
import http from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { exec } from 'node:child_process';

const urls = (process.env.REPLICA_URLS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (urls.length < 2) {
  console.error('REPLICA_URLS must name at least two replicas.');
  process.exit(2);
}
if (urls.some((u) => /eticketsgo\.com/i.test(u)) && process.env.ALLOW_PUBLIC_HOST !== 'yes') {
  console.error('Refusing a public eticketsgo.com host. This drill is for local or QA replicas.');
  process.exit(2);
}
const DURATION = Number(process.env.DURATION ?? 40);
const STOP_AT = Number(process.env.STOP_AT ?? 15);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 16);
const STOP_CMD = process.env.STOP_CMD ?? '';
const SECRET = process.env.WEBHOOK_SECRET ?? '';
const LOAD_PATH = process.env.LOAD_PATH ?? '/api/events?limit=5';
const report = { replicas: urls, checks: {}, ok: true };
const fail = (name, why) => {
  report.ok = false;
  report.checks[name] = { ...(report.checks[name] ?? {}), pass: false, why };
};

const crowdIp = () =>
  `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;

async function req(base, path, init = {}) {
  const t0 = performance.now();
  try {
    const res = await fetch(base + path, { ...init, signal: AbortSignal.timeout(15_000) });
    await res.arrayBuffer();
    return { status: res.status, ms: performance.now() - t0 };
  } catch (err) {
    return { status: 0, ms: performance.now() - t0, error: String(err?.cause?.code ?? err) };
  }
}

// 1. readiness
{
  const out = [];
  for (const u of urls) out.push({ url: u, ...(await req(u, '/api/ready')) });
  report.checks.ready = { pass: out.every((r) => r.status === 200), replicas: out };
  if (!report.checks.ready.pass) fail('ready', 'a replica is not ready');
}

// 2. shared rate limit
{
  const ip = `198.51.100.${Math.floor(Math.random() * 200) + 20}`;
  const statuses = [];
  for (let i = 0; i < 30; i++) {
    const r = await req(urls[i % urls.length], '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({
        email: `ha-drill-${i}@example.invalid`,
        password: 'wrong-password-1',
      }),
    });
    statuses.push(r.status);
  }
  const limited = statuses.filter((s) => s === 429).length;
  const allowed = statuses.length - limited;
  const limit = Number(process.env.AUTH_THROTTLE_LIMIT ?? 10);
  report.checks.sharedThrottle = {
    pass: allowed <= limit,
    limit,
    allowed,
    limited,
    note: `per-process limits would let about ${limit * urls.length} through`,
  };
  if (allowed > limit) fail('sharedThrottle', 'more requests passed than one shared limit allows');
}

// 3. concurrent duplicate webhook
if (SECRET) {
  const eventId = `evt_ha_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  const body = JSON.stringify({
    event: 'payment.failed',
    created_at: Math.floor(Date.now() / 1000),
    account_id: 'acc_ha_drill',
    payload: { payment: { entity: { id: `pay_${eventId}`, order_id: `order_${eventId}` } } },
  });
  const signature = createHmac('sha256', SECRET).update(body).digest('hex');
  const results = await Promise.all(
    Array.from({ length: 16 }, (_, i) =>
      req(urls[i % urls.length], '/api/payments/webhooks/razorpay', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-razorpay-signature': signature,
          'x-razorpay-event-id': eventId,
        },
        body,
      }),
    ),
  );
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const pass = results.every((r) => r.status >= 200 && r.status < 300);
  report.checks.concurrentWebhook = { pass, eventId, statuses: counts };
  if (!pass) fail('concurrentWebhook', 'a duplicate copy was not answered 2xx');
}

// 4. load + failover through a round-robin proxy with connection-refused failover
{
  const targets = urls.map((u) => ({ url: new URL(u), healthy: true }));
  let rr = 0;
  let retried = 0;
  const poll = setInterval(() => {
    for (const t of targets) {
      fetch(new URL('/api/health', t.url), { signal: AbortSignal.timeout(1000) })
        .then((r) => (t.healthy = r.ok))
        .catch(() => (t.healthy = false));
    }
  }, 500);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  const forward = (clientReq, clientRes, body, tried = []) => {
    const pool = targets.filter((t) => t.healthy && !tried.includes(t));
    const t = pool.length ? pool[rr++ % pool.length] : targets.find((x) => !tried.includes(x));
    if (!t) {
      clientRes.writeHead(502);
      clientRes.end('no upstream');
      return;
    }
    const up = http.request(
      {
        host: t.url.hostname,
        port: t.url.port,
        path: clientReq.url,
        method: clientReq.method,
        headers: clientReq.headers,
        agent,
        timeout: 10_000,
      },
      (upRes) => {
        clientRes.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(clientRes);
      },
    );
    const onFail = (code) => {
      t.healthy = false;
      // A balancer may retry an idempotent request once, on another replica.
      if (clientReq.method === 'GET' && tried.length === 0 && targets.length > 1) {
        retried++;
        forward(clientReq, clientRes, body, [t]);
      } else if (!clientRes.headersSent) {
        clientRes.writeHead(502);
        clientRes.end(String(code));
      }
    };
    up.on('timeout', () => up.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    up.on('error', (err) => onFail(err.code));
    up.end(body);
  };
  const proxy = http.createServer((cReq, cRes) => {
    const chunks = [];
    cReq.on('data', (c) => chunks.push(c));
    cReq.on('end', () => {
      rr = (rr + 1) % targets.length;
      forward(cReq, cRes, Buffer.concat(chunks));
    });
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${proxy.address().port}`;

  const phases = { before: [], during: [], after: [] };
  const start = performance.now();
  let stopRanAt = null;
  let stopDoneAt = null;
  if (STOP_CMD) {
    setTimeout(() => {
      stopRanAt = (performance.now() - start) / 1000;
      exec(STOP_CMD, (err, stdout, stderr) => {
        stopDoneAt = (performance.now() - start) / 1000;
        report.checks.failover = {
          ...(report.checks.failover ?? {}),
          stopError: err ? String(stderr || err) : null,
        };
      });
    }, STOP_AT * 1000);
  }
  const phaseOf = (t) => {
    if (stopRanAt === null || t < stopRanAt) return 'before';
    if (stopDoneAt === null || t < stopDoneAt) return 'during';
    return 'after';
  };
  const client = async () => {
    while ((performance.now() - start) / 1000 < DURATION) {
      const r = await req(base, LOAD_PATH, { headers: { 'x-forwarded-for': crowdIp() } });
      phases[phaseOf((performance.now() - start) / 1000)].push(r);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, client));
  clearInterval(poll);
  proxy.close();
  agent.destroy();

  const summary = (rows) => {
    const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
    const q = (p) =>
      ms.length ? Math.round(ms[Math.min(ms.length - 1, Math.floor(p * ms.length))]) : null;
    const statuses = {};
    for (const r of rows) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    return { requests: rows.length, statuses, p50: q(0.5), p95: q(0.95), p99: q(0.99) };
  };
  const all = [...phases.before, ...phases.during, ...phases.after];
  const errors = all.filter((r) => r.status === 0 || r.status >= 500).length;
  report.checks.failover = {
    ...(report.checks.failover ?? {}),
    pass: errors === 0,
    stopCommand: STOP_CMD || null,
    stopRanAtSec: stopRanAt,
    stopFinishedAtSec: stopDoneAt,
    errors,
    retriedOnAnotherReplica: retried,
    before: summary(phases.before),
    during: summary(phases.during),
    after: summary(phases.after),
  };
  if (errors > 0) fail('failover', `${errors} requests failed (5xx or no response)`);
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
