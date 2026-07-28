#!/usr/bin/env bash
# P6.8 — Chaos injection for the docker-based staging stack. Toggles dependency failures and pairs
# each with the invariant that MUST hold. Run against STAGING ONLY (never production). Requires the
# stack from docker-compose.staging.yml to be up. After each scenario, assert with the soak harness
# and the health/metrics endpoints that no invariant was violated.
#
#   scripts/chaos/inject.sh <scenario>
#
# Global success (every scenario): zero double-booking, zero oversell, zero duplicate payment/refund,
# no false confirmation/refund, recovery works, backlogs observable, manual-review paths activate,
# safe read APIs stay up, active booking fails closed where required.
set -euo pipefail

C() { docker compose -f docker-compose.prod.yml -f docker-compose.staging.yml "$@"; }
API="${API:-http://localhost:4000/api}"
assert_read_up() { curl -fsS "$API/events" >/dev/null && echo "  ✓ read API up" || echo "  ✗ read API DOWN"; }
health() { curl -fsS "$API/health/compensation" | head -c 400; echo; }

case "${1:-help}" in
  redis-restart)   echo "[chaos] restart Redis";        C restart redis; sleep 5; assert_read_up; echo "  expect: active booking fails closed during outage; locks expire safely; no oversell";;
  redis-stop)      echo "[chaos] stop Redis 30s";        C stop redis; sleep 30; assert_read_up; C start redis; echo "  expect: booking fails closed; recovers on restart";;
  db-restart)      echo "[chaos] restart Postgres";      C restart db; sleep 8; echo "  expect: writes fail closed; NO false confirmation; recovery on reconnect";;
  worker-kill)     echo "[chaos] kill a worker replica"; C kill worker || C stop worker; echo "  expect: outbox/compensation backlog grows (observable); stale leases recover; no data loss"; health;;
  api-kill)        echo "[chaos] kill an API replica";   C kill api || C stop api; assert_read_up; echo "  expect: LB routes to healthy replica; in-flight fail cleanly (idempotent retry safe)";;
  outbox-pause)    echo "[chaos] pause worker (outbox dispatcher stops)"; C pause worker; sleep 20; C unpause worker; echo "  expect: events pending then re-driven; exactly-once handlers → no dup side effects";;
  provider-timeout) echo "[chaos] set mock provider to #timeout scenario (payment/provider timeout)"; echo "  drive a booking whose payment ref carries #timeout; expect ambiguous→status recovery; NO double charge";;
  net-latency)     echo "[chaos] inject 500ms latency to Redis (requires toxiproxy/tc)"; echo "  expect: circuit breaker trips; fail closed on money path";;
  restore)         echo "[chaos] restore all services"; C unpause worker 2>/dev/null || true; C start db redis api worker; assert_read_up;;
  help|*) echo "scenarios: redis-restart redis-stop db-restart worker-kill api-kill outbox-pause provider-timeout net-latency restore"; exit 0;;
esac

echo "[chaos] scenario '$1' applied — now run: node scripts/soak/concurrency-soak.mjs --seconds 30 (invariants must stay 0) and inspect $API/health/compensation + /metrics"
