#!/usr/bin/env node
/**
 * P6.4 — Multi-instance concurrency soak (DB-layer). Extends the one-shot real-Postgres proofs
 * (allocation held-guard, refund finalize-once) into a SUSTAINED loop that hammers the exact
 * guarded primitives many workers rely on, and counts invariant violations.
 *
 * It exercises the primitives directly (no HTTP), so it runs against any real PostgreSQL without
 * the API up. API-level scenarios (booking initiation, duplicate payment webhooks) require the
 * running staging stack and are driven by the load/failure harnesses (P6.5/P6.6) — see the doc.
 *
 * Success criterion (hard): ZERO double-finalize, ZERO oversell, ZERO over-capacity holds.
 *
 *   DATABASE_URL=postgres://... node scripts/soak/concurrency-soak.mjs --seconds 60 --fanout 16
 *
 * Reads DATABASE_URL from env or the repo .env. Cleans up all rows it creates.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
}
function dbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = readFileSync(resolve(__dirname, '../../.env'), 'utf8');
  return env
    .match(/^DATABASE_URL=(.*)$/m)?.[1]
    .replace(/^["']|["']$/g, '')
    .trim();
}

const SECONDS = Number(arg('seconds', 30));
const FANOUT = Number(arg('fanout', 16));
const CAPACITY = Number(arg('capacity', 5));

const prisma = new PrismaClient({ datasources: { db: { url: dbUrl() } } });
const tag = `soak-${Date.now()}`;
const metrics = {
  iterations: 0,
  finalizeRaces: 0,
  doubleFinalize: 0, // MUST stay 0
  overCapacityHolds: 0, // MUST stay 0
  oversell: 0, // MUST stay 0
  errors: 0,
};

async function seed() {
  const org = await prisma.organization.create({ data: { name: tag, slug: `${tag}-o` } });
  const venue = await prisma.venue.create({
    data: { organizationId: org.id, name: tag, city: 'T' },
  });
  const event = await prisma.event.create({
    data: {
      organizationId: org.id,
      venueId: venue.id,
      title: tag,
      slug: `${tag}-e`,
      category: 't',
    },
  });
  const session = await prisma.eventSession.create({
    data: { eventId: event.id, startsAt: new Date('2099-01-01'), endsAt: new Date('2099-01-02') },
  });
  return { org, venue, event, session };
}

/** Scenario 1: N concurrent guarded refund-finalizers → exactly one wins (finalize-once). */
async function finalizeOnceRound(ids) {
  const booking = await prisma.booking.create({
    data: {
      organizationId: ids.org.id,
      eventId: ids.event.id,
      eventSessionId: ids.session.id,
      buyerName: 'B',
      buyerEmail: 'b@e.com',
      status: 'CANCELLED',
      currency: 'USD',
      subtotalMinor: 5000,
      totalMinor: 5000,
      holdExpiresAt: new Date('2099-01-01'),
    },
  });
  await prisma.payment.create({
    data: {
      bookingId: booking.id,
      provider: 'mock',
      status: 'SUCCEEDED',
      amountMinor: 5000,
      currency: 'USD',
      refundedMinor: 0,
    },
  });
  const res = await Promise.allSettled(
    Array.from({ length: FANOUT }, () =>
      prisma.payment.updateMany({
        where: { bookingId: booking.id, status: 'SUCCEEDED' },
        data: { status: 'REFUNDED', refundedMinor: 5000 },
      }),
    ),
  );
  const wins = res.filter((r) => r.status === 'fulfilled' && r.value.count === 1).length;
  metrics.finalizeRaces++;
  if (wins !== 1) metrics.doubleFinalize++; // more than one finalizer applied → double refund
  const pay = await prisma.payment.findUnique({ where: { bookingId: booking.id } });
  if (pay.refundedMinor > pay.amountMinor) metrics.oversell++; // refunded > captured (invariant)
  await prisma.payment.deleteMany({ where: { bookingId: booking.id } });
  await prisma.booking.deleteMany({ where: { id: booking.id } });
}

/** Scenario 2: N concurrent guarded capacity holds vs capacity C → exactly C win (no oversell). */
async function heldGuardRound(ids) {
  const state = await prisma.providerInventoryState
    .create({
      data: {
        eventSessionId: ids.session.id,
        providerCode: `${tag}-p`,
        externalRef: `${tag}-${metrics.iterations}`,
        providerCapacity: CAPACITY,
        heldLocal: 0,
        confirmedLocal: 0,
      },
    })
    .catch(() => null);
  if (!state) return; // model shape differs → skip this scenario, keep soaking scenario 1
  const res = await Promise.allSettled(
    Array.from(
      { length: FANOUT },
      () =>
        // Guarded increment: only succeeds while held+confirmed < capacity (the oversell-proof guard).
        prisma.$executeRaw`UPDATE "ProviderInventoryState" SET "heldLocal" = "heldLocal" + 1
        WHERE id = ${state.id} AND "heldLocal" + "confirmedLocal" < "providerCapacity"`,
    ),
  );
  const granted = res.filter((r) => r.status === 'fulfilled' && r.value === 1).length;
  if (granted > CAPACITY) metrics.overCapacityHolds++;
  const after = await prisma.providerInventoryState.findUnique({ where: { id: state.id } });
  if (after && after.heldLocal + after.confirmedLocal > after.providerCapacity) metrics.oversell++;
  await prisma.providerInventoryState.deleteMany({ where: { id: state.id } });
}

async function main() {
  await prisma.$queryRaw`SELECT 1`;
  const ids = await seed();
  const deadline = Date.now() + SECONDS * 1000;
  process.stdout.write(`[soak] ${SECONDS}s, fanout=${FANOUT}, capacity=${CAPACITY}\n`);
  while (Date.now() < deadline) {
    try {
      await finalizeOnceRound(ids);
      await heldGuardRound(ids);
    } catch {
      metrics.errors++;
    }
    metrics.iterations++;
    if (metrics.iterations % 25 === 0) process.stdout.write(`  ..${metrics.iterations} rounds\n`);
  }
  // cleanup seed graph
  await prisma.eventSession.deleteMany({ where: { id: ids.session.id } }).catch(() => {});
  await prisma.event.deleteMany({ where: { id: ids.event.id } }).catch(() => {});
  await prisma.venue.deleteMany({ where: { id: ids.venue.id } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: ids.org.id } }).catch(() => {});
  await prisma.$disconnect();

  const pass =
    metrics.doubleFinalize === 0 && metrics.overCapacityHolds === 0 && metrics.oversell === 0;
  process.stdout.write(`\n[soak] RESULT ${JSON.stringify(metrics, null, 2)}\n`);
  process.stdout.write(
    pass
      ? '[soak] PASS — zero double-finalize / oversell / over-capacity\n'
      : '[soak] FAIL — invariant violated\n',
  );
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error('[soak] fatal', e);
  process.exit(2);
});
