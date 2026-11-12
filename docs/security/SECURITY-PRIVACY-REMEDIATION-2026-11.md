# Security, privacy and DR remediation (2026-11)

|          |                                                                                                                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline | [`DATA-RESIDENCY-PRIVACY-AUDIT-2026-11-12.md`](DATA-RESIDENCY-PRIVACY-AUDIT-2026-11-12.md). Owner decision: CONDITIONAL GO; keep the single shared Postgres in Railway us-west2; no regional databases. |
| Scope    | The audit's P0 and P1 findings                                                                                                                                                                          |
| Status   | Code in PRs #649–#653 (open, not merged). Nothing has been deployed to production, and no production data, credentials or settings have changed.                                                        |

Every production step below needs **explicit owner approval**. Each one is listed with its rollback.

## 1. Plan and dependency order

| #   | Workstream                                                                          | PR      | Depends on                      | Production effect when deployed                                                                    |
| --- | ----------------------------------------------------------------------------------- | ------- | ------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | Payment data: redact payer details on write, backfill tool, exception-log redaction | #649    | —                               | **Active immediately** for NEW webhook rows. No flag.                                              |
| 2   | Tenant isolation regression suite and static route guard                            | #653    | —                               | Tests only                                                                                         |
| 3   | Least-privilege DB logins (`etg_app`, `etg_readonly`) plus `APP_DATABASE_URL`       | #650    | —                               | None until the roles are applied AND the variable is set                                           |
| 4   | Encrypted off-platform backups plus an outside-Railway restore drill                | #651    | Owner: bucket and key           | None until `BACKUP_OFFSITE_BUCKET` is set                                                          |
| 5   | Auth-record retention purge plus complete account-deletion scope                    | #652    | —                               | Deletion scope is active immediately. Purge is a **dry run** until `RETENTION_PURGE_ENABLED=true`. |
| 6   | Privacy notice, grievance, incident response and Sentry docs                        | docs PR | Owner: contact details, counsel | None                                                                                               |

**Order to activate in production:**

1. Deploy #649, #652 and #653 (code only).
2. Run the webhook backfill, dry run first, then apply.
3. Apply the DB roles, then switch `APP_DATABASE_URL`.
4. Off-site backups: owner creates the bucket and key.
5. Enable the retention purge after reviewing a week of dry-run counts.
6. Set the Sentry DSN.

Steps 2–6 are independent of each other and each needs its own approval.

## 2. Changes (focused PRs)

### #649: payment webhook payloads (P0)

- **Redaction on write.** `payload-redaction.ts` is a deny-list applied at any depth, case-insensitive:
  - removed: email, contact, phone, name, VPA/UPI, card, bank account, billing/customer/shipping details, connected-account owner (individual, company, business_profile, external_accounts), IP and user agent;
  - kept: ids, amounts, currency, status, timestamps, error codes and reasons, `acquirer_data` (RRN / bank reference used in disputes), and our own `notes` / `metadata`, which hold internal ids only.
- **Tamper evidence and idempotency unchanged.** `payloadHash` still hashes the raw signed body, and the `(provider, providerEventId)` idempotency key is unchanged.
- **Why a deny-list.** An allow-list that missed a field would silently stop confirming paid bookings. A deny-list can only remove fields nothing reads. A test runs the real Razorpay processor over the full and the redacted copy of the same event and asserts identical calls.
- **Backfill: `SEED_OPERATION=redact-webhooks`.**
  - Dry run unless `WEBHOOK_REDACT_APPLY=true`.
  - Touches settled rows only (never RECEIVED or PROCESSING); writes are conditional on status.
  - **Never deletes.** Prints counts only.
  - Needs the usual expiring operation window.
- **Retention rule.** Redacted payloads hold no personal data and are kept like other financial records. This supports reconciliation, refunds, disputes and the DPDP Rule 8(3) one-year processing-log minimum from 13 May 2027. No row is deleted.
- **Exception logs.** Serialised exceptions now redact personal field names (email, phone, OTP, UPI, holder, buyer) as well as credentials.
- **Follow-up (not done).** `BillingWebhookEvent` (organizer subscriptions; paid billing is off) gets the same treatment before billing is enabled.

### #650: least-privilege database logins (P0)

- **The problem (verified on PROD).** Every service connects as `postgres`, the cluster superuser and the only login role.
- **`etg_app`** (api + worker): may SELECT, INSERT, UPDATE and DELETE rows and use sequences.
  - May not: run DDL, TRUNCATE, create roles or databases, bypass RLS, write `_prisma_migrations`, or read server files.
  - Also granted `pg_read_all_stats`, so the ops connection dashboard stays accurate.
- **`etg_readonly`** (audits, fingerprint, support): SELECT only, with `default_transaction_read_only=on` and a 30 s statement timeout.
- **`postgres` is unchanged.** It stays the owner, the migration credential (api preDeploy) and the db-seed credential.
- **Future tables.** `ALTER DEFAULT PRIVILEGES` grants on tables that future migrations create.
- **Passwords.** They are set from a SCRAM-SHA-256 verifier computed client-side, so the plaintext never reaches SQL, `pg_stat_activity` or logs.
- **Runtime credential.** The runtime connects with `APP_DATABASE_URL` when set; `DATABASE_URL` stays the owner, used only by `prisma migrate deploy` and db-seed.
  - No deploy-config, IaC or preDeploy change.
  - **Unset gives exactly today's behaviour; removing the variable is the rollback.**
- **Evidence.**
  - Integration test on Postgres 16 (17 tests): login through the verifier, row access, advisory locks, stats, a table created after the grants, and refusal of every structural operation.
  - Validated on **QA's real schema** (141 tables). The app role read `User`, `Booking` and `WebhookEvent`, saw connection stats, and was refused CREATE, DROP, TRUNCATE, ALTER, CREATE ROLE, `_prisma_migrations` writes and `pg_read_file`. See the incident note in section 3.
- **Tenant isolation at database level (RLS): deferred, deliberately.**
  - It would need a per-request `SET app.organization_id` through Prisma's pool (an interactive transaction per request, or a client extension) and policies on about 60 tenant tables.
  - That is a multi-week change with real regression risk to booking and payment paths.
  - The app-layer checks are now pinned by #653 (no gap found in about 225 routes).
  - Revisit RLS when there is a second engineer or before onboarding enterprise organizers.

### #653: tenant isolation (P0 validation)

- **57 service-level tests:** organizer B is refused organizer A's bookings, attendees and CSV export, payments and refunds, payouts and settlements, receipts, check-in, coupons, and reports and analytics. Each test also proves nothing protected was read before the refusal. Making B a member of A breaks 36 of them, which proves they actually test isolation.
- **Static guard:** a new signed-in route that does not pass the caller to an access check fails the build. Allowlist entries carry reasons, and stale entries fail.
- **No CONFIRMED or SUSPECTED cross-tenant gap.**
- **Not verified:**
  - tests run against a Prisma stand-in, not over HTTP;
  - data created before the venue backfill could pair a venue and a cinema from different organizers (needs a read-only data check).

### #651: off-platform backups (P0)

See section 4.

### #652: retention and deletion (P1)

- **Worker purge** (on the existing daily `prune-tokens` job): expired PhoneOtp, EmailVerificationCode, PasswordResetToken, AuthHandoff and GuestBookingAccess rows more than `AUTH_RECORD_RETENTION_DAYS` (default 30) past expiry or use.
  - Batched; logs counts only.
  - **Dry run unless `RETENTION_PURGE_ENABLED=true`.**
  - Not purged:
    - AccountInvitation (record of who invited whom);
    - TicketInvite (transfer ledger);
    - AdminMfaRecoveryCode (no expiry).
- **Account deletion now also anonymises:**
  - MarketingConsent subject (rows kept as consent evidence);
  - TicketInvites addressed to the user;
  - Feedback email;
  - guest bookings and their tickets under the user's **verified** email.
- **The verified-address rule.** Rows keyed by an address are scrubbed only when the account proved that address. Otherwise anyone could sign up with a stranger's email and wipe their guest bookings.
- **Audit row.** The deletion audit row no longer stores IP or user agent.
- **Financial records are kept.** Booking amounts, payments, refunds, receipts and invoices, payouts, settlements and tax data stay untouched, as required by:
  - India CGST Act s.36 (72 months);
  - Companies Act s.128 (8 years);
  - US IRS guidance (3–7 years).
    Counsel to confirm.
- **Known residue (follow-up):**
  - MarketingConsent IP and user agent;
  - Feedback message text and metadata;
  - Feedback sent while signed out under the same email;
  - GuestBookingAccess links on anonymised bookings (expire and are then purged);
  - webhook payloads until the #649 backfill runs.
- **Note.** `User.emailVerifiedAt` is set only when a phone-first account adds an email. Ordinary email sign-ups are not verified, so the guest-booking clean-up seldom applies. Verifying email at sign-up would close that gap (product decision).

## 3. QA and regression evidence

| Area                                                        | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook redaction + processors (Razorpay + Stripe suites)   | 105 passed; exception filter 6 passed                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| DB roles: pool resolution + operation allow-list            | 29 passed; integration on Postgres 16: 17 passed                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Off-site backup + crypto + drill selection                  | 49 passed (real AWS SDK against an in-process S3 server)                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Retention + deletion                                        | 61 targeted; 397 across `src/users` + `src/auth`                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Tenant isolation                                            | 57 + 4 static guard; 94 with existing route-policy specs                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Type-check (`tsc --noEmit`, api; worker via the api source) | Clean                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| CI on each PR                                               | See PR checks (full API suite, Postgres integration, module graph)                                                                                                                                                                                                                                                                                                                                                                                                                 |
| QA environment                                              | Combined branch `qa/security-2026-11` (474a4ccb) deployed to QA api + worker: both SUCCESS, api boots on both replicas with `credential DATABASE_URL` (unchanged), `qa-smoke-test.sh` 14 passed / 0 failed / 4 skipped (payment dashboards, metrics token). Roles validated on QA's schema. Read-only count: 473 of 475 settled QA payment webhook rows hold payer fields (the backfill's target). CI green on #649-#654 (#650 after one rerun of the known-flaky india-gst spec). |

**QA incident (2026-11-12, contained).**

- **What happened.** While validating the roles on QA I meant to run inside a transaction and roll back. A generated psql meta-command lost its backslash and merged with `BEGIN`, so the statements ran in autocommit. QA then held `etg_app` / `etg_readonly`, with random passwords that were never stored.
- **How it was contained.** I removed both roles within minutes (`DROP OWNED` + `DROP ROLE`) and verified:
  - 0 roles left;
  - 0 default-ACL entries;
  - the stock public-schema ACL;
  - `postgres` is the only login role again.
- **What it did not touch.** No data changed: every write in the test was refused or matched no rows. Production was not touched.
- **Lesson.** Pass `-v ON_ERROR_STOP=1` on the command line and assert that the transaction opened, rather than trusting generated SQL.

## 4. Backup and disaster-recovery design

**Today (verified):**

- `db-seed` takes a nightly `pg_dump -Fc` at 02:00 UTC to a volume and verifies it with `pg_restore --list`.
- It keeps 14 dumps and runs an in-Railway restore drill.
- All of it sits in the same Railway project and region (us-west2) as the database.
- Off-site copy: OFF.
- Railway Postgres has no point-in-time recovery here.

**Target:**

| Item               | Design                                                                                                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Off-platform store | **AWS S3 `ap-south-1`**, in a bucket used only for this (or a separate AWS account), outside Railway's failure domain. Also keeps a copy of Indian data in India, a hedge for CERT-In and possible future DPDP s.16 or SDF requirements. Cloudflare R2 works equally well through `BACKUP_OFFSITE_ENDPOINT`. |
| Encryption         | Client-side AES-256-GCM (#651), **required in production**; the key lives in the password manager and on db-seed only. Plus SSE-S3 or SSE-KMS at rest.                                                                                                                                                       |
| Write path         | IAM user `etg-backup-writer`: `s3:PutObject` on the prefix only (no List, Get or Delete). `If-None-Match: *` means an object is never overwritten.                                                                                                                                                           |
| Immutability       | S3 versioning plus **Object Lock (governance, 35 days)**. Ransomware or a leaked writer key cannot delete history.                                                                                                                                                                                           |
| Frequency          | Nightly now. **Recommended: every 6 hours** (`0 */6 * * *` on db-seed). The database is 19 MB, so each run takes seconds and costs nothing extra.                                                                                                                                                            |
| Retention          | Local: 14 dumps (unchanged). Off-site: lifecycle expiry 90 days, plus Object Lock 35 days. Monthly copies for 12 months can be added with a second prefix if the accountant wants them.                                                                                                                      |
| **RPO**            | 24 h today, **6 h** with the 6-hourly schedule. Point-in-time recovery would need WAL archiving (not offered on this Railway Postgres; out of scope).                                                                                                                                                        |
| **RTO**            | **About 2 h** for a total Railway loss: new Postgres (Railway or elsewhere), restore the newest off-site dump (minutes at 19 MB), point the services at it, redeploy, and re-point DNS (GoDaddy). About 30 min if only the database is lost and the project survives.                                        |
| Restore test       | **Monthly**, from outside Railway: `prisma/offsite-restore-drill.ts` with the read-only IAM user. It checks the SHA-256, decrypts, runs `pg_restore --list`, and restores into an EMPTY scratch database (it refuses a non-empty one) and counts core-table rows. The nightly in-Railway drill stays.        |
| Monitoring         | The existing freshness signal alerts when the off-site copy is older than `BACKUP_OFFSITE_MAX_AGE_HOURS` (26 h; set to 8 h with 6-hourly backups).                                                                                                                                                           |

**Owner steps** (nothing here has been done):

1. Create the bucket in `ap-south-1`, with Block Public Access, versioning and Object Lock.
2. Create two IAM users: the writer (Put only) and the reader (Get and List, for drills).
3. Generate the key and **store it in the password manager first**.
4. Approve setting these on PROD db-seed: `BACKUP_OFFSITE_BUCKET`, `_REGION`, `_ENCRYPTION_KEY`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (writer). Set `BACKUP_OFFSITE_BUCKET` on api.
5. After the first upload, run the off-platform drill once with the reader credentials.

## 5. Incremental monthly cost

| Item                                                                                                                        | Monthly cost                                                  |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| S3 ap-south-1: about 120 dumps of under 1 MB (6-hourly × 30 days) plus versions; KMS optional ($1/key)                      | **< $1** (R2: $0 within the 10 GB free tier)                  |
| DB roles, redaction, retention, deletion, tests                                                                             | $0                                                            |
| Sentry: Developer plan (5k errors/month)                                                                                    | $0. Team plan $26 only if volume demands.                     |
| 6-hourly backups (seconds of db-seed CPU)                                                                                   | about $0                                                      |
| CERT-In 180-day log retention, **if counsel says it applies to us**: ship api and worker logs to S3 or R2, or a log service | $0–25 (decide after counsel)                                  |
| **Total**                                                                                                                   | **About $0–2/month**, up to about $30 with the optional items |

## 6. Questions needing external confirmation

| #   | To                    | Question                                                                                                                                                                                                                 |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Counsel (India)       | Do the CERT-In Directions (28 Apr 2022) require us to keep 180 days of ICT logs **within India**, or is "produce on request" enough? It decides whether logs are shipped to Mumbai.                                      |
| 2   | Razorpay (in writing) | As a merchant storing only order/payment ids, amounts and status, are we outside the RBI 6 Apr 2018 storage circular (DPSS.CO.OD No.2785) and its FAQ? Does our merchant agreement pass any storage obligation on to us? |
| 3   | Counsel (India)       | DPDP Rule 8(3) one-year minimum retention (from 13 May 2027) versus erasure on request: confirm that keeping anonymised financial records and redacted payment events satisfies both.                                    |
| 4   | Counsel (India + US)  | Financial-record retention periods to configure (CGST s.36, Companies Act s.128, IRS), and whether a buyer's name must stay on a tax invoice after account deletion.                                                     |
| 5   | Counsel               | Which entity is the contracting seller per market (already open in `docs/compliance/LEGAL-REVIEW-QUESTIONS.md`); it names the data fiduciary or controller in the notice.                                                |
| 6   | Counsel               | Wording of the cross-border processing disclosure (US hosting; email via AWS Mumbai) for India and the US.                                                                                                               |
| 7   | Owner                 | Grievance officer name and contact, privacy email, and registered addresses for the notice (never invented).                                                                                                             |
| 8   | AWS                   | Confirm Object Lock (governance) on the chosen bucket and the account's support plan for restore help.                                                                                                                   |

**Regulatory basis (official sources):**

- DPDP Rules 2025, G.S.R. 846(E). Most obligations start **13 May 2027**: [MeitY](https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf), [PIB](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2190014).
- Until then, the SPDI Rules 2011 apply.
- CERT-In 6-hour reporting: [CERT-In Directions](https://www.cert-in.org.in/PDF/CERT-In_Directions_70B_28.04.2022.pdf).
- RBI: [storage FAQ](https://www.rbi.org.in/commonman/english/scripts/FAQs.aspx?Id=2995), [PA Master Directions 2025](https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=12896).
- US: [FTC Act s.5](https://www.ftc.gov/legal-library/browse/statutes/federal-trade-commission-act), state breach laws, [CAN-SPAM](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business).

## 7. Production deployment and rollback plan

**Before any step:**

- Take the predeploy backup (`predeploy-backup.sh`, restore-checked).
- Take a read-only fingerprint (`prod-fp.sql`).
- Record the current deployment ids for rollback.
- No migrations are in any of these PRs, so the fingerprint must be **identical** afterwards.

| Step | Action                                                                                                                                                                                      | Verify                                                                                                                                                                                                                      | Rollback                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| A    | Merge #649, #652, #653 (#650 and #651 can merge too; inert until configured). Deploy **api** then **worker** at the merge commit (`deploy-pinned.mjs`).                                     | `/health` and `/ready`; boot log `credential DATABASE_URL`; fingerprint identical; next Razorpay webhook row has `[redacted]` in place of payer fields (count query); worker log shows a dry-run purge count.               | `rollback.mjs` to the recorded deployment ids. Code-only, so instant.                                                       |
| B    | `redact-webhooks` **dry run** on PROD, review counts, then **apply** (separate approval).                                                                                                   | `REDACT_WEBHOOKS_JSON`: about 120 rows redacted; re-run shows 0 holding personal data; payments, refunds and settlements reconcile as before.                                                                               | Restore the affected payloads from the step-B predeploy dump (they are redacted copies, not deletions).                     |
| C    | `db-roles` dry run, then apply. Set `APP_DATABASE_URL` on api and worker (using the set-var procedure that avoids the variable-change-deploys-main trap), then redeploy at the same commit. | Boot log `credential APP_DATABASE_URL`; `select current_user` is `etg_app` in a connection count; booking, payment and refund smoke on PROD **without charges** (free event or read paths only); ops dashboard connections. | Delete `APP_DATABASE_URL` and redeploy (back to `postgres`). Roles can stay, or be dropped with `DROP OWNED` + `DROP ROLE`. |
| D    | Off-site variables on db-seed (owner bucket and key).                                                                                                                                       | Next run: `BACKUP_JSON.offsite.status=uploaded` and `.enc` key; off-platform drill passes.                                                                                                                                  | Unset `BACKUP_OFFSITE_BUCKET`.                                                                                              |
| E    | After 7 days of dry-run counts: `RETENTION_PURGE_ENABLED=true` on worker.                                                                                                                   | Next daily run deletes only eligible rows; counts match the dry run.                                                                                                                                                        | Unset the variable (deleted rows are expired credentials with no business value; covered by the nightly dump).              |
| F    | `SENTRY_DSN` on api and worker (see `docs/ops/SENTRY-MONITORING.md`).                                                                                                                       | Test exception appears scrubbed.                                                                                                                                                                                            | Unset.                                                                                                                      |

## 8. Recommendation

**Code: GO for review and merge.**

- All five PRs are focused, tested, inert or reversible by configuration, and free of migrations.
- Only #649's redaction-on-write and #652's deletion scope take effect on deploy, and both are covered by tests that pin payment, refund and financial behaviour.

**Production: CONDITIONAL GO, step by step (section 7).**

- **Before scale or marketing:** steps A–D.
- **Counsel first:** questions 1–2.
- **Notice and grievance before launch:** owner contact details (question 7).
- **Stays NO-GO:** a Canada or Quebec launch (unchanged from the audit).
