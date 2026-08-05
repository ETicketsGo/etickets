# ETicketsGo — Railway Backup & Recovery

> Railway-specific companion to [P6.9 — Backup, Restore & DR](../p6/P6.9-BACKUP-RESTORE-DR.md),
> which defines the objectives and the invariant checks. This document says how to meet them
> on Railway, and records what is genuinely unknown until the projects exist.
>
> Companion: [Railway Deployment Runbook](./RAILWAY_DEPLOYMENT_RUNBOOK.md) §18, §20

---

## 1. What is authoritative

Recovery priority follows from what cannot be reconstructed.

| Store               | Authoritative for                                                                                                             | If lost                                                                                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PostgreSQL**      | Bookings, tickets, payments, refunds, settlements, outbox, provider checkpoints, allocation accounting, users, refresh tokens | **Real data loss.** The only store that must be backed up.                                                                                                                                                 |
| **Redis**           | Nothing                                                                                                                       | Seat locks expire (PostgreSQL held/confirmed accounting stays correct), queues are recreated by the worker at boot, cache repopulates, maintenance flag resets to off. Degraded throughput, not lost data. |
| **Object storage**  | Nothing today                                                                                                                 | No object-storage code path exists in this codebase (see §6).                                                                                                                                              |
| **Secrets**         | —                                                                                                                             | Back up the _manifest_ (names, owners, rotation dates), never the values.                                                                                                                                  |
| **Schema & config** | —                                                                                                                             | In git. Migrations are forward-only; recovery is forward-fix.                                                                                                                                              |

QR codes are deterministically regenerable from booking data plus `QR_SIGNING_SECRET` —
which is exactly why that secret's loss is a bigger problem than a file store's.

---

## 2. PostgreSQL backup availability — **verify before relying on it**

> **This section contains placeholders that must be filled in by the repository owner.**
> Railway's backup frequency, retention, and point-in-time-recovery availability depend on
> your plan and can change. Do not assume; check the dashboard and record what you see.

Railway → project → `Postgres` → **Backups**.

| Environment    | Automated backups | Frequency | Retention | PITR available | Verified on | By      |
| -------------- | ----------------- | --------- | --------- | -------------- | ----------- | ------- |
| QA             | `<enabled?>`      | `<...>`   | `<...>`   | `<yes/no>`     | `<date>`    | `<who>` |
| UAT            | `<enabled?>`      | `<...>`   | `<...>`   | `<yes/no>`     | `<date>`    | `<who>` |
| **Production** | `<enabled?>`      | `<...>`   | `<...>`   | `<yes/no>`     | `<date>`    | `<who>` |

**If Railway's built-in retention does not meet the target in §4, add independent logical
backups.** This repository already ships the tooling:

```bash
# Nightly, from a machine with the pg_dump 16 client and network access:
DATABASE_URL="<production-postgres-url>" ./scripts/backup-db.sh /var/backups/eticketsgo
```

Store those dumps **off Railway** (S3 with versioning and object-lock, or equivalent).
A backup that lives only inside the platform it protects is not a backup — it does not
survive account suspension, billing failure, or an accidental project deletion.

---

## 3. Restore procedure

### 3a. From a Railway backup (preferred where available)

1. **Declare an incident.** Enable maintenance mode so writes stop:
   `POST /api/admin/ops/maintenance {"enabled":true,"message":"Emergency maintenance"}`.
   The flag is scoped to `etg:production:ops:maintenance` and cannot affect QA or UAT.
2. **Snapshot the current broken state first** — `./scripts/backup-db.sh` against the live
   database. You will very likely need it to reconstruct anything written after the backup
   point, and once you restore it is gone.
3. Railway → `Postgres` → **Backups** → choose the backup → **Restore**.
4. **Restart the app services** so connection pools do not hold references to the old
   database: redeploy `api`, then `worker`.
5. **Verify** (§5).
6. **Reconcile payments** (§5, step 4) — this step is not optional.
7. Disable maintenance mode. Monitor error rate and booking success for at least an hour.

### 3b. From a logical dump

```bash
# STOP api + worker first (Railway → service → Settings → Remove/scale to 0 replicas),
# so nothing writes mid-restore.
DATABASE_URL="<target-postgres-url>" ./scripts/restore-db.sh backups/eticketsgo-<ts>.dump

# The script uses --clean --if-exists: it DROPS existing objects. Never point it at a
# database you have not just snapshotted.

DATABASE_URL="<target>" npx --prefix apps/api prisma migrate deploy   # no-op if in sync
```

Then restart the services and continue from step 5 above.

### 3c. Restoring into a scratch database (the safe rehearsal)

This is how §7's restore test is performed, and how you should validate any backup you are
not certain about:

1. Create a **new** PostgreSQL plugin in a scratch Railway project.
2. Restore the production dump into it.
3. Point a **non-production** app stack at it with `APP_ENV=STAGING`.
4. Run the verification in §5.
5. **Delete the scratch project when done** — it now holds a full copy of production PII.

---

## 4. RPO and RTO

Targets inherited from [P6.9](../p6/P6.9-BACKUP-RESTORE-DR.md), restated with what Railway
actually delivers:

| Metric                  | Target   | Achievable on Railway                                                                         | Gap                                                                                                                                     |
| ----------------------- | -------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **RPO** (max data loss) | ≤ 5 min  | Only with PITR/continuous WAL. With daily snapshots alone the real RPO is **up to 24 hours**. | **Confirm PITR availability on your plan.** If unavailable, either accept the larger RPO in writing or add more frequent logical dumps. |
| **RTO** (max downtime)  | ≤ 60 min | Plausible: restore + redeploy is typically well under an hour at this data size.              | Unproven until the restore test in §7 runs.                                                                                             |

**Do not publish an RPO of 5 minutes until PITR is confirmed enabled.** A stated RPO that
the infrastructure cannot meet is worse than an honest larger number, because it drives the
wrong decisions during an incident.

### Payment reconciliation changes the picture

Payments captured at Stripe or Razorpay **after** the backup point exist at the provider but
not in the restored database. Money moved; your records do not show it. This is the most
consequential consequence of any restore here, and it is repairable:

- `/admin/payments/reconciliation` (finance reconciliation) detects the discrepancies.
- The `reconcile-finance` worker job files them for triage.
- Repair them **before** reopening bookings, or customers who paid will be told they did not.

---

## 5. Verifying a restore

```bash
# 1. Schema ledger is complete
DATABASE_URL="<restored>" npx --prefix apps/api prisma migrate status     # "up to date"

# 2. Row counts are plausible against the pre-incident figures
psql "<restored>" -c 'SELECT
  (SELECT count(*) FROM "Booking")  AS bookings,
  (SELECT count(*) FROM "Ticket")   AS tickets,
  (SELECT count(*) FROM "Payment")  AS payments,
  (SELECT count(*) FROM "User")     AS users;'

# 3. The application accepts the database
curl -fsS https://api.eticketsgo.com/api/ready      # {"status":"ok",...}

# 4. Money invariants hold under concurrency
DATABASE_URL="<restored>" node scripts/soak/concurrency-soak.mjs --seconds 30
```

Then, manually:

- A known recent booking is present and correct.
- Its ticket QR still validates (`QR_SIGNING_SECRET` unchanged).
- **Payment reconciliation run and discrepancies resolved** (§4).
- The outbox re-drives cleanly on worker boot — handlers are idempotent, so re-delivery is
  safe, but confirm no duplicate side effect.

---

## 6. Object storage

**There is nothing to back up.** `STORAGE_DRIVER` is declared in the config schema, but no
upload or object-storage code path exists in this codebase — verified by the absence of any
`UploadedFile`, `FileInterceptor`, `writeFile`, or `createWriteStream` usage in
`apps/api/src`. Tickets and QR codes are generated on demand and are deterministic.

Railway's container filesystem is **ephemeral**: it is wiped on every deploy. If a feature
that writes durable files is ever added, it must ship an object-storage driver at the same
time, with a per-environment bucket and versioning enabled. Do not let a file-writing
feature reach Railway on the local driver.

---

## 7. Production restore test

**A backup you have never restored is a hypothesis.** Schedule this, run it, record it.

| Field              | Value                                                               |
| ------------------ | ------------------------------------------------------------------- |
| Frequency          | Quarterly, and after any change to the backup configuration         |
| Method             | §3c — restore into a scratch project, never over a live environment |
| Success criteria   | All four checks in §5 pass; measured RTO ≤ the §4 target            |
| Owner              | `<name>`                                                            |
| **Last performed** | **NEVER — outstanding**                                             |
| Next due           | `<date>`                                                            |

### Log

| Date | Backup used | Restore duration | Result | Notes |
| ---- | ----------- | ---------------- | ------ | ----- |
|      |             |                  |        |       |

Until the first row exists, **the production restore process is documented but unproven**,
and any DR claim should say so.

---

## 8. Redis persistence expectations

Redis holds no authoritative state, so it needs no backup. What it needs is an agreed
expectation of what a loss looks like:

| On Redis loss       | Behaviour                                                                                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seat/quantity locks | Vanish. PostgreSQL held/confirmed accounting is authoritative and stays correct; the worst case is a seat becoming available slightly early.                                             |
| BullMQ queues       | In-flight jobs are lost. All jobs here are **idempotent and re-drivable**: repeatable jobs re-register at worker boot, and the durable outbox re-delivers domain events from PostgreSQL. |
| Read-through cache  | Repopulates on the next request. Brief latency increase only.                                                                                                                            |
| Maintenance flag    | Resets to disabled (fail-open by design — an unreachable Redis must never block traffic).                                                                                                |

Enable AOF persistence if Railway's plugin offers it: it shortens the post-restart backlog.
It is an optimisation, not a correctness requirement.

---

## 9. Secrets recovery

Secret **values** are not backed up. Maintain a manifest — name, which services consume it,
owner, last rotation — and store it with your team's other operational records, not in this
repository.

If a value is lost, rotate it per [Runbook §19](./RAILWAY_DEPLOYMENT_RUNBOOK.md#19-rotating-secrets).
The one that hurts is `QR_SIGNING_SECRET`: losing it invalidates every issued ticket QR, and
there is no recovery other than re-issuing them. Treat it as the highest-value secret on the
platform and make sure at least two people can retrieve it from your secret store.

---

## 10. What is not yet proven

Stated plainly so no one mistakes documentation for evidence:

- [ ] Railway backup frequency, retention, and PITR availability — **not verified** (§2)
- [ ] Production restore — **never performed** (§7)
- [ ] RTO — **never measured**
- [ ] The 5-minute RPO target — **not achievable without confirmed PITR** (§4)
- [ ] Off-platform backup copies — **not configured** (§2)

Each is a repository-owner action requiring Railway access. Until they are closed, DR
readiness for production is **documented, not demonstrated**.
