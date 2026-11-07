# UAT readiness and release plan (November 2026)

Prepared 2026-11-07. **Nothing here has been deployed to UAT.** Each stage needs the owner's
separate approval. Stages are deliberately separate: a security fix, a configuration migration
and a feature release are never combined.

## 1. UAT today (read 2026-11-07)

| Service       | Deployment | Commit     | Notes                                                           |
| ------------- | ---------- | ---------- | --------------------------------------------------------------- |
| api           | `60894f73` | `2439e254` | asleep; `APP_ENV=UAT`; no `MFA_ENCRYPTION_KEY`; no Sentry       |
| worker        | `95a24f9b` | `2439e254` |                                                                 |
| customer-web  | `db06d652` | `2439e254` | next **15.5.27**; public on `customer-web-uat.up.railway.app`   |
| organizer-web | `e43f6a84` | `2439e254` | next **15.5.27**; public on `organizer-web-uat.up.railway.app`  |
| admin-web     | `13734138` | `2439e254` | next **15.5.27**; public on `admin-web-uat-7af7.up.railway.app` |
| db-seed       | `be33adf2` | `8fe4c5d5` | nightly backup                                                  |

All on deployments from 2026-10-25. `2439e254` is 339 commits and 24 migrations behind `main`.
Every service still uses the legacy config files, and the services' own settings are empty
(AR-48).

## 2. Stage A: Next.js security fix (approval needed; can go first, any day)

- Commit `a8bfd56b` on `release/hotfix-next-15.5.28-2439e254`: `2439e254` + `next` 15.5.28.
  The cherry-pick of #596 conflicted (the base predates later dependency changes) and was
  resolved by keeping `2439e254`'s files and moving only `next`, `@next/env` and
  `@next/swc-*` (10 resolved packages; sharp stays 0.35.5; the lockfile is stable under
  `npm install --package-lock-only`). Same 5 files as the PROD hotfixes.
- Deploy customer-web, organizer-web, admin-web only, one at a time, with the guarded tool used
  for PROD (`deploy-hotfix.mjs UAT <svc> a8bfd56b...`: parent must equal the running commit,
  only the five dependency files may change).
- **Never push to that branch again** (AR-44): at this base, a push to `release/**` deploys UAT
  through the old workflow. The 2026-11-07 push started such a run; it was cancelled in its CI
  gate, before any deploy step.
- Verify as in PROD: `next` 15.5.28 inside each container, health, pages, safe image request.

## 3. Stage B: Railway IaC migration, proposed 2026-11-16 (approval needed)

`docs/deployment/RAILWAY-IAC-MIGRATION.md` section 6, settings first:

- The dry run on 2026-11-07 lists 26 settings, each equal to what the legacy files supply.
- The preview shows no behavioural difference and no variable deletion.
- No database or Redis change.
- **No deployment**, and no code change.
- **Paths stay set** on 11-16 (runbook step 6): every UAT commit still has a repo-root
  `railway.json`, which would override the settings once the path is cleared (trap 3). The paths
  are cleared after stage C, when UAT runs `main`; the script refuses before that.

Ready check on the day: step 1 and step 3 outputs unchanged from 2026-11-07.

## 4. Stage C: release `main` to UAT, api first (approval needed; after stage B)

Compatibility checks done 2026-11-07, read-only:

| Check                                                                         | Result                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Main's API boot validation (`loadConfig`) against UAT's current api variables | **Accepted.** Run in memory, values never printed; QA as the control, also accepted. `APP_ENV=UAT` is not STAGING/PRODUCTION, so the MFA-key boot rule does not apply                                                                                                                                                                            |
| Worker start-up requirements                                                  | Only `REDIS_URL` (present) and optional intervals                                                                                                                                                                                                                                                                                                |
| 24 pending migrations                                                         | Additive, except: three check constraints replaced, and the `SuppressedDestination` unique index widened to include `scope`. During the api-first window, the OLD api's suppression upsert can fail (no matching ON CONFLICT index) until the new api is up; a bounce webhook in that minute is retried by the provider. UAT has no real traffic |
| Variables QA has and UAT lacks                                                | SMS (Twilio/MSG91/DLT), R2 object storage, SES configuration sets and webhooks, billing, `MFA_ENCRYPTION_KEY`, `UNSUBSCRIBE_SIGNING_SECRET`, `PUBLIC_API_URL`. These features stay off or degraded on UAT until set; none is required to boot                                                                                                    |
| `PILOT_*` variables on UAT                                                    | Still read by `main` (`apps/api/src/pilot/pilot-config.ts`)                                                                                                                                                                                                                                                                                      |

Order:

1. Confirm a verified UAT backup from the last 24 h.
2. api at the release commit. Its pre-deploy runs `prisma migrate deploy` (24 migrations). Then
   health and the boot log.
3. worker.
4. customer-web, organizer-web, admin-web, one at a time.
5. Journeys: storefront browse and checkout start (Razorpay test mode), organizer event create,
   admin sign-in.

Rollback: before the api, nothing changes. After the api, the migrations are forward-only, so
roll forward. The web apps can be rolled back individually.

## 5. Fee maker-checker on UAT (owner)

Re-verified 2026-11-07 (read-only counts):

| Requirement                                      | Now                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------- |
| Two different people who can approve fee changes | **1** (the super admin)                                                          |
| Each with confirmed MFA                          | **0**                                                                            |
| `MFA_ENCRYPTION_KEY` on the UAT api (and worker) | **missing**: step-up routes, including fee approval, answer `MFA_NOT_CONFIGURED` |
| The maker-checker code itself                    | only arrives with stage C                                                        |

The owner generates the key (`openssl rand -base64 32`) and keeps it in the secret store
(losing it voids every enrolled authenticator). It is set on the api and worker with
`skipDeploys` before stage C. Then:

- the owner names a second administrator, with `FEE_SCHEDULE_APPROVE`, or a super admin;
- both enrol TOTP after stage C.

This is an owner decision; no approver is created or assumed here.

## 6. GO / NO-GO

| Stage                     | Verdict                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A. Next.js fix            | **GO when approved**: ready, isolated, same change as PROD                                                        |
| B. IaC migration (11-16)  | **GO when approved**: dry run and preview clean, procedure rehearsed on QA                                        |
| C. `main` to UAT          | **GO when approved, after B**: config and migrations checked; fee workflows stay unusable until section 5 is done |
| Fee maker-checker testing | **NO-GO**: needs the MFA key, a second approver and enrolment (owner)                                             |
