#!/usr/bin/env node
/**
 * Pilot health check: one command that turns GET /api/admin/ops/health into an exit code.
 *
 * Why: the platform's most expensive silent failures (no backup for five days, a queue failing
 * quietly) all looked like green deployments. This reads the health the API already computes -
 * database, redis, queue, and the age of the newest VERIFIED backup - and exits non-zero when
 * any of them is failing, so cron, a CI job or a person at a terminal gets the same answer.
 *
 *   API_URL=https://<api-host>/api ADMIN_TOKEN=<bearer of an admin with OPS_READ> \
 *     node scripts/ops/pilot-health-check.mjs
 *   node scripts/ops/pilot-health-check.mjs --file health.json    (offline, for tests)
 *
 * Read-only. Never prints the token or any response field other than status names and ages.
 * Exit 0 healthy, 1 failing, 2 could not read.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** @returns {{ok: boolean, lines: string[]}} */
export function evaluate(health, { requireBackup = true } = {}) {
  const lines = [];
  let ok = true;
  const check = (pass, label) => {
    lines.push(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
    if (!pass) ok = false;
  };
  check(health?.database?.status === 'up', `database ${health?.database?.status ?? 'missing'}`);
  check(health?.redis?.status === 'up', `redis ${health?.redis?.status ?? 'missing'}`);
  const q = health?.queue;
  check(
    q?.status === 'ok',
    `queue ${q?.status ?? 'missing'}` +
      (q?.recentFailed ? ` (${q.recentFailed} failed in the last 24h)` : ''),
  );
  const b = health?.backup;
  if (!b) {
    // An API older than this check does not report backups. Say so; do not pass it silently.
    check(!requireBackup, 'backup freshness not reported by this API version');
  } else {
    const detail =
      b.status === 'never'
        ? 'no verified backup has ever been recorded'
        : `newest verified backup ${b.ageHours}h old (limit ${b.maxAgeHours}h)`;
    const pass = b.status === 'fresh' || (b.status === 'unknown' && !requireBackup);
    check(pass, `backup ${b.status}: ${detail}`);
  }
  if (health?.appEnv) lines.push(`env   ${health.appEnv}`);
  return { ok, lines };
}

async function main() {
  const fileIdx = process.argv.indexOf('--file');
  let health;
  if (fileIdx > 0) {
    health = JSON.parse(readFileSync(process.argv[fileIdx + 1], 'utf8'));
  } else {
    const { API_URL, ADMIN_TOKEN } = process.env;
    if (!API_URL || !ADMIN_TOKEN) {
      console.error('Set API_URL (ending /api) and ADMIN_TOKEN, or pass --file.');
      process.exit(2);
    }
    try {
      const res = await fetch(`${API_URL.replace(/\/$/, '')}/admin/ops/health`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      health = body?.data ?? body;
    } catch (e) {
      console.error(`Could not read ops health: ${e.message}`);
      process.exit(2);
    }
  }
  const { ok, lines } = evaluate(health, {
    requireBackup: process.env.BACKUP_FRESHNESS_REQUIRED !== 'false',
  });
  console.log(lines.join('\n'));
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
