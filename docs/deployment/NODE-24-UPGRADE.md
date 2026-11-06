# Node.js 20 to Node.js 24 LTS

Status: on branch `chore/node-24-runtime`. Not deployed.

## Why

- Node 20 reached end of life on 2026-04-30. Every production image ran an unsupported
  runtime.
- Production already broke a dependency's declared range: `firebase-admin` 14 (push
  notifications, API) requires `node >=22`; npm only warned because engine-strict is off.
- The mobile toolchain in the lockfile (react-native 0.86, metro 0.84, nativewind's nested
  react-native 0.87, @testing-library/react-native 14) requires `^22.13 || >=24` in places,
  so the mobile-ci verify job on Node 20 was out of range.
- Versions had drifted: images and CI on 20, the EAS submit job on 22, developer machines on 24.

## Time zones: the runtime's tz database is behaviour (found by CI)

Node bundles the IANA time-zone database. The first CI run of this branch failed one test
that passed locally: CI pulled Node 24.22.2 (tzdata **2026e**), the developer machine had
24.14.1 (tzdata 2025c). tzdata 2026e records British Columbia staying on UTC-7 from November
2026, so `America/Vancouver` and `America/Whitehorse` now keep the same clock.

The same instant, `2026-11-14T03:30Z`, reads in Vancouver as:

| Runtime                         | tzdata | Vancouver     |
| ------------------------------- | ------ | ------------- |
| Node 20.20.2 (production today) | 2025c  | 7:30 PM GMT-8 |
| Node 24.22.2 (this branch)      | 2026e  | 8:30 PM GMT-7 |

So **production on Node 20 is one hour apart from tzdata 2026e for British Columbia from
November 2026**, and browsers with newer data will disagree with the server. Any BC
(America/Vancouver) event should be checked after this ships. Two consequences here:

- The exact version is now pinned: `node:24.22.2-alpine`, `setup-node: 24.22.2`, `.nvmrc`
  24.22.2. A floating `24-alpine` tag let two builds of one commit carry different tz data.
  Bump it on purpose, and read the tzdata changes when you do.
- The test now uses a pair that differs under every tzdata version (Los Angeles and Phoenix),
  and passes on both 2025c and 2026e. The zone label for America/Vancouver still says
  "Pacific time"; whether BC's permanent UTC-7 should be labelled differently is a product
  decision (open).

Postgres has its own tz database. The API converts times in JavaScript, but any SQL
`AT TIME ZONE` uses the database's copy, which updates with the Postgres image.

## What changed

| Place                                           | Before           | After                      |
| ----------------------------------------------- | ---------------- | -------------------------- |
| `.nvmrc`                                        | 20               | 24                         |
| root `package.json` engines                     | `>=20`           | `>=24`                     |
| 5 Dockerfiles, 10 `FROM` lines                  | `node:20-alpine` | `node:24-alpine`           |
| 7 `setup-node` entries in 5 workflows           | 20 (one job 22)  | 24                         |
| `@types/node` in api, worker and the 3 web apps | `^20.16.10`      | `^24.10.1` (lock: 24.19.2) |

`package-lock.json` changes only `@types/node` and its `undici-types` dependency. No runtime
dependency moved. No source code changed: nothing in the repo uses an API removed or changed
in Node 22 or 24 (`punycode`, `url.parse`, `assert {type}` import attributes,
`process.binding`, `--experimental-*`, `new Buffer`, `crypto.createCipher` were all searched
for).

Native and binary dependencies are Node-API or prebuilt per platform and do not depend on the
Node ABI: sharp 0.35.5 (`>=20.9.0`), Prisma 5.22 engines (Rust library), Next.js SWC (musl
prebuild), msgpackr-extract (optional N-API). bcryptjs is pure JavaScript.

## Evidence (local, 2026-11-06)

- `turbo run typecheck --force`: 15 of 15 workspaces with the Node 24 types.
- Full API test suite on Node 24.14.1 against a fresh, CI-style seeded Postgres 16 and Redis 7:
  685 suites, 9,485 tests passed (run on branch `feat/fee-schedule-approval`, which is `main`
  plus that feature; the runtime is the same).
- All five images built from these Dockerfiles on `node:24-alpine` (Node v24.22.2, OpenSSL
  3.5.9):
  - `api`: boots with production hardening on (it refused placeholder secrets, as it should),
    `/api/ready` 200 (Postgres, Redis and the Prisma query engine all work on Alpine).
  - `worker`: `/ready` 200; it ran the scheduled notification dispatch (162 sent, 0 failed, to
    local log providers).
  - `customer-web`, `organizer-web`, `admin-web`: `/api/health` 200; the storefront home page
    renders.
  - No `DeprecationWarning` or `ExperimentalWarning` in the logs.
- Two API replicas from the Node 24 image under load, with one stopped by SIGTERM mid-run:
  0 failed requests out of about 18,000 (see `docs/deployment/API-HIGH-AVAILABILITY.md`).

## Not covered yet

- **EAS cloud builds** (Android/iOS) still use the EAS image default for Expo SDK 57; no
  `node` field is pinned in `apps/customer-mobile/eas.json`. Pin it only together with a real
  EAS build, because a wrong pin fails the build before it starts.
- **Prisma 5.22 on Node 24** works in every test here, but Prisma 5 predates Node 24 and does
  not list it officially. Prisma 6 is the supported path and is a separate upgrade.
- **db-seed** uses `ts-node` (`deploy/railway/db-seed.railway.json`). The seed scripts ran on
  Node 24.14 locally (`db:seed`, `db:demo-venues`, `db:seed:india-cinema`), but not inside the
  new image.

## Rollout

The image's Node version changes on the next build of each service; nothing else changes.

1. QA: deploy all five services from the merge commit (api first, as always). Run
   `verify-deployed.mjs` and the QA certification journeys.
2. UAT: same, after QA is green for a day.
3. Production: only with owner approval, in the normal pinned-deploy window, after a backup.

## Rollback

Redeploy the previous deployment of each service (Railway keeps its image), or revert this
commit and rebuild. The runtime holds no state; no migration is involved.
