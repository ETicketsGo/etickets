# Production deployment request: api + worker to `73e2ff03` (2026-10-25)

**Status: prepared, NOT approved, NOT run.** Nothing in this document has touched production.

## 1. What and why

| Service       | From                    | To         | Required? | Why                                                                       |
| ------------- | ----------------------- | ---------- | --------- | ------------------------------------------------------------------------- |
| api           | `2439e254` (`ab71fb7e`) | `73e2ff03` | yes       | Readable support references, privacy v2 registry (consent records), fixes |
| worker        | `2439e254` (`a2566b03`) | `73e2ff03` | yes       | Imports `@eticketsgo/api`: sends the new support emails                   |
| admin-web     | `2439e254` (`da92a8ac`) | `73e2ff03` | optional  | Shows the reference in the support inbox and searches by it               |
| customer-web  | `62d6d453` (`7305672b`) | `73e2ff03` | optional  | Contact form shows the reference after sending                            |
| organizer-web | `2439e254`              | -          | no        | No change                                                                 |
| db-seed       | `311ebb79`              | -          | never     | Backup cron; never deploy                                                 |

## 2. Accumulated changes since `2439e254` (api/worker runtime)

PRs merged since production's api commit: #461, #476, #477, #478, #479, #480, #482-#487. Most
are the Android app, the website and docs, which do not run in the api or worker. The api and
worker runtime gets:

| PR   | Change                                                                                                                                                              | Behaviour on PROD after deploy                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| #478 | Account deletion also clears `User.phone` and `phoneVerifiedAt`                                                                                                     | Deleted accounts no longer keep a phone number                                                                               |
| #479 | Play Integrity as a second proof in the human check; Sentry scrubs the bot-check headers                                                                            | **None until configured:** `PLAY_INTEGRITY_*` unset and `TURNSTILE_MODE` off on PROD                                         |
| #484 | Shared policy registry: PRIVACY v2 current, v1 superseded                                                                                                           | New marketing-email consent records cite `PRIVACY/<market>/v2` (fixes PV1)                                                   |
| #487 | Support references `ETG-SUP-YYYY-NNNNNN`; emails show the reference (subjects too) and link by it; boot WARNING when an email base URL is a `*.up.railway.app` host | Customers see `ETG-SUP-2026-0000NN` instead of a database id. The WARNING will name the three URL variables until E4 is done |

No change to bookings, payments, Razorpay, refunds, payouts, pricing, auth flows, MFA or SMS
sending. Exact list: `git diff --stat 2439e254 73e2ff03 -- apps/api/src apps/worker/src packages`
(29 api files; worker none; packages: `legal.ts`, i18n `emails.json` en/fr-CA, `web-kit/api.ts`).

## 3. Database migration review

One migration: `apps/api/prisma/migrations/20261025120000_support_request_reference`.

- Additive only: nullable `Feedback.reference` + unique index + shape CHECK; new table
  `ReadableReferenceCounter`; SQL function `etg_next_reference_value`; a `BEFORE INSERT`
  trigger on `Feedback` that fills `reference` only when it is NULL.
- Backfill: numbers existing `Feedback` rows per year by `createdAt`, only where `reference IS
NULL` (idempotent), then sets each year's counter to the highest number used.
- Size: `Feedback` on PROD is small (a handful of support messages); runs in the api's
  preDeploy (`prisma migrate deploy`) inside one transaction.
- Proven: on QA 2026-10-25 (19 rows backfilled, next new `ETG-SUP-2026-000020`); in CI (drift
  check) and a real-Postgres integration test (20 parallel inserts, year rollover, backfill
  re-run updates 0 rows).
- **Backward compatible:** the old image (2439e254) running against the migrated database
  keeps working: it does not know the column, and the trigger numbers its inserts. So a
  rollback needs **no down-migration**.

## 4. Gates before the first write

1. Owner approval of this document (api + worker, and whether admin-web/customer-web go too).
2. `git rev-parse origin/main` is still `73e2ff03...`, or re-review the diff.
3. INC2 (cause of the 2026-10-25 removal) understood, so the deploy is not undone by the same
   cause mid-way.
4. **Fresh verified backup** with the kit's `predeploy-backup.sh` (inside the Postgres
   container over SSH). Proceed only on `RESULT: restored copy matches live on every table`.
   Last nightly backup: `etg-production-2026-10-25T02-00-04-819Z.dump`, verified.
5. Kit read-only checks: `state.mjs PROD`, `triggers.mjs PROD` (auto-deploy off, no triggers).

## 5. Procedure (kit `C:/etg-wt/prod-deploy-kit`, from the repo checkout)

```
SHA=73e2ff0321f3e8b8d3932953c624835e51034fcb
CONFIRM_PROD_DEPLOY=api@$SHA    node $K/deploy-pinned.mjs PROD api    $SHA   # runs the migration
CONFIRM_PROD_DEPLOY=worker@$SHA node $K/deploy-pinned.mjs PROD worker $SHA
# optional:
CONFIRM_PROD_DEPLOY=admin-web@$SHA    node $K/deploy-pinned.mjs PROD admin-web    $SHA
CONFIRM_PROD_DEPLOY=customer-web@$SHA node $K/deploy-pinned.mjs PROD customer-web $SHA
```

Verify (read-only plus one support message): `/api/health`, `/api/ready`; api logs show the
migration applied and the Railway-host WARNING lines; `POST /api/support` returns a
`reference` `ETG-SUP-2026-...`; the support inbox mail subject carries it; admin search finds
the 2026-10-25 test request by its new reference AND by `cmvncaxg10015uo2zxo94825e`;
`seo-check.mjs` 23/23; capabilities unchanged (`humanCheckMode: off`, phone sign-in US/CA).

## 6. Rollback

`rollback.mjs PROD <service> <deploymentId> <commitPrefix>` restores the old image and its
variable snapshot, no rebuild:

| Service      | Roll back to                                      |
| ------------ | ------------------------------------------------- |
| api          | `ab71fb7e-734e-44e1-8bbc-5380a1d1ebbc` `2439e254` |
| worker       | `a2566b03-933c-4ff8-9b80-225cf2df5ce6` `2439e254` |
| admin-web    | `da92a8ac-2772-460a-8fc1-41016aad3981` `2439e254` |
| customer-web | `7305672b-bdf1-4573-a99b-a34e96776639` `62d6d453` |

The migration stays (compatible with the old image, section 3). References already issued stay
on their rows. Data restore from the pre-deploy backup is the last resort only.

## 7. Risks

- Low: a failed migration fails the api deploy before traffic moves (preDeploy), the old
  deployment keeps serving.
- The boot WARNING lists URL variables until E4 is done (expected, harmless).
- After deploy, new consent records cite PRIVACY v2 (intended).
