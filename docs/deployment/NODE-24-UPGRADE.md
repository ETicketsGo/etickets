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
