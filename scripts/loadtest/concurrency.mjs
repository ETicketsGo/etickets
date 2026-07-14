#!/usr/bin/env node
// @ts-nocheck
/**
 * ETicketsGo — live concurrency + throughput harness (plain Node, global fetch).
 *
 * Runs against a LIVE local API and proves the crown-jewel invariant: the atomic,
 * DB-arbitrated inventory holds cannot oversell or double-book under real
 * concurrency. Additive — does NOT touch application code and never deletes data.
 * Successful bookings are PENDING_PAYMENT holds only (never paid), so they
 * auto-release after the 10-minute hold window.
 *
 * Sections:
 *   1. Concurrent SEAT reservation  — N clients race for the SAME seat; exactly one wins.
 *   2. Concurrent GA oversell       — N clients race for a GA ticket type; wins == stock.
 *   3. API read throughput          — sequential + concurrent reads; RPS + p50/p95/p99.
 *
 * Usage:
 *   node scripts/loadtest/concurrency.mjs
 * Env overrides:
 *   API_BASE (default http://127.0.0.1:4000/api)
 *   MOVIE_SLUG (default skyfront-protocol)
 *   GA_SLUG    (default standup-night-with-zomato-comedy)
 *   SEAT_CONCURRENCY (default 25)
 *   SEAT_ROUNDS      (default 3)   distinct seats raced, one round each
 *   GA_OVERSHOOT     (default 15)  extra racers beyond remaining stock
 *   READ_SEQ (default 60)  READ_CONC (default 40)
 *   COOLDOWN_MS (default 61000)  wait between phases to reset the 120 req / 60 s
 *               per-IP global throttler so each phase runs in a fresh window.
 *
 * NOTE ON THROTTLING: the API enforces a global ThrottlerGuard of 120 req / 60 s
 * per IP (app.module.ts). This harness therefore keeps every phase's request
 * count under that budget and cools down a full window between phases, so the
 * concurrency races are arbitrated purely by the DB (409s), never masked by 429s,
 * and the read latencies reflect genuine served responses.
 */

const API_BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000/api';
const MOVIE_SLUG = process.env.MOVIE_SLUG ?? 'skyfront-protocol';
const GA_SLUG = process.env.GA_SLUG ?? 'standup-night-with-zomato-comedy';
const SEAT_CONCURRENCY = Number(process.env.SEAT_CONCURRENCY ?? 25);
const SEAT_ROUNDS = Number(process.env.SEAT_ROUNDS ?? 3);
const GA_OVERSHOOT = Number(process.env.GA_OVERSHOOT ?? 15);
const READ_SEQ = Number(process.env.READ_SEQ ?? 60);
const READ_CONC = Number(process.env.READ_CONC ?? 40);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS ?? 61_000);

const CUSTOMER = { email: 'customer1@eticketsgo.test', password: 'Password123!' };
const OWNER = { email: 'owner@eticketsgo.test', password: 'Password123!' };

// ----------------------------------------------------------------------------- helpers
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms, high-res

async function login({ email, password }) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login ${email} failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return body.accessToken;
}

async function getJson(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

async function book(token, payload) {
  const t0 = now();
  const res = await fetch(`${API_BASE}/bookings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const ms = now() - t0;
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body, ms };
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}

function stats(samplesMs) {
  const s = [...samplesMs].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    min: +s[0].toFixed(2),
    mean: +(sum / s.length).toFixed(2),
    p50: +percentile(s, 50).toFixed(2),
    p95: +percentile(s, 95).toFixed(2),
    p99: +percentile(s, 99).toFixed(2),
    max: +s[s.length - 1].toFixed(2),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function coolDown(label) {
  if (COOLDOWN_MS <= 0) return;
  console.log(`\n  …cooling down ${Math.round(COOLDOWN_MS / 1000)}s to reset the throttle window before ${label}…`);
  await sleep(COOLDOWN_MS);
}

const line = (c = '-') => console.log(c.repeat(78));
const summary = { seat: [], ga: null, reads: [], allPassed: true };
function assert(name, cond, detail) {
  const ok = Boolean(cond);
  if (!ok) summary.allPassed = false;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  return ok;
}

// ----------------------------------------------------------------------------- 1. SEAT race
async function seatRace(token, sessionId, seat, categoryTicketTypeMap, round) {
  const ticketTypeId = categoryTicketTypeMap.get(seat.categoryId);
  const payload = {
    eventSessionId: sessionId,
    items: [{ ticketTypeId, quantity: 1, seatIds: [seat.id] }],
    buyerName: 'Load Test',
    buyerEmail: CUSTOMER.email,
  };
  const racers = Array.from({ length: SEAT_CONCURRENCY }, () => payload);

  const wall0 = now();
  const results = await Promise.all(racers.map((p) => book(token, p)));
  const wallMs = now() - wall0;

  const wins = results.filter((r) => r.status === 201 && r.body?.id);
  const conflicts = results.filter(
    (r) => r.status === 409 && r.body?.code === 'BOOKING_INVENTORY_UNAVAILABLE',
  );
  const other = results.filter((r) => !wins.includes(r) && !conflicts.includes(r));
  const codes = {};
  for (const r of results) codes[r.status] = (codes[r.status] ?? 0) + 1;

  console.log(
    `\n  Round ${round}  seat=${seat.label} (${seat.id})  concurrency=${SEAT_CONCURRENCY}  wall=${wallMs.toFixed(1)}ms`,
  );
  console.log(`  status codes: ${JSON.stringify(codes)}`);
  const okWin = assert('exactly ONE booking id returned', wins.length === 1, `wins=${wins.length}`);
  const okConf = assert(
    `other ${SEAT_CONCURRENCY - 1} are 409 BOOKING_INVENTORY_UNAVAILABLE`,
    conflicts.length === SEAT_CONCURRENCY - 1,
    `conflicts=${conflicts.length}`,
  );
  const okNo5xx = assert('no 5xx / no oversell', other.length === 0, `unexpected=${other.length}`);

  summary.seat.push({
    round,
    seat: seat.label,
    concurrency: SEAT_CONCURRENCY,
    wallMs: +wallMs.toFixed(1),
    wins: wins.length,
    conflicts: conflicts.length,
    unexpected: other.length,
    latency: stats(results.map((r) => r.ms)),
    pass: okWin && okConf && okNo5xx,
  });
}

async function runSeatSection() {
  line('=');
  console.log('SECTION 1 — Concurrent SEAT reservation (oversell / double-book safety)');
  line('=');
  const token = await login(CUSTOMER);
  const movie = await getJson(`/public/movies/${MOVIE_SLUG}`);
  // Flatten all future sessions, sort by startsAt, take the last (>48h out) for refund-safety.
  const sessions = movie.shows
    .flatMap((s) => s.sessions)
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
  const session = sessions[sessions.length - 1];
  console.log(`  movie=${MOVIE_SLUG}  session=${session.id}  startsAt=${session.startsAt}`);

  const layout = await getJson(`/public/shows/${session.id}/seats`);
  const catMap = new Map(layout.categories.map((c) => [c.id, c.ticketTypeId]));
  const availableSeats = layout.sections
    .flatMap((s) => s.rows)
    .flatMap((r) => r.seats)
    .filter((seat) => seat.status === 'AVAILABLE' && catMap.get(seat.categoryId));
  console.log(`  available seats: ${availableSeats.length}`);

  const rounds = Math.min(SEAT_ROUNDS, availableSeats.length);
  for (let i = 0; i < rounds; i++) {
    await seatRace(token, session.id, availableSeats[i], catMap, i + 1);
  }
}

// ----------------------------------------------------------------------------- 2. GA oversell
async function runGaSection() {
  line('=');
  console.log('SECTION 2 — Concurrent GA oversell (quantity-counter arbitration)');
  line('=');
  const token = await login(OWNER); // any authenticated buyer works; booking is not org-scoped
  const event0 = await getJson(`/public/events/${GA_SLUG}`);
  const session0 = event0.sessions[0];
  // Target the ticket type with the SMALLEST remaining stock so the race fits the
  // throttle budget and is cheap. (Also whichever has stock ≤ ~100 to fit a window.)
  const targetName = [...session0.ticketTypes].sort((a, b) => a.available - b.available)[0].name;

  // Primer booking: a single qty-1 create triggers the service's lazy
  // releaseExpiredHolds() for this session, flushing any expired holds from a
  // prior run so the availability we read next is exact and the race is
  // deterministic (no release racing inside the burst). It is a normal hold and
  // auto-expires. If nothing was expired it simply consumes one unit.
  const primerTt0 = session0.ticketTypes.find((t) => t.name === targetName);
  const primer = await book(token, {
    eventSessionId: session0.id,
    items: [{ ticketTypeId: primerTt0.id, quantity: 1 }],
    buyerName: 'Load Test Primer',
    buyerEmail: OWNER.email,
  });
  console.log(`  primer booking (flush expired holds): status=${primer.status}`);

  // Re-read availability AFTER the primer so it reflects released stock.
  const event = await getJson(`/public/events/${GA_SLUG}`);
  const session = event.sessions[0];
  const tt = session.ticketTypes.find((t) => t.name === targetName);
  const stock = tt.available;
  console.log(`  event=${GA_SLUG}  session=${session.id}`);
  console.log(`  target ticketType=${tt.name} (${tt.id})  remaining stock=${stock}`);

  if (stock <= 0) {
    console.log('  stock is 0 — cannot run a meaningful race. Skipping (documented).');
    summary.ga = { skipped: true, reason: 'no remaining stock' };
    return;
  }
  const racers = stock + GA_OVERSHOOT;
  const payload = {
    eventSessionId: session.id,
    items: [{ ticketTypeId: tt.id, quantity: 1 }],
    buyerName: 'Load Test',
    buyerEmail: OWNER.email,
  };
  console.log(`  firing ${racers} concurrent quantity-1 bookings (stock ${stock} + ${GA_OVERSHOOT} overshoot)`);

  const wall0 = now();
  const results = await Promise.all(
    Array.from({ length: racers }, () => book(token, payload)),
  );
  const wallMs = now() - wall0;

  const wins = results.filter((r) => r.status === 201 && r.body?.id);
  const conflicts = results.filter(
    (r) => r.status === 409 && r.body?.code === 'BOOKING_INVENTORY_UNAVAILABLE',
  );
  const other = results.filter((r) => !wins.includes(r) && !conflicts.includes(r));
  const codes = {};
  for (const r of results) codes[r.status] = (codes[r.status] ?? 0) + 1;

  console.log(`  wall=${wallMs.toFixed(1)}ms  status codes: ${JSON.stringify(codes)}`);
  const okWins = assert(
    'confirmed holds == remaining stock (never more)',
    wins.length === stock,
    `wins=${wins.length} stock=${stock}`,
  );
  const okConf = assert(
    'overshoot bookings rejected 409 BOOKING_INVENTORY_UNAVAILABLE',
    conflicts.length === racers - stock,
    `conflicts=${conflicts.length} expected=${racers - stock}`,
  );
  const okNo5xx = assert('no 5xx / no oversell', other.length === 0, `unexpected=${other.length}`);

  summary.ga = {
    ticketType: tt.name,
    stock,
    racers,
    wins: wins.length,
    conflicts: conflicts.length,
    unexpected: other.length,
    wallMs: +wallMs.toFixed(1),
    latency: stats(results.map((r) => r.ms)),
    pass: okWins && okConf && okNo5xx,
  };
}

// ----------------------------------------------------------------------------- 3. read throughput
async function timedGet(path) {
  const t0 = now();
  const res = await fetch(`${API_BASE}${path}`);
  await res.text();
  return { ms: now() - t0, status: res.status, ok: res.ok };
}

async function measureReads(label, path, seqN, concN) {
  // Sequential pass (warms cache; measures steady-state single-client latency).
  const seq = [];
  for (let i = 0; i < seqN; i++) seq.push(await timedGet(path));
  // Concurrent burst (measures throughput under parallel load).
  const cWall0 = now();
  const conc = await Promise.all(Array.from({ length: concN }, () => timedGet(path)));
  const cWall = now() - cWall0;

  const seqOk = seq.filter((r) => r.ok);
  const concOk = conc.filter((r) => r.ok);
  const throttled = [...seq, ...conc].filter((r) => r.status === 429).length;
  // RPS measured only over successfully served concurrent responses.
  const rps = (concOk.length / cWall) * 1000;

  console.log(`\n  ${label}  (${path})`);
  console.log(
    `  sequential x${seqN} (2xx=${seqOk.length}): ${JSON.stringify(stats(seqOk.map((r) => r.ms)))}`,
  );
  console.log(
    `  concurrent x${concN} (2xx=${concOk.length}): ${JSON.stringify(stats(concOk.map((r) => r.ms)))}  wall=${cWall.toFixed(1)}ms  ~${rps.toFixed(0)} served req/s`,
  );
  if (throttled) console.log(`  (throttled 429s this phase: ${throttled})`);

  const rec = {
    label,
    path,
    sequential: stats(seqOk.map((r) => r.ms)),
    concurrent: stats(concOk.map((r) => r.ms)),
    concurrentWallMs: +cWall.toFixed(1),
    approxServedRps: +rps.toFixed(0),
    served2xx: seqOk.length + concOk.length,
    throttled429: throttled,
  };
  summary.reads.push(rec);
  assert(`${label}: all responses served 2xx (no throttling)`, throttled === 0, `429s=${throttled}`);
}

async function runReadSection() {
  line('=');
  console.log('SECTION 3 — API read throughput (cached discovery + movie catalog)');
  line('=');
  await measureReads('discovery (cached)', '/public/discovery', READ_SEQ, READ_CONC);
  await coolDown('movie-catalog read measurement');
  await measureReads('movies catalog (cached)', '/public/movies', READ_SEQ, READ_CONC);
}

// ----------------------------------------------------------------------------- main
async function main() {
  console.log(`ETicketsGo concurrency harness — ${new Date().toISOString()}`);
  console.log(`API_BASE=${API_BASE}\n`);

  const health = await fetch(`${API_BASE}/health`).then((r) => r.status).catch(() => 0);
  if (health !== 200) throw new Error(`API health check failed (status ${health}) at ${API_BASE}`);

  // Start each phase in a fresh throttle window (a prior run/probe may have
  // consumed the current 120 req / 60 s budget).
  await coolDown('the seat-reservation race');
  await runSeatSection();
  await coolDown('the GA oversell race');
  await runGaSection();
  await coolDown('the read-throughput measurement');
  await runReadSection();

  line('=');
  console.log('JSON SUMMARY');
  line('=');
  console.log(JSON.stringify(summary, null, 2));

  line('=');
  console.log(`OVERALL: ${summary.allPassed ? 'PASS ✅' : 'FAIL ❌'}`);
  line('=');
  process.exit(summary.allPassed ? 0 : 1);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e);
  process.exit(2);
});
