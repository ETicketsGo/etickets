# Pilot infrastructure readiness

Date: 2026-10-12. Base: `origin/main` e3e289e. Scope: the India pilot (3-5 organizers, about 10
general-admission events, INR through Razorpay). Production is **NO-GO** until the owner actions
in section 8 are done.

Evidence tags used below: **[code]** read in this repository on the date above, **[ran]** executed
on the date above (local only), **[note]** dated owner memory, a lead that must be re-verified
against the live environment before anyone relies on it. **Nothing in this document was checked
against production, QA or UAT.** No Railway variable was read or changed, and no secret value
appears here (names only).

## 0. Summary

| Area                  | State                                                                                                                                                                                     | Built in this PR                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Managed secrets       | Gate is correct and strict [code]. PROD booted with a managed store named, but authenticated as the SES **QA** user [note 2026-10-04].                                                    | Exact names, least-privilege policy, owner steps, QA rehearsal (section 1).                         |
| Backups               | Nightly verified `pg_dump` exists [code]. PROD had none after 2026-09-29 [note 2026-10-04]. Nothing alerted. Dumps sit in the same Railway project as the database.                       | **Backup freshness signal** in `GET /api/admin/ops/health`; fails health in PRODUCTION (section 2). |
| Restore proof         | `restore-drill` operation parses counts only [code]. RTO never measured; BACKUP-RUNBOOK rehearsal says PENDING.                                                                           | **`scripts/ops/restore-drill.sh`**: scratch restore, integrity checks, measured RTO. Proven [ran].  |
| Deploy and rollback   | Procedure exists but is spread over four documents, and one trap (variable change deploys latest main) is not in any runbook [note 2026-10-08].                                           | One ordered procedure with a SHA-pin method and a migration rollback table (section 4).             |
| Environment isolation | PROD was duplicated from QA; secrets were rotated, the **database password was not** [note 2026-09-25]; SES QA user was used by PROD [note 2026-10-04].                                   | A check per leak, using fingerprints, never values (section 5).                                     |
| Observability         | Sentry (api and worker), Prometheus metrics, ops health exist [code]. Prometheus rules exist but no Prometheus runs on Railway [note]. Several pilot-critical signals had no rule at all. | Pilot alert rules, SQL monitors, and `pilot-health-check.mjs` (section 6).                          |

## 1. Managed secrets and a dedicated production identity

### 1.1 What the code requires [code]

`apps/api/src/secrets/secret-manager.factory.ts` `selectSecretManager`:

- `SECRET_MANAGER_PROVIDER=env` is **refused** when `APP_ENV` is `STAGING` or `PRODUCTION`, or when
  `PAYMENT_ALLOW_LIVE_KEYS_LOWER_ENV=true`. The error is
  `SECRET_MANAGER_PROVIDER=env is not permitted where live credentials can exist`. This is correct
  and must not be weakened. UAT is deliberately outside the set because it may never hold a live key.
- Providers: `aws` (needs `AWS_SECRETS_REGION`), `azure` (`AZURE_KEY_VAULT_URL`), `gcp`
  (`GCP_PROJECT_ID`). `.env.example` for production names `azure` as an example; the platform
  already has an AWS account for SES, so the shortest path is `aws`.
- The store holds **payment provider credentials and webhook secrets only**. JWT secrets, the QR
  signing key and the payout bank encryption key stay as environment variables.
- The AWS SDK (`@aws-sdk/client-secrets-manager`) loads lazily. A missing region or SDK does not
  stop boot; it fails at the first credential fetch. That is why section 1.4 ends with a
  fetch-based proof and not "the API started".
- AWS credentials come from the default provider chain. On Railway there is no instance role, so
  the chain finds `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in the service environment.
  **The SES client reads the same two variables** (`email.transport.ts`). One principal therefore
  serves both SES and Secrets Manager on a service, and that is why the shared SES QA user ended up
  being PROD's identity [note 2026-10-04].

### 1.2 What production needs (names only)

| Item                                    | Name                                                                                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IAM principal                           | `eticketsgo-prod-runtime` (IAM user with an access key, because Railway has no role federation). Never reuse `eticketsgo-ses-qa`.                                 |
| Secrets (Razorpay, live)                | `payments/razorpay/live/secret-key`, `payments/razorpay/live/webhook-secret`                                                                                      |
| Secrets (Stripe, when needed)           | `payments/stripe/live/secret-key`, `payments/stripe/live/webhook-secret`                                                                                          |
| Not secret, stays a variable            | The Razorpay key **id** (`rzp_live_...`) is an identifier, not a secret.                                                                                          |
| Service variables (api and worker only) | `SECRET_MANAGER_PROVIDER=aws`, `AWS_SECRETS_REGION`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `SECRET_CACHE_TTL_MS` (optional; default 300000) |

The reference string is used verbatim as the AWS `SecretId`. The reference for a provider is the
`secretKeyRef` / `webhookSecretRef` stored on its `PaymentProvider` row, remapped per environment by
`remapSecretRef`; `docs/guides/AWS-SECRETS-MANAGER-SETUP.md` shows `payments/stripe/production/*`
while `PRODUCTION-READINESS-2026-10.md` shows `payments/razorpay/live/*`. **Before creating
anything in AWS, read the two ref columns of the production provider row (names only) and create
exactly those names.** The policy below covers both spellings.

### 1.3 Least-privilege policy (no account id)

Attach to `eticketsgo-prod-runtime`. `<region>` and `<account-id>` are filled by the owner in the
AWS console; the policy never needs the account id typed into the repository.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadPaymentSecretsOnly",
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": [
        "arn:aws:secretsmanager:<region>:<account-id>:secret:payments/razorpay/live/*",
        "arn:aws:secretsmanager:<region>:<account-id>:secret:payments/stripe/live/*",
        "arn:aws:secretsmanager:<region>:<account-id>:secret:payments/razorpay/production/*",
        "arn:aws:secretsmanager:<region>:<account-id>:secret:payments/stripe/production/*"
      ]
    },
    {
      "Sid": "SendEmailFromTheProductionIdentityOnly",
      "Effect": "Allow",
      "Action": ["ses:SendEmail", "ses:SendRawEmail"],
      "Resource": [
        "arn:aws:ses:<region>:<account-id>:identity/<production-sending-domain>",
        "arn:aws:ses:<region>:<account-id>:configuration-set/<production-config-set>"
      ]
    },
    {
      "Sid": "DenyEverythingElseOnSecrets",
      "Effect": "Deny",
      "NotAction": "secretsmanager:GetSecretValue",
      "Resource": "*",
      "Condition": { "StringLike": { "aws:ResourceTag/env": "*" } }
    }
  ]
}
```

Notes on the policy: it cannot list, create, update, rotate or delete a secret, so a leaked key
reads at most the four payment prefixes. The third statement is optional belt and braces and can
be dropped if the owner does not tag secrets. If the SES identity ARN differs from the QA user's,
that is the point: PROD must not be able to send as the QA identity.

### 1.4 Owner steps (production)

1. Create the IAM user and attach the policy above. Create **one** access key. Do not paste it
   anywhere except the Railway variable form.
2. Read the two secret reference names from the production `PaymentProvider` row.
3. Create each secret in Secrets Manager with exactly those names. Enter the live Razorpay secret
   key and the webhook secret **as the values shown in the Razorpay dashboard**.
4. Set the five variables on production **api and worker** (section 4.2 warns that any variable
   change redeploys latest main: do it inside an approved deploy window, or with deploys skipped).
5. Remove `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` belonging to the QA SES user from
   production, in the same change. Delete the old key in AWS afterwards.
6. Prove it with a fact, not a green deploy: `GET /api/admin/payments/live-readiness` must show
   `credentials: passed` and `webhook-delivered: passed` after the first real signed delivery, and
   the api boot log must not contain `Could not bind provider 'razorpay'`.
7. Rotation: update the secret value in AWS; the API picks it up within `SECRET_CACHE_TTL_MS`.

### 1.5 QA rehearsal (no live money, no production)

Do this on QA, or in a throwaway AWS account, before step 3 above. It changes QA variables, so it
needs the owner's approval first (QA has live testers).

1. Create `eticketsgo-qa-runtime` with the same policy, resources restricted to `payments/razorpay/test/*`.
2. Create `payments/razorpay/test/secret-key` and `.../webhook-secret` with the QA **test** values.
3. Set `SECRET_MANAGER_PROVIDER=aws` and `AWS_SECRETS_REGION` on QA api and worker.
4. Expect: boot succeeds; `live-readiness` shows credentials `passed`.
5. Negative test, which is the whole point: set `APP_ENV=PRODUCTION` on a **local** API with
   `SECRET_MANAGER_PROVIDER=env` and confirm boot refuses. This is covered by
   `secret-manager.spec.ts`; run `cd apps/api && npx jest src/secrets`.
6. Revoke the rehearsal key.

## 2. Backups and a freshness signal

### 2.1 How the nightly backup works [code]

- Service `db-seed` (config `deploy/railway/db-seed.railway.json`) runs `prisma/seed-operation.ts`
  with `cronSchedule: "0 2 * * *"` (02:00 UTC), `restartPolicyType: NEVER`.
- With `SEED_OPERATION` unset, `resolveOperation` falls back to `SEED_DEFAULT_OPERATION=backup`
  (`prisma/scheduled-operation.ts`). The fallback list is `status, backup, backups, restore-drill`;
  a schedule can never select a writing operation.
- `takeBackup` (`prisma/backup.ts`): `pg_dump --format=custom --no-owner --no-acl` to the
  `/backups` volume, then **`pg_restore --list` reads it back**; an unreadable dump is deleted
  rather than kept. Retention 14. A manual `SEED_OPERATION` must carry a live `SEED_OPERATION_UNTIL`
  (at most 60 minutes) or the run exits non-zero.
- Every run prints one `SEED_EVIDENCE` line naming the requested and the resolved operation.

### 2.2 Why PROD backups stopped [note 2026-10-04, 2026-10-05, 2026-10-08]

1. A manual `SEED_OPERATION=payment-providers` was left set. An explicit operation outranks the
   backup fallback, so from 2026-09-30 every 02:00 run re-asserted payment rows and took no dump.
   Newest PROD dump was 2026-09-29, 144 hours old when found.
2. A Railway cron service does not start a container when a deployment is created through the API.
   The container starts at the next tick **with the variables captured when that deployment was
   created**. A diagnostic run therefore shadowed the next night's backup too.
3. API-triggered `db-seed` deployments on PROD reach SUCCESS without a container starting, so no
   immediate backup can be forced; there is no supported "run now".
4. Nothing alerted, because every night was a green deployment.

Whether PROD has taken a nightly dump since 2026-10-05 is **unknown to this document** (not
checked). Re-verify with `SEED_EVIDENCE` plus `backup written` and `verified yes` in the 02:00 UTC
log, and the new freshness signal below, before any production deploy.

### 2.3 What was built: the backup freshness signal

The API cannot read the `db-seed` volume, so the backup run leaves evidence in the database it just
dumped, and the API reads the age of that evidence.

- `apps/api/prisma/backup.ts` `recordOpsEvidence`: after a dump has been read back successfully,
  inserts one `AuditLog` row (`action=BACKUP_VERIFIED`, `entityType=DatabaseBackup`, `entityId` =
  dump filename, metadata = size). A passing restore drill writes `RESTORE_DRILL_VERIFIED`. No
  schema change. Values reach SQL as psql variables, never by string building. A failure to write
  evidence is a loud warning, not a failed backup: the backup is real, and the freshness check then
  correctly goes stale.
- `apps/api/src/ops/backup-freshness.ts`: pure evaluator. `fresh` within 26 hours (24h cadence plus
  two hours slack; override with `BACKUP_MAX_AGE_HOURS`), `stale` beyond, `never` when no evidence
  exists, `unknown` when the table cannot be read.
- `GET /api/admin/ops/health` (existing endpoint, permission `OPS_READ`) gains
  `backup: { status, lastVerifiedAt, ageHours, maxAgeHours, lastBackupName, lastRestoreDrillAt }`.
  It sets `status: degraded` for `stale` or `never` **only when `APP_ENV=PRODUCTION` or
  `BACKUP_FRESHNESS_REQUIRED=true`**. Elsewhere it reports without turning the platform red.
  `unknown` never fails by itself, so a transient read error cannot page anyone.
- The `db-seed` runtime image copies `apps/api/prisma` but **not** `apps/api/src`. `backup.ts`
  therefore duplicates three string constants instead of importing them; a unit test pins the two
  copies together. An import from `../src` would crash the nightly job at load and silently end
  backups: do not "tidy" this.
- Limitation 1: the first deploy that contains this code has no evidence rows, so PRODUCTION will
  report `never` and `degraded` until the next 02:00 UTC backup runs with the new code. That is
  honest, and it means the first deployment is also the first proof. Plan for it.
- Limitation 2: `full-reset` (a destructive operation that is refused on PRODUCTION) empties the
  `AuditLog`, which drops the evidence. Correct: the freshness then says `never`.
- Limitation 3: it proves a verified dump exists on the volume. It does not prove the volume
  survives, or that the dump restores. Section 3 and 2.4 cover those.

### 2.4 Fix plan, in order

| #   | Action                                                                                                                                                                                                                                                                                                                       | Who            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 1   | Confirm no `SEED_OPERATION` is set on PROD `db-seed`; make one plain redeploy so the captured environment is clean (cron semantics: nothing runs until 02:00 UTC).                                                                                                                                                           | Owner          |
| 2   | Next morning read the 02:05 UTC log for `backup written` and `verified yes`; then `pilot-health-check.mjs` must show `backup fresh`.                                                                                                                                                                                         | Engineer       |
| 3   | Enable Railway **volume backups** on the Postgres volume in the dashboard (a project token is `Not Authorized`).                                                                                                                                                                                                             | Owner          |
| 4   | Off-platform copy of the newest verified dump (separate cloud account, versioned, write-only credential). Dumps live in the same Railway project as the database today; deleting the project loses both. Code for it exists and is OFF until configured (PR for `feat/offsite-backup-copy`; see docs/ops/OFFSITE-BACKUP.md). | Owner decision |
| 5   | Quarterly and before launch: run the restore drill (section 3) against the newest dump.                                                                                                                                                                                                                                      | Engineer       |
| 6   | Record the honest objective: RPO up to 24 hours (nightly dump, no point-in-time recovery on Railway Postgres); RTO is whatever section 3 measured.                                                                                                                                                                           | Owner          |

## 3. Restore verification in an isolated environment

Script: `scripts/ops/restore-drill.sh`. It restores the newest (or a named) dump into a **new
scratch database**, runs checks, prints a report and drops the scratch database.

```sh
DRILL_ADMIN_URL="postgresql://<user>:<pass>@<host>:5432/postgres" \
  sh scripts/ops/restore-drill.sh <dump-file-or-dir> [apps/api/prisma/migrations]
```

Safety properties (by construction):

- It reads **`DRILL_ADMIN_URL`, not `DATABASE_URL`**, so a shell that happens to export production's
  `DATABASE_URL` cannot aim the drill at production by accident. Point it at a scratch server.
- The only `DROP DATABASE` it can issue names the database it created itself
  (`etg_drill_<epoch>_<pid>`), and it runs in an exit trap, including after a failure.
- It never prints a connection string or a business data row; only names and counts.
- `DRILL_KEEP=1` keeps the scratch database for inspection; `DRILL_RTO_TARGET_SECONDS` (default 1800) turns a slow restore into a failing check.

Checks (exit 1 if any fails, 2 if refused): tables restored; no half-applied migration in
`_prisma_migrations`; applied count not greater than the repository's migrations directory (a dump
newer than the checkout means the wrong checkout); row counts for 11 core tables; and five
invariants that must each return zero: no payment `SUCCEEDED` on a booking that is unconfirmed, no
ticket or payment without a booking, unique booking references, no negative payment amounts.

**Run 2026-10-12, local only [ran].** Source: the local development database (container
`eticketsgo-db`), dumped with `pg_dump --format=custom` and read back with `pg_restore --list`
(6.7 MB). Restore into a scratch database on the same container:

```
tables restored: 100   migrations applied 119 of 119   restore 73 s   RTO (restore + checks) 75 s
rows: User 292, Organization 80, Event 303, EventSession 619, Booking 134, Ticket 127,
      Payment 132, Refund 1, Payout 1, Settlement 30, AuditLog 4630
5 of 5 invariants passed    VERDICT: PASSED    scratch database dropped
```

Falsification: a 2 KB random file named like a dump produced `VERDICT: FAILED (18 checks)`, exit 1,
and the scratch database was still dropped. The refusal path (`no etg-*.dump in <dir>`) exits 2.

Caveat on the number: 75 seconds is a 6.7 MB local database. It proves the **procedure**, not the
production RTO. Production's RTO is measured by running this against a copy of a real PROD dump
inside Railway (or on a scratch Postgres the owner provides), which needs the owner to hand over a
dump or approve an environment. Until that runs, RTO is a target, as `BACKUP-RUNBOOK.md` already says.

## 4. Production deploy and rollback

### 4.1 Order and commands [code]

1. **Gates, on the exact SHA to ship:** CI green on that head, then `npm run verify:deploy` (offline
   repo safety check, `scripts/deploy/validate-railway-config.mjs`).
2. **Pre-deploy backup proof:** newest `backup written` / `verified yes` line under 26 hours old, and
   `pilot-health-check.mjs` reporting `backup fresh`. A green nightly deployment, a mounted
   `/backups` volume and a `SUCCESS` status each prove nothing [note 2026-10-05]. If the migration
   list in step 4 includes a data-changing migration, also run the restore drill (section 3)
   against that dump first.
3. **Audit the target:** `RAILWAY_TOKEN=<prod token> node scripts/ops/database-safety-audit.mjs`
   (read-only: start command, Postgres not public, what deploying `db-seed` would do, leftover
   authorisation, backups).
4. **Preview the migrations:** `ls apps/api/prisma/migrations` against the deployed commit, and read
   the new ones. Classify using section 4.3.
5. **Deploy api first.** The api service is the single migration executor: its
   `preDeployCommand: npx prisma migrate deploy` runs once per deployment before traffic and a
   non-zero exit fails the deploy. Worker and web services never migrate.
   `RAILWAY_TOKEN=<prod token> node scripts/deploy/railway-deploy-and-wait.mjs api 900`.
   Wait for `GET <api>/api/ready` to answer `"status":"ok"`.
6. **Then the worker**, then customer-web, organizer-web, admin-web, each with the same script.
   Never deploy a web app to a schema its API has not reached.
7. **Verify with facts:** `RAILWAY_TOKEN=<prod token> node scripts/deploy/verify-deployed.mjs`
   (deployed commit versus `origin/main` for every code service, plus a behaviour probe each; exit 1
   on any mismatch). On Windows run `Clear-DnsClientCache` first or the storefront probe lies.
8. **Operational smoke:** `pilot-health-check.mjs`; then the pilot smoke list in
   `docs/pilot/LAUNCH-CHECKLIST.md`.

Repository workflow: `.github/workflows/deploy-railway.yml` is `workflow_dispatch` only for
production (a push to `main` refuses to deploy), gated by `DEPLOY_ENABLED_PRODUCTION`, runs the CI
gate, deploys api, readiness-gates, deploys worker and the three web apps, then a smoke job.
Finding: the workflow still calls `railway up --service ... --ci`, which the repository's own
`railway-deploy-and-wait.mjs` header documents as unreliable (a dropped log stream reports a
failure while Railway keeps deploying and the sequence is abandoned half-way). Switching the
workflow to the script is a small follow-up; it was left alone here because it is the production
deploy path and should be changed with the owner watching.

### 4.2 Pinning a SHA, and the trap

**Changing any Railway variable on a service redeploys the LATEST commit of the tracked branch, not
the running image** [note 2026-10-08]. On 2026-10-08 a "config-only" key change moved UAT from
`771a06b` to main and ran 14 migrations unplanned. Therefore:

- Treat every variable change on production as a **deploy of current main**. Only do it inside a
  deploy window, after steps 1 to 4 above.
- If the change must not deploy: pass `skipDeploys: true` (API/CLI) or use the dashboard's stage
  and review flow, then `redeploy` the **existing deployment id**, which reuses its commit.
- To ship an exact SHA: tag it (`git tag prod-<date>-<sha7> <sha>; git push origin <tag>`), then run
  the workflow with **"Use workflow from" set to that tag**; it checks out and `railway up`s exactly
  that tree. Record the tag in the incident log.
- Auto-deploy on push is a dashboard-only setting; the production policy is "pushes do not deploy".
  Confirm it in the dashboard before the pilot.
- The db-seed cron service is the exception to "redeploy reuses the commit": its container runs at
  the next 02:00 tick with the variables its active deployment captured (section 2.2).

### 4.3 Rollback

Application code rolls back; the database does not. Migrations are forward-only (no down
migrations, `migration_lock.toml` provider postgresql).

| Situation                                                                      | Action                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config or flag problem                                                         | Fix the variable (a deploy of current main, see 4.2) or flip the `FEATURE_*` flag. Do not roll back code.                                                                                                                                                                       |
| Web app regression, schema unchanged                                           | Redeploy the previous web deployment id from Railway (reuses its commit).                                                                                                                                                                                                       |
| API or worker regression, **only additive migrations since the last good SHA** | Redeploy the previous api and worker deployments. The older code ignores the new tables and columns. Order: worker, then api, then web.                                                                                                                                         |
| Regression with a **data-changing or constraint migration**                    | An old image can fail against the new schema. Do not guess: fix forward with a new migration, or restore (below). Decide with the section 4.3 table.                                                                                                                            |
| Data corrupted or a bad migration                                              | Stop api and worker, restore the newest verified dump into a scratch database first (section 3) and compare, then restore with `scripts/restore-db.sh` in a maintenance window. Data since the dump is lost (RPO up to 24h): reconcile payments against the provider dashboard. |

The migrations added in October 2026, classified by reading their SQL [code]:

| Migration                                                                                                                                                                | Kind                                                                                                                          | Old image still works against it?                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| settlement_reversal_attempt, payout_allocation, reversal_reconcile_count, settlement_transfer_attempt, settlement_reconciliation_finding, finding_resolution_disposition | additive tables and columns, foreign keys on new tables                                                                       | Yes                                                                                           |
| refund_platform_fee_share, consent_evidence, event_image_variants, payout_account_versions                                                                               | additive                                                                                                                      | Yes (payout_account_versions: old code simply never writes the version rows)                  |
| `20261007090000_space_belongs_to_venue`                                                                                                                                  | **loosens** `Screen.cinemaId`, `Venue.country`, `Venue.timezone` to nullable; **backfills** `Screen` and `Cinema` with UPDATE | Old code reading a null `cinemaId` can break; the backfill is not reversed. Treat as one-way. |
| `20261007100000_general_admission_zones`                                                                                                                                 | additive tables (SeatZone, ShowZone)                                                                                          | Yes, but old code cannot sell or release general admission zones                              |
| `20261007110000_venue_location_is_answerable`                                                                                                                            | repeats the nullable relaxation                                                                                               | Same as above                                                                                 |
| `20261007120000_a_space_has_named_layouts`                                                                                                                               | backfills `SeatMap.name`, sets it **NOT NULL**, drops the old unique index                                                    | Old code that creates a `SeatMap` without a name **fails**. One-way.                          |
| `20261007130000_ticket_types_reference_seat_zones`                                                                                                                       | additive nullable foreign key                                                                                                 | Yes                                                                                           |

If production is created fresh from the current head (it is empty of events), all of the above
apply on a clean database and the old-image question is academic for the first deploy. It matters
from the second deploy on.

## 5. Environment isolation

| #   | Cross-environment exposure                                                                                    | Source                              | Proof it is fixed (names or fingerprints only)                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | PROD was duplicated from QA: JWT, QR signing, payout encryption keys and Razorpay TEST keys arrived inherited | note 2026-09-25                     | `RAILWAY_TOKEN=<prod> RAILWAY_REFERENCE_TOKEN=<qa> node scripts/deploy/rotate-environment-secrets.mjs --dry-run` reports **zero shared names** (SHA-256 comparison, values never printed). Run it for PROD vs QA and PROD vs UAT.                                                                                                                                                                                          |
| 2   | PROD Postgres password is QA's (an initialised volume ignores `POSTGRES_PASSWORD`)                            | note 2026-09-25; unresolved         | `rotate-environment-secrets.mjs` does **not** cover the Postgres password (it rotates generated secrets only). Compare the password part of PROD's and QA's `DATABASE_URL` as SHA-256 digests, owner-side, and print only "same" or "different". Fix: `ALTER USER` plus a matching `DATABASE_URL`, in a window, after a fresh verified backup. Postgres has no public proxy, which limits exposure but does not remove it. |
| 3   | PROD authenticated to AWS as the SES **QA** user                                                              | note 2026-10-04                     | Section 1.4 step 5. Proof: `aws sts get-caller-identity` from a PROD api shell names `eticketsgo-prod-runtime`; the QA key is deleted in AWS and QA still works with its own key.                                                                                                                                                                                                                                          |
| 4   | PROD `NEXT_PUBLIC_SITE_URL`, `ORGANIZER_WEB_URL`, `ADMIN_WEB_URL`, CORS origins carried QA hosts              | note 2026-09-28                     | Read the five names on PROD (owner) and confirm none contains `qa.` or a generated `up.railway.app` host. `verify-deployed.mjs` probes the storefront's canonical URL.                                                                                                                                                                                                                                                     |
| 5   | UAT payout bank encryption key printed in a transcript                                                        | `docs/ops/UAT-BANK-KEY-EXPOSURE.md` | 0 records protected; rotation awaiting owner approval; independent of PROD.                                                                                                                                                                                                                                                                                                                                                |
| 6   | `ALLOW_UNDELIVERABLE_NOTIFICATIONS=true` on PROD                                                              | note 2026-10-04                     | The variable must be absent before any customer is told SMS works; email path proven by a real receipt.                                                                                                                                                                                                                                                                                                                    |
| 7   | Redis keys: namespaced `etg:<env>:*` from `APP_ENV`, so a shared Redis would not collide                      | code                                | Check `REDIS_URL` host names differ per environment; namespacing is defence in depth only.                                                                                                                                                                                                                                                                                                                                 |
| 8   | Destructive seed on PROD                                                                                      | code                                | `SEED_OPERATION=full-reset` is refused by an allowlist on `APP_ENV` before any DB connection (`destructive-guard.ts`); `database-safety-audit.mjs` reports leftover authorisation.                                                                                                                                                                                                                                         |

Per-environment credentials that must be distinct (names): `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`,
`QR_SIGNING_SECRET`, `PAYOUT_BANK_ENCRYPTION_KEY`, `DATABASE_URL` (and the Postgres password),
`REDIS_URL` password, `PAYMENT_*` provider keys and webhook secrets, `SES_WEBHOOK_SECRET`,
`METRICS_TOKEN`, `SENTRY_DSN` or at minimum `SENTRY_ENVIRONMENT`,
AWS access key pair, Railway project token (one per environment, GitHub environment secrets
`RAILWAY_TOKEN_QA` / `_UAT` / `_PRODUCTION`).

## 6. Observability and alerting

### 6.1 What exists [code]

| Layer       | Detail                                                                                                                                                                                                                                                |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Errors      | Sentry on api and worker (`SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`); PII scrubbed in `beforeSend`. Not set means no-op: confirm production has a DSN.                                                                                     |
| Metrics     | `GET /api/metrics` (bearer `METRICS_TOKEN`; **unset in a deployed environment turns the endpoint off**) and the worker's own `/metrics`: HTTP counts and latency, payment, booking, refund, webhook, queue, outbox, inventory, notification counters. |
| Health      | `/api/health` liveness, `/api/ready` (DB and Redis), `/api/admin/ops/health` (DB, Redis, queue with 24h recent-failure window, and now backup freshness). Worker `/health` and `/ready`.                                                              |
| Alert rules | `observability/prometheus/alerts.yml`, `booking-platform-alerts.yml`, and now `pilot-alerts.yml`. Alertmanager routing is a skeleton with `noop` receivers.                                                                                           |
| Logs        | Railway service logs. Railway drops above 500 lines/second, which can hide the very line explaining a failure [note].                                                                                                                                 |

Gap, stated plainly: no Prometheus or Alertmanager runs on Railway [note; not verified]. The rules
are real and tested for syntax, but **until a Prometheus is scraping `/api/metrics` they page
nobody**. For the pilot there are two honest options: (a) Grafana Cloud or another hosted
Prometheus with a remote scrape of the metrics endpoint, or (b) rely on Sentry alert rules plus the
polled checks below. Option (b) needs no new service and is the minimum.

### 6.2 Pilot alert rules

| Signal                             | Rule (where it lives)                                                                                             | Severity | Notes                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| 5xx                                | `PilotApi5xxBurst`: 5 or more 5xx in 10 min (`pilot-alerts.yml`); existing `HighHttp5xxRate` is a 5% ratio        | page     | A ratio is meaningless at pilot volume: five requests an hour.                                                 |
| Payment webhook signature failures | `PaymentWebhookSignatureRejected`: any `etg_payment_webhooks_total{result="rejected"}` in 15 min                  | page     | The production incident: a paid purchase got HTTP 400 for a secret mismatch.                                   |
| Captured but unconfirmed payments  | `PaymentsSucceededNotConfirmed` (metric) plus query 1 in `scripts/ops/pilot-monitor-queries.sql` (database truth) | page     | The metric can be quiet when the DB is not: run the query daily during the pilot.                              |
| Backup age                         | `GET /api/admin/ops/health` field `backup`; `scripts/ops/pilot-health-check.mjs` exits 1 when stale or never      | page     | Not a Prometheus metric by design (the freshness lives in the database). Run from cron or CI every 6 hours.    |
| Queue failures                     | `PilotQueueFailures`, `OutboxDeliveryFailing` (`pilot-alerts.yml`); ops health `queue.recentFailed`               | warn     | Failures older than 24h no longer paint health red; they stay listed and retryable.                            |
| Payout holds                       | Queries 2 and 3 in `pilot-monitor-queries.sql`                                                                    | warn     | Payouts wait on bank verification by a SECOND staff member (maker-checker). Today QA has only the super admin. |
| API or worker down                 | existing `ApiDown`, `WorkerDown`; Railway deployment failure notification                                         | page     | Also add an external uptime probe on `/api/ready` from outside Railway.                                        |

### 6.3 Who is paged

The escalation matrix (`docs/pilot/ESCALATION-MATRIX.md`) is **unfilled placeholders**; nobody is
paged by anything today. Minimum for the pilot, owner decision: one named primary and one backup
for page-severity alerts, reachable by phone; Sentry alert emails to a shared inbox for warn. Fill
the roster before the first real organizer is invited. Set the Alertmanager receivers
`PAGER_WEBHOOK_URL` and `OPS_WEBHOOK_URL` (names) when a Prometheus exists.

### 6.4 The polled checks (works with no Prometheus)

```sh
# every 6 hours from any scheduler outside Railway (a GitHub Actions cron is enough)
API_URL=https://<api-host>/api ADMIN_TOKEN=<token of an admin with OPS_READ> \
  node scripts/ops/pilot-health-check.mjs        # exit 0 healthy, 1 failing, 2 unreadable

# daily, read-only, from inside the private network
psql "$DATABASE_URL" -f scripts/ops/pilot-monitor-queries.sql    # every query should return zero rows
```

Tests: `cd apps/api && npx jest src/ops` (freshness evaluator, health integration, writer/reader
constants), and `node --test scripts/ops/pilot-health-check.test.mjs`.

## 7. What changed in the repository

- `apps/api/src/ops/backup-freshness.ts` and `.spec.ts`: evaluator, thresholds, evidence names.
- `apps/api/src/ops/ops.service.ts` and `.spec.ts`: `backup` in the ops health, degraded in PRODUCTION.
- `apps/api/prisma/backup.ts`: evidence row written after a verified dump and after a restore drill.
- `scripts/ops/restore-drill.sh`: isolated restore drill with integrity checks and RTO.
- `scripts/ops/pilot-health-check.mjs` and `.test.mjs`, `scripts/ops/pilot-monitor-queries.sql`.
- `observability/prometheus/pilot-alerts.yml`, wired into `prometheus.yml` and
  `docker-compose.observability.yml`.

No payment, payout, refund, auth, inventory or seat-lock code was touched.

## 8. Owner actions and blockers

| #   | Action                                                                                                               | Blocks                            |
| --- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 1   | Create the production IAM principal, the live payment secrets, and set the five variables (section 1.4).             | Production boot and live payments |
| 2   | Make one clean redeploy of PROD `db-seed`; read the next 02:05 UTC log; enable Railway volume backups (section 2.4). | Any production deploy             |
| 3   | Decide and fund an off-platform dump copy; provide a write-only credential.                                          | Disaster recovery                 |
| 4   | Rotate the PROD Postgres password and run the isolation comparison (section 5 rows 1 and 2).                         | Production credibility            |
| 5   | Name the page roster, then stand up a Prometheus (or accept polled checks only) and wire the receivers.              | Anyone being told of an incident  |
| 6   | Approve switching `deploy-railway.yml` to `railway-deploy-and-wait.mjs`.                                             | Reliable production deploy        |
| 7   | Supply a PROD dump (or approve a scratch environment) to measure the real RTO.                                       | A proven RTO                      |
| 8   | Confirm dashboard auto-deploy for production is off.                                                                 | An unplanned deploy               |
