# QA certification, 2026-11-06

**Deployed to QA only.** UAT and production were not touched.

## What runs on QA

| Service       | Commit     | Deployment                                              | Rollback to (previous) |
| ------------- | ---------- | ------------------------------------------------------- | ---------------------- |
| api           | `7db8088d` | `65b9018e` (redeployed `12:29Z` for the failover check) | `d79ff407` (6153d6aa)  |
| worker        | `7db8088d` | `0870ca02`                                              | `216774c9` (6153d6aa)  |
| customer-web  | `7db8088d` | `69c394e9`                                              | `9970712c` (be2a2c7f)  |
| organizer-web | `7db8088d` | `4cc953b8`                                              | `0db19211` (646e469f)  |
| admin-web     | `7db8088d` | `9528dc40`                                              | `d48363be` (646e469f)  |

`7db8088d` = `main` at `84f6ec56` (#585-#589) plus #591 (fee override approval), #592 (web
runtime config) and #593 (pool + QA replicas), merged on branch `qa/integration-2026-11-06`.
Draft PR #594 ran the full CI on that exact commit: green. #591-#593 are NOT merged to `main`.
`/api/health` reports `build.sha = 7db8088d...`. The images were built by Railway from source,
so there is no registry digest (image promotion needs AR-20 first).

**Migrations applied on QA:** `20261106100000_fee_schedule_approval` (#585) and
`20261106120000_fee_policy_approval` (#591), both additive.
`check-migration-compat.mjs`: 0 findings.

**Variables set on QA** (api and worker, with `skipDeploys`): `DATABASE_POOL_SIZE=10`,
`DATABASE_POOL_TIMEOUT_SECONDS=10`.

### Rollback

`deploymentRollback(<previous id above>)` per service, api last. This restores each service's
previous image and variable snapshot. The two migrations stay; both are additive. The previous
api ignores the new columns. Its policy create/deactivate would be refused by the new trigger,
which fails closed (see FEE-SCHEDULE-APPROVAL.md). Then remove the `environments.QA` block and
unset the two pool variables.

## Replicas and Postgres

| Measure                                                                       | Value                                                                                         |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| api replicas answering (`/admin/ops/database`, distinct `RAILWAY_REPLICA_ID`) | **2** (`5a31ffce`, `aa76a6f3`)                                                                |
| Resolved manifest                                                             | base `numReplicas: 1` + `environments.QA` `multiRegionConfig.us-west2.numReplicas: 2` (AR-25) |
| QA Postgres `max_connections` / reserved                                      | 500 / 3                                                                                       |
| Client connections in use                                                     | 10-12, **2.4 %**                                                                              |
| Pool per process                                                              | 10 (`DATABASE_POOL_SIZE`), 10 s timeout                                                       |
| Budget                                                                        | 2 api x 10 + worker x 10 = 30 at most, of 497                                                 |

**Failover:** 6 clients sent requests for 11 minutes while the api was redeployed at the same
commit. **25,031 requests, every one answered by a running replica: 0 errors, 0 5xx, 0
connection failures**, p95 64 ms, max 735 ms. 21,431 of them were `429`. The run came from one
address, and the Redis-backed limiter is shared across both replicas (about 327 per minute were
allowed), so this measures availability, not capacity. Overlap/draining are still unset (AR-22).

## Two-person fee approval (two separate QA admins, each signed in with password + TOTP)

| Step                                                                             | Result                                                   |
| -------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Schedule (AUD): draft, save +1.00, submit                                        | PASS                                                     |
| Old one-person publish                                                           | **409** `FEE_SCHEDULE_APPROVAL_REQUIRED`                 |
| Maker (super admin) approves own draft                                           | **403** `NOT_INDEPENDENT`                                |
| Checker sees impact, approves -> published v1                                    | PASS                                                     |
| Restored by a second approved cycle -> v2, fees equal the original (fingerprint) | PASS                                                     |
| Override (event waiver on a paused QA event): created                            | `PENDING_APPROVAL`                                       |
| Creator (super admin) approves                                                   | **403** `APPROVER_IS_MAKER`                              |
| Checker approves                                                                 | `ACTIVE`                                                 |
| Switch-off request by maker                                                      | still `ACTIVE`, request recorded                         |
| Requester approves own switch-off                                                | **403**                                                  |
| Checker approves switch-off                                                      | `INACTIVE`                                               |
| History                                                                          | `CREATED, APPROVED, DEACTIVATION_REQUESTED, DEACTIVATED` |

The checker was given `FEE_SCHEDULE_APPROVE` for the test and set back to `EVENT_REVIEW`
afterwards (both changes are in the audit log).

## Regression journeys (`scripts/pilot/pilot-cert.mjs`, all stages)

**65 PASS, 0 FAIL, 4 BLOCKED**, against QA's two replicas. Covered:

- infrastructure and health;
- organizer registration, legal identity, bank account (masked, unverified), and admin approval;
- an event created, reviewed and published;
- a customer quote; real Razorpay TEST Netbanking payments confirmed through the live webhook;
  a gateway failure followed by a successful retry;
- the ticket wallet with signed QR codes; the in-app confirmation; the notification delivery
  record;
- check-in: admit, duplicate, tampered, wrong session, other tenant;
- refunds (organizer approve/reject), with inventory returned; hold expiry;
- forged webhook and forged checkout confirmation refused;
- finance reconciliation: 0 discrepancies;
- 10 authorisation refusals (staff cannot change an organizer's bank account, legal identity,
  payouts or events; cross-tenant reads refused);
- payout position and hold terms;
- double-submit and double-refund protection.

BLOCKED (not failures):

- COM-4: inbox delivery cannot be observed for a `.test` address.
- PAYOUT-4: the payout comes due only after the show ends (13:08Z), so it is re-run then.
- F-RF-1: Razorpay test mode cannot make a refund fail on demand.
- F-WH-3: a genuine duplicate signed webhook needs the webhook secret, which this run does not
  read.

Smoke test (`qa-smoke-test.sh`): 15/15 before and after.

Web runtime config on QA: each app's `/runtime-config.js` answers 200 with QA's own values.

## Not verified on QA (and why)

- Sentry: no DSN on QA (`SENTRY_DSN` unset), so nothing reports yet (AR-16).
- Image promotion: needs registry access (AR-20); `promote-image.mjs` was not applied.
- Overlap/draining: not configured (AR-22).
