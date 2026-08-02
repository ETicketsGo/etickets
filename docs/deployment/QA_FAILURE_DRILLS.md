# ETicketsGo — QA Failure Drills

> Twelve drills. Each says what to do, what a **pass** looks like, and — where the drill was
> already executed locally against a Railway-shaped stack — what actually happened.
>
> Drills 1–8 and 11–12 have local results recorded below. Drills 9 and 10 need a real
> Railway environment. Nothing here has been run against a deployed QA environment, because
> none exists yet.
>
> Local evidence detail: [QA_PREFLIGHT_VALIDATION.md](./QA_PREFLIGHT_VALIDATION.md).

**Never run a destructive drill against production.** Drills 6, 7, 11 and 12 take a
dependency down or damage a schema; QA only.

---

## 1. Restart the API during checkout

**Do:** begin a checkout (seat held, payment not yet confirmed). Restart the `api` service
mid-flow — Railway → `api` → **⋯ → Restart**.

**Pass:**

- The API terminates **gracefully** — exit 0, not a forced kill.
- The held seat is still held (PostgreSQL is authoritative; the hold is a database row).
- The customer can resume or restart checkout; no double charge, no orphaned hold.
- The hold expires normally afterwards if abandoned.

**Local result — this drill found and fixed a real defect.** Before the fix, SIGTERM was
ignored entirely: the container hung for the full grace period and was SIGKILLed
(`exit 137` after 21s), severing in-flight requests. Two causes, both fixed: the API never
called `enableShutdownHooks()`, and the `inventory-sync-events` BullMQ queue was created by
a factory provider and never closed, so its Redis socket kept the event loop alive even
after teardown ran. After the fix: **1s, exit 0**. This happens on _every_ Railway deploy
and restart, so it was not a rare edge case.

---

## 2. Restart the worker with pending jobs

**Do:** ensure jobs are queued, then restart the `worker` service.

**Pass:** no job is lost; the restarted worker drains the backlog; repeatable schedules
re-register; no duplicate side effect (handlers are idempotent).

**Local result: PASS.** Against a password-protected Redis: a job enqueued while the
consumer was down survived the shutdown (`waiting=1` before and after), and a freshly
started worker picked it up and processed it. Graceful shutdown confirmed —
`{"msg":"shutting down","signal":"SIGTERM"}`, 1s, exit 0.

---

## 3. Deliver the same webhook twice

**Do:** in the Stripe (or Razorpay) dashboard, resend an already-delivered QA event.

**Pass:** the second delivery is a **no-op**. One payment, one booking, one confirmation
email. The provider sees 2xx both times (a non-2xx would trigger pointless retries).

**Coverage:** covered by unit tests on both processors — the durable event is claimed
atomically, so a duplicate or concurrent delivery loses the claim and no-ops
(`stripe-webhook.processor.spec.ts`, `razorpay-webhook.processor.spec.ts`). Not executed
live locally, because a faithful test needs a provider-signed payload.

---

## 4. Let a seat hold expire

**Do:** hold a seat, abandon checkout, wait past the hold TTL (the `expire-holds` repeatable
job runs every 60s by default).

**Pass:** the hold is released; inventory returns to available; the booking moves to an
expired state; a second customer can now buy the seat. Releasing an already-released hold
is a no-op, so a repeated sweep is harmless.

**Local result: partial.** The `expire-holds` repeatable job registered and executed on
schedule under the QA namespace (`etg:qa:bull:holds:repeat`), and the worker logged its
startup sweep. Full end-to-end expiry of a real seat was not driven locally.

---

## 5. Two concurrent bookings for the same seat

**Do:** `node scripts/loadtest/concurrency.mjs` against QA, or two browsers racing.

**Pass:** **exactly one** booking succeeds. Every other request gets `409
BOOKING_INVENTORY_UNAVAILABLE`. Zero 5xx. **Zero oversell.**

**Local result: PASS.** 25 concurrent clients per round, two rounds, two distinct seats:

| Round | Concurrency | Winners | 409 conflicts | 5xx | Wall  |
| ----- | ----------- | ------- | ------------- | --- | ----- |
| 1     | 25          | **1**   | 24            | 0   | 186ms |
| 2     | 25          | **1**   | 24            | 0   | 133ms |

The GA-quantity race was **skipped, not passed** — the seeded ticket type had zero remaining
stock, so no meaningful race was possible. Re-run it against QA with stock available.

---

## 6. Disable Redis temporarily

**Do:** stop the Redis plugin (or block it) for ~60s, then restore.

**Pass:**

- `/api/ready` returns **503** with `"redis":"down"` — the deployment is deroutable.
- `/api/health` stays **200** — liveness must not depend on Redis, or the platform would
  kill a recoverable container.
- The cache fails **open**: cached read paths fall back to the database.
- Maintenance mode fails **open**: an unreachable Redis must never start blocking traffic.
- Queues stall but lose nothing; the worker resumes on recovery.
- Readiness returns to 200 without a restart.

**Local result: PASS.**

```
before      {"status":"ok","checks":{"database":"up","redis":"up"}}        HTTP 200
redis down  {"status":"degraded","checks":{"database":"up","redis":"down"}} HTTP 503
liveness    HTTP 200   (correctly independent of Redis)
recovered   {"status":"ok","checks":{"database":"up","redis":"up"}}        HTTP 200
```

---

## 7. Disable PostgreSQL temporarily

**Do:** stop the Postgres plugin for ~60s, then restore.

**Pass:** `/api/ready` returns 503 with `"database":"down"`; `/api/health` stays 200; **no
connection string, credential, host, or stack trace appears in the response**; readiness
recovers without a restart.

**Local result: PASS.**

```
db down     {"status":"degraded","checks":{"database":"down","redis":"up"}} HTTP 503
liveness    HTTP 200
leak scan   0 occurrences of password / postgres:// / host= / 5432 / user=
recovered   {"status":"ok","checks":{"database":"up","redis":"up"}}         HTTP 200
```

---

## 8. Trigger maintenance mode in QA

**Do:** as an admin, `POST /api/admin/ops/maintenance {"enabled":true,"message":"QA drill"}`.
Then disable it.

**Pass:** QA returns the maintenance response; the admin path still works; disabling
restores service.

**Local result: PASS.** The flag is written to `etg:qa:ops:maintenance` only.

---

## 9. Verify no UAT or production namespace is affected

**Do:** with drill 8 active, inspect the Redis keyspace and confirm the other environments'
flags are untouched.

**Pass:** only the QA key exists; UAT and production keys are unset; the legacy shared key
`etg:maintenance` does not exist anywhere.

**Local result: PASS.** With the QA flag set on a **shared** Redis:

```
etg:qa:ops:maintenance          = {"enabled":true,"message":"QA drill"}
etg:uat:ops:maintenance         = <unset — unaffected>
etg:production:ops:maintenance  = <unset — unaffected>
EXISTS etg:maintenance          = 0
```

Before this branch the flag lived at the global `etg:maintenance`, so two environments
sharing a Redis shared it — QA enabling maintenance would have taken production offline.

Queue-level isolation was proven the same way: a UAT-namespaced BullMQ worker running
against the same Redis **could not consume** a QA job (`etg:qa:bull` vs `etg:uat:bull`).
On Railway the instances are separate anyway; this proves the namespace is genuine
defence-in-depth rather than the isolation resting on the instance boundary alone.

---

## 10. Roll back an application deployment

**Do:** Railway → service → **Deployments** → a previous good deployment → **⋯ → Redeploy**.
Roll back in reverse dependency order: web tier, then `worker`, then `api`.

**Pass:** the previous version serves within a minute; `/api/ready` returns 200; no schema
change is required.

**Requires Railway — not executable locally.** Note the standing limitation: a rollback does
**not** revert the database. It is safe only because migrations here are additive, so the
previous image tolerates columns and tables it does not know about. A destructive migration
breaks that property and turns rollback into a restore.

---

## 11. Simulate a failed migration

**Do:** on a throwaway branch, add a migration containing invalid SQL and deploy to QA.

**Pass:**

- `prisma migrate deploy` exits non-zero, which **fails the Railway deployment**.
- The **previous API version keeps serving** — the environment is un-upgraded, not down.
- The worker and web services are **never deployed** (the pipeline stops at the API step).
- The failed migration is recorded as unfinished, blocking further migrations until
  resolved — which is the intended forcing function.
- Recovery per [runbook §18](./RAILWAY_DEPLOYMENT_RUNBOOK.md#18-handling-a-failed-database-migration).

**Local result: PASS, including recovery.**

```
migrate deploy exit code = 1                    ← this is what fails the deploy
Error: P3018  A migration failed to apply       ← db error 42P01, relation does not exist
ledger: 29990101000000_drill_intentional_failure  unfinished=t  rolled_back=f

recovery:
  prisma migrate resolve --rolled-back 29990101000000_drill_intentional_failure
  → "marked as rolled back"
  prisma migrate deploy → "No pending migrations to apply."
  ledger clean; the drill migration was removed from the repo
```

**Never** use `prisma migrate reset` (drops the database) or `prisma db push` (bypasses
migration history) to recover. Neither appears in any deploy path, and
`npm run verify:deploy` fails the build if one is introduced.

---

## 12. Restore a QA database backup

**Do:** take a backup, then restore it into a **separate scratch database** — never over the
live one.

**Pass:** the restore completes; `prisma migrate status` reports up to date; row counts are
plausible; `/api/ready` returns 200 when an app is pointed at it.

**Local result: PASS.**

```
pg_dump -Fc            → 219,285 bytes
restore into scratch   → 69 tables, 40 migration ledger rows
prisma migrate status  → "Database schema is up to date!"
scratch database dropped afterwards (it held a full copy)
```

**On real data:** a production or UAT restore must be **anonymised** before it lands in QA —
it contains real customer PII and QA has weaker access controls by design. And after any
restore, payments captured at the provider after the backup point exist there but not in the
restored database: reconcile via `/admin/payments/reconciliation` **before** reopening.

---

## Drill log

| #   | Drill                            | Local result                        | Executed against QA | Date | By  |
| --- | -------------------------------- | ----------------------------------- | ------------------- | ---- | --- |
| 1   | API restart during checkout      | PASS after fix (was exit 137)       | ☐                   |      |     |
| 2   | Worker restart with pending jobs | PASS                                | ☐                   |      |     |
| 3   | Duplicate webhook                | unit-test coverage                  | ☐                   |      |     |
| 4   | Seat hold expiry                 | partial (schedule proven)           | ☐                   |      |     |
| 5   | Concurrent seat booking          | PASS — 1 winner, 24×409, 0 oversell | ☐                   |      |     |
| 6   | Redis outage                     | PASS                                | ☐                   |      |     |
| 7   | PostgreSQL outage                | PASS                                | ☐                   |      |     |
| 8   | Maintenance mode                 | PASS                                | ☐                   |      |     |
| 9   | Namespace isolation              | PASS                                | ☐                   |      |     |
| 10  | Deployment rollback              | needs Railway                       | ☐                   |      |     |
| 11  | Failed migration + recovery      | PASS                                | ☐                   |      |     |
| 12  | Backup restore                   | PASS                                | ☐                   |      |     |
