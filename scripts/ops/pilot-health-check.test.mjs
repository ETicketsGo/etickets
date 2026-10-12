// Run: node --test scripts/ops/pilot-health-check.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate } from './pilot-health-check.mjs';

const base = {
  database: { status: 'up' },
  redis: { status: 'up' },
  queue: { status: 'ok' },
  backup: { status: 'fresh', ageHours: 5, maxAgeHours: 26 },
};

test('healthy platform passes', () => assert.equal(evaluate(base).ok, true));
test('stale backup fails', () =>
  assert.equal(
    evaluate({ ...base, backup: { status: 'stale', ageHours: 144, maxAgeHours: 26 } }).ok,
    false,
  ));
test('never-backed-up fails', () =>
  assert.equal(evaluate({ ...base, backup: { status: 'never', maxAgeHours: 26 } }).ok, false));
test('missing backup field fails when required, passes when not', () => {
  const { backup, ...old } = base;
  assert.equal(evaluate(old).ok, false);
  assert.equal(evaluate(old, { requireBackup: false }).ok, true);
});
test('degraded queue and down database fail', () => {
  assert.equal(evaluate({ ...base, queue: { status: 'degraded', recentFailed: 2 } }).ok, false);
  assert.equal(evaluate({ ...base, database: { status: 'down' } }).ok, false);
});
