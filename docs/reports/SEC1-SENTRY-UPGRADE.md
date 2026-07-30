# SEC-1 Batch A2 — Sentry Runtime Modernization

**Branch:** `chore/sec1-sentry-runtime`
**Base:** `main` @ `736fa24` (after PR #27 NestJS 11 merged)
**Scope:** Runtime observability only — `@sentry/node` (backend). No booking/payment/inventory/API
behaviour change. No Next.js/React/Firebase/Google/Vitest or unrelated dependency change.
**Verdict:** **GO** (local gates green; standard CI must confirm on the PR).

## 1. Versions before → after

| Package                                | Before  | After            | Scope                  |
| -------------------------------------- | ------- | ---------------- | ---------------------- |
| `@sentry/node` (apps/api, apps/worker) | ^8.55.2 | **^10.69.0**     | runtime                |
| `@sentry/core` (transitive)            | 8.55.2  | 10.69.0          | transitive             |
| `@sentry/opentelemetry` (transitive)   | 8.55.2  | 10.69.0          | transitive             |
| `@sentry/node-core` (new, transitive)  | —       | 10.69.0          | transitive (v10 split) |
| `@sentry/server-utils` / `conventions` | —       | 10.69.0 / 0.16.0 | transitive             |

No `@sentry/nestjs`, `/browser`, `/nextjs`, `/react`, `/types`, `/utils` exist — **the three web
apps do not use Sentry** (frontend Sentry audit = N/A). `@sentry/node` at v8 was already at its
max (8.55.2); v10.69.0 is the current latest.

## 2. Migration notes / breaking changes

The app uses only the stable core API — `Sentry.init`, `Sentry.withScope`, `scope.setTag`,
`Sentry.captureException`, and the `dsn / environment / release / tracesSampleRate / sendDefaultPii`
options — all **unchanged v8 → v10**. **Zero application-code changes were required for the version
bump** (api + worker typecheck + build clean immediately after the install).

v10 internally restructured the Node SDK (new `@sentry/node-core`, OpenTelemetry core `1.30 → 2.10`,
ESM instrumentation via `@apm-js-collab/*` + `import-in-the-middle` `1 → 3`) and dropped its bundled
per-library OTel instrumentations (`instrumentation-express/http/pg/ioredis/...`). This is **inert
for this app**: tracing is disabled by default (`tracesSampleRate: 0`) and the app's own optional
OpenTelemetry tracing (`observability/tracing.ts`) uses separate, not-installed `@opentelemetry/*`
packages. All lockfile drift is contained within the `@sentry/node` transitive subtree — **no
app-declared or unrelated-runtime dependency changed** (verified by lockfile diff).

## 3. Instrumentation (Stage 4)

- **Backend only.** API initialises Sentry via `observability/instrument.ts`, imported first in
  `main.ts` (before app modules load — correct for v10's SDK). Worker initialises inline in
  `main.ts`. Both are a **complete no-op unless `SENTRY_DSN` is set**.
- **Error tracking only — no noisy tracing.** `tracesSampleRate` defaults to `0` (API env-overridable,
  worker hard-`0`). No performance spans, no profiling.
- **Capture points:** API `AllExceptionsFilter` reports **only 5xx** (expected 4xx `AppException`s are
  excluded); health/metrics endpoints return 200 and are never captured. Worker capture tags
  `service=worker`. Tags carried: `correlationId`, `method`, `path` (query-string stripped),
  `jobId`. Background/BullMQ/webhook exceptions flow through the same manual `capture()`.
- **Frontend:** N/A — no Sentry in customer-web/admin-web/organizer-web (browser errors, route
  transitions, source maps, session replay, etc. are not applicable to this batch).

## 4. Security review (Stages 5 & 7)

Posture preserved and **hardened**:

- `sendDefaultPii: false` — Sentry never auto-attaches request headers, cookies, body, or client IP.
- **New defensive `beforeSend` scrubber** (`scrubSensitiveData`, api + worker): on every outgoing
  event it deletes `request.cookies`, `request.data`, `request.query_string`, the
  `Authorization`/`Cookie`/`Set-Cookie` headers, and any `user` identity — a belt-and-suspenders
  guarantee even if a future integration attaches them. Never throws.
- **Failure-injection proof** (real `@sentry/node@10`, capturing hook, no network): API- and
  worker-style captures produce events with the **correct release, environment, tags and full stack
  trace**, and **no `user`, no `request`, and none of** password / Authorization / Cookie / JWT /
  card-number / email / request-headers anywhere in the event. Unit tests
  (`sentry.spec.ts`) assert the scrubber strips user + auth/cookie headers + cookies/body/query while
  preserving benign fields, and that `init` wires the dedupe integration + `beforeSend`.

## 5. Deduplication

`@sentry/node` has **no client-side dedupe by default** (it is a browser default). Added
`Sentry.dedupeIntegration()` to both api and worker init. Proven: one recurring error captured twice
consecutively yields **one** outgoing event. (Sentry server-side issue-grouping by stack trace
applies regardless.)

## 6. Verification (Stage 6) — zero behaviour change

| Gate                                         | Result                                                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| API typecheck / build (`nest build`)         | clean                                                                                               |
| Worker typecheck / build                     | clean                                                                                               |
| Full API test suite                          | **162 suites / 1183 tests** (1180 + 3 new scrubber)                                                 |
| `sentry.spec.ts`                             | 6/6                                                                                                 |
| API + worker compiled boot (no DSN)          | identical to baseline; health/ready/orchestration/metrics 200; correlation-id present; worker boots |
| customer-web / admin-web / organizer-web     | production build ✓ (all three)                                                                      |
| Prisma validate / migration drift            | valid / none                                                                                        |
| Offline PWA E2E (customer-web, vs NestJS 11) | `offline.spec.ts` 2/2 + wallet 3/3                                                                  |

## 7. Performance (Stage 8 — indicative, not a production claim)

- API startup to "listening": < 1s (unchanged). Worker boot: immediate (unchanged).
- Health endpoint latency: ~5 ms (unchanged).
- API idle RSS: ~128 MB (unchanged; Sentry is a no-op without a DSN, and error-only with one).
- Trace overhead: none (`tracesSampleRate: 0`).
- Bundle-size delta: **N/A** — Sentry is not shipped in any web bundle; the backend is not bundled.

## 8. Remaining advisories

`npm audit` (all): **69 → 50** (`C2 H39 M28 L0` → `C2 H39 M9 L0`) — **moderate −19**, driven by
removing `@sentry/*@8` + its bundled OpenTelemetry-instrumentation chain. **No `@sentry/*` advisory
remains** (verified). Criticals (`next`, `vitest`) and highs are unchanged — none are Sentry-owned.
The next recommended isolated batch is **`next`** (web SSR), then Firebase/Google SDK family and
remaining runtime libraries. Full picture in `DEPENDENCY-REMEDIATION.md`.

## 9. Rollback

Revert this PR, or restore `apps/api/package.json`, `apps/worker/package.json`, `package-lock.json`,
`apps/api/src/observability/sentry.ts`, `apps/api/src/observability/sentry.spec.ts`,
`apps/worker/src/main.ts` to `736fa24` and run `npm ci`. No DB migration added; nothing to roll back
server-side. Sentry is a no-op without `SENTRY_DSN`, so production behaviour is unaffected either way.

## 10. Files changed

- `apps/api/package.json`, `apps/worker/package.json` — `@sentry/node ^10.69.0`.
- `package-lock.json` — Sentry family + its OpenTelemetry transitive subtree only.
- `apps/api/src/observability/sentry.ts` — `dedupeIntegration()` + `beforeSend` scrubber (`scrubSensitiveData`).
- `apps/worker/src/main.ts` — `dedupeIntegration()` + inline `beforeSend` scrubber.
- `apps/api/src/observability/sentry.spec.ts` — mock updated for `dedupeIntegration`; 3 new scrubber tests + init-hardening assertions.
- `docs/reports/SEC1-SENTRY-UPGRADE.md` — this report.
