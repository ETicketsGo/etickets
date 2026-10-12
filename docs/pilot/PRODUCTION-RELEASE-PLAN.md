# Production release plan (prepared 2026-10-12, not executed)

Purpose: move production from its October 4 to 7 build to a certified release of main, without losing the first
admin, without a wrong deploy, and with a tested way back. Nothing here is approved by being written down. Each gate
(G0 to G9) needs the owner's explicit approval at the time, recorded with name and time.

Related: [INFRASTRUCTURE.md](INFRASTRUCTURE.md) (secrets, backups, rollback detail),
[REAL-EMAIL-CERTIFICATION.md](REAL-EMAIL-CERTIFICATION.md), [RAZORPAY-READINESS.md](RAZORPAY-READINESS.md),
[RAZORPAY-RECONCILIATION-2026-10.md](RAZORPAY-RECONCILIATION-2026-10.md), [PILOT-READINESS.md](PILOT-READINESS.md).

## Production today (read-only, 2026-10-12)

| Item                                | State                                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Code                                | api d57f62c (redeployed same commit 18:46 UTC for the admin bootstrap), customer-web d57f62c, worker 94a969d, organizer-web and admin-web c82f3cf, db-seed 311ebb7 |
| Migrations                          | 112 applied, last `20261006210000_consent_evidence`                                                                                                                |
| Admins                              | 1: srinivas@deeptrics.com (SUPER_ADMIN, bootstrap audited 18:46:26 UTC). 0 admin grants                                                                            |
| `ADMIN_BOOTSTRAP_EMAIL`             | Still set on api (removing it by itself would deploy the head of main; see step R9)                                                                                |
| Events                              | 2 test events, PAUSED by the admin (audited 19:16 UTC). No tickets, no confirmed bookings, no refunds                                                              |
| Payments                            | Razorpay LIVE enabled; secret references `payments/razorpay/live/secret-key` and `.../webhook-secret`; 4 unresolved orders (reconciliation worksheet)              |
| Settlements, payouts, bank accounts | 0                                                                                                                                                                  |
| Backups                             | Nightly dump, read back with `pg_restore --list`, 11 kept, on Railway only; never restored                                                                         |
| Email                               | 0 notifications sent in 30 days                                                                                                                                    |
| MFA                                 | Does not exist                                                                                                                                                     |

## Gates

| Gate | What must be true                                                                                                                                                                                                                              | Who approves |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| G0   | Release SHA chosen; main frozen at it (no merges until G9). QA runs it and passes: certification (296 checks), finance figures after refunds (FIN-1), separation of duties with two QA staff accounts, MFA certification, cross-browser script | Owner        |
| G1   | Restore rehearsal passed on a production dump in an isolated database (section "Restore rehearsal")                                                                                                                                            | Owner        |
| G2   | Off-platform backup bucket exists; write-only credentials created; first upload verified on QA                                                                                                                                                 | Owner        |
| G3   | Production secrets: the runtime principal can read exactly the two reference names above; api and worker have the secret-store variables (names checked in the Railway dashboard by the owner)                                                 | Owner        |
| G4   | Email: SES production access, domain DKIM/SPF/DMARC pass, SNS confirmation route decided                                                                                                                                                       | Owner        |
| G5   | Monitoring: roster named; the pilot health check scheduled; alert receivers tested                                                                                                                                                             | Owner        |
| G6   | The owner's authenticator app is ready for MFA enrollment at first sign-in after the release (and the break-glass procedure is read)                                                                                                           | Owner        |
| G7   | Deploy window approved (low traffic; both test events paused; nothing on sale)                                                                                                                                                                 | Owner        |
| G8   | Post-deploy verification passed (step R8)                                                                                                                                                                                                      | Owner + eng. |
| G9   | Live payment certification passed; only then may any pilot event be published                                                                                                                                                                  | Owner        |

## Database migrations

Production has 112 migrations; main had 119 on 2026-10-12, and the MFA work adds new tables. The exact list is
computed at G0 with the release SHA:

```
git diff --name-only <production api commit> <release SHA> -- apps/api/prisma/migrations | sort -u
```

Known pending migrations and their classification (read from their SQL):

| Migration                                          | Kind                                                                            | Old code still works after it?                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `20261007090000_space_belongs_to_venue`            | Relaxes Venue country/timezone and Screen cinemaId to nullable; backfill UPDATE | One-way. Old code reading a null may fail                                |
| `20261007100000_general_admission_zones`           | New tables                                                                      | Yes                                                                      |
| `20261007110000_venue_location_is_answerable`      | Repeats the nullable relaxation                                                 | Same as above                                                            |
| `20261007120000_a_space_has_named_layouts`         | SeatMap.name NOT NULL with backfill; index swap                                 | One-way. Old code creating a seat map fails (production has 0 seat maps) |
| `20261007130000_ticket_types_reference_seat_zones` | New nullable column                                                             | Yes                                                                      |
| `20261009090000_event_image_variants`              | New columns and table                                                           | Yes                                                                      |
| `20261011120000_payout_account_versions`           | New table, CHECK constraint checker-not-maker, backfill INSERT                  | Yes (production has 0 payout accounts)                                   |
| MFA tables (from the MFA PR)                       | New tables only                                                                 | Yes                                                                      |

The api runs `prisma migrate deploy` as its Railway preDeployCommand (deploy/railway/api.railway.json), once, before the new image takes traffic. If the new image then fails to
become healthy, Railway keeps the old deployment serving, but the migrations have already run. Because two are
one-way, the plan after migrations is **fix forward**, with the restore (section "Rollback") as the last resort.

## Release sequence (only after G0 to G7)

All variable writes use `skipDeploys: true`. A variable write without it, or any `variableDelete`, builds the head
of main, which is why main stays frozen at the release SHA until R9 is complete.

| Step | Action                                                                                                                                                                                                                                                                                                                                                 | Check before the next step                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| R1   | Confirm both test events still PAUSED and nothing is on sale (read-only)                                                                                                                                                                                                                                                                               | 0 published events                                                                                   |
| R2   | Trigger a backup now (db-seed backup operation) and copy it off-platform; record name, size, SHA-256                                                                                                                                                                                                                                                   | Backup verified; offsite object present                                                              |
| R3   | Set new variables with skipDeploys (names only): `MFA_ENCRYPTION_KEY` (api, worker), `SMS_ENABLED=false`, `EMAIL_PROVIDER=ses` and the SES names from REAL-EMAIL-CERTIFICATION, `BACKUP_OFFSITE_*` (db-seed), secret-store names if G3 found any missing                                                                                               | Owner confirms names present in the dashboard                                                        |
| R4   | Deploy **api** at the release SHA (`node scripts/deploy/railway-deploy-and-wait.mjs api 1800`, which deploys main = release SHA)                                                                                                                                                                                                                       | Deployment SUCCESS; logs show the expected migrations applied and no boot refusal; `/api/health` 200 |
| R5   | Deploy **worker**                                                                                                                                                                                                                                                                                                                                      | SUCCESS; worker log shows queue connection                                                           |
| R6   | Deploy **customer-web**, **organizer-web**, **admin-web**                                                                                                                                                                                                                                                                                              | Each SUCCESS; storefront 200                                                                         |
| R7   | Deploy **db-seed**; next 02:00 UTC log shows backup + offsite upload                                                                                                                                                                                                                                                                                   | BACKUP_JSON with `offsite.status`                                                                    |
| R8   | Verification: deployed commits all equal the release SHA (deployment metadata, not variables); `/api/capabilities` shows `phoneSignIn: false`; `/api/admin/ops/health` backup field fresh; owner signs in, is forced to enroll MFA, enrolls, saves recovery codes, reaches the admin console; both events still PAUSED; payment outage status readable | All pass = G8                                                                                        |
| R9   | Remove `ADMIN_BOOTSTRAP_EMAIL` (variableDelete; this builds the head of main for api, which is still the release SHA). Then unfreeze main                                                                                                                                                                                                              | api commit still the release SHA; owner still admin                                                  |
| R10  | Grant staff presets to the named people (FINANCE_VERIFIER, FINANCE_PAYER, FINANCE_REVIEWER, OPS_ONCALL, payment-stop holder); each enrolls MFA                                                                                                                                                                                                         | Audit rows for each grant                                                                            |
| R11  | Live payment certification (RAZORPAY-READINESS section 3), then G9                                                                                                                                                                                                                                                                                     | All green                                                                                            |

## Initial admin preservation

- Migrations do not touch `User.roles` or `AdminGrant`; the admin keeps SUPER_ADMIN.
- After the MFA release the admin's existing sessions stop working on admin routes; at the next sign-in the password
  still works and the console forces enrollment before any admin action. Have the authenticator app ready (G6).
- Recovery codes: stored offline by the owner (password manager or paper in a safe), never in chat or email.
- If both the device and the codes are lost: the break-glass procedure in docs/security/ADMIN-MFA.md (operator-
  controlled, audited, one named account). It requires Railway access, which is the same trust as the bootstrap.
- Create a second, independent super admin soon after the release, so one lost phone does not stop operations.

## Finance permissions migration

No grants exist in production (0 rows) and no account holds payout permissions through a grant on QA, UAT or
production (read-only check 2026-10-12). Nothing changes for anyone at deploy time. After the release the super
admin can verify a bank account or pay a payout, but never both for the same account. Finance A and B receive their
presets in R10, after they enroll MFA.

## Payment-only emergency stop

`POST /api/admin/payments/outage/country/IN/suspend` (and `/provider/razorpay/suspend`, `/route/:id/suspend`), with
`{"suspended": true}`, needs PAYMENT_ADMIN or super admin. It stops new payments only; refunds and webhooks keep
working. `GET /api/admin/payments/outage/status` reads the posture. There is no screen; the on-call runbook carries
the exact calls. Verify read access in R8; do not suspend as a test in production.

## Monitoring and alerting

- `GET /api/admin/ops/health` (backup freshness, queues) polled by `scripts/ops/pilot-health-check.mjs` every 6 hours
  from a scheduler outside Railway, plus the daily read-only `scripts/ops/pilot-monitor-queries.sql`.
- Prometheus rules in `observability/prometheus/pilot-alerts.yml` once a Prometheus exists; until then the polled
  checks are the alerting, sent to the roster.
- Watch in the first 48 hours: `payment_webhooks{result="signature_invalid"}`, webhook DEAD_LETTER, bookings PENDING
  over 15 minutes, backup age over 26 hours, 5xx rate.

## Email delivery and bounce handling

Follow REAL-EMAIL-CERTIFICATION.md. Until one real email is received in production, keep
`ALLOW_UNDELIVERABLE_NOTIFICATIONS` as it is; remove it after, as a variable write with skipDeploys followed by a
pinned deploy of the release SHA.

## Restore rehearsal (G1, needs approval to execute)

Goal: prove that the newest production dump restores into an isolated database and matches production, and measure
the recovery time. Never restore over production.

1. Target: a new scratch database `etg_restore_drill_<date>` on a Postgres server that is not production's database.
   Option A (recommended, data never leaves Railway's private network): a separate Postgres service the owner creates
   in the dashboard for drills, no public domain. Option B: a scratch database on the production Postgres server
   (the dump is about 340 KB, so load is negligible), dropped at the end. Option C: an encrypted owner machine (data
   leaves the platform; needs a data-protection decision).
2. Run `scripts/ops/restore-drill.sh` from inside the db-seed container (it holds the dumps) over Railway SSH, with
   `DRILL_ADMIN_URL` pointing at the target server; the script refuses `DATABASE_URL`, creates the scratch database,
   restores, checks, prints names and counts only, and drops it unless `DRILL_KEEP=1`.
3. Checks: `pg_restore --list` integrity; `_prisma_migrations` equals production's 112; row counts per table equal a
   read-only count of production taken in the same minute (Users, Organizations, Events, Bookings, Payments,
   WebhookEvents, AuditLog); the four Razorpay order ids present; the admin's roles present.
4. Application compatibility: point a throwaway api process (production commit, no public domain, no provider keys,
   `PAYMENTS_ACTIVATION_PENDING=true`) at the scratch database and check `/api/health` and an admin read. If that is
   too heavy for the first drill, record it as not done.
5. Record: start and end times (RTO), dump name and SHA-256, counts, result. Then drop the scratch database.
6. Rollback of the drill itself: drop the scratch database; nothing else was created.

## Rollback

| Situation                  | Action                                                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R4 fails before migrations | Nothing changed; Railway keeps the old deployment. Investigate.                                                                                          |
| R4 fails after migrations  | Old api keeps serving on the migrated schema; production has 0 seat maps and no screens in use, so the one-way migrations do not affect it. Fix forward. |
| Regression found after R8  | Web apps: redeploy the previous deployment ids. api/worker: fix forward (one-way migrations).                                                            |
| Payment problem            | Payment-only stop (above), not maintenance mode.                                                                                                         |
| Admin locked out after MFA | Break-glass procedure; it is audited.                                                                                                                    |
| Data corruption            | Stop api and worker; restore the R2 backup into a scratch database, compare, then restore in a window; reconcile payments with Razorpay.                 |

## Blockers today

MFA not merged; offsite backup not merged; restore rehearsal not run; secret-store names unverified; SES and SNS not
done; roster empty; four Razorpay orders unreconciled; live payment certification not run.
