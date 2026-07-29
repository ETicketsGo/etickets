# Dependency Remediation (P6.4)

Snapshot: `npm audit` on `feat/p6-production-hardening`, 2026-07-28. **91 advisories: 2 critical,
44 high, 42 moderate, 3 low.**

## Key finding — no safe bulk fix exists

`npm audit fix` (even without `--force`) pulls **breaking major upgrades** (`next@16`,
`@nestjs/core@11`, `vitest@4`, `jest@25`, `eslint@10`, `@sentry/node@10`). `npm update`
(semver-range-respecting) resolved **only 1** advisory while rewriting ~8,500 lockfile lines — a
poor risk/benefit trade right before launch, so it was **reverted**. Per the rules ("only safe
patch versions; never blindly upgrade breaking"), the remaining fixes are scheduled **isolated,
tested** upgrades, not an automated sweep.

## Severity × exposure

| Severity | Count | Runtime-relevant (server/web request path)                                                                            | Tooling / dev-only (not shipped)                                                                                              |
| -------- | ----- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Critical | 2     | `next` (web SSR)                                                                                                      | `vitest`                                                                                                                      |
| High     | 44    | `@nestjs/platform-express`, `fast-xml-parser`, `google-gax`, `next`, `@nestjs/swagger`                                | `eslint`, `eslint-config-next`, `jest`, `ts-jest`, `@nestjs/cli`, `glob`, `rimraf`, `minimatch`, `brace-expansion`, `postcss` |
| Moderate | 42    | `@nestjs/core`, `@nestjs/config`, `@sentry/node`, `uuid`, `gaxios`, `file-type`, `firebase-admin`, `@opentelemetry/*` | `@angular-devkit/*`, `@nestjs/schematics`, `@nestjs/testing`                                                                  |
| Low      | 3     | —                                                                                                                     | misc                                                                                                                          |

**16** advisories report a semver-compatible fix, but most are **transitive and parent-pinned**
(e.g. `fast-xml-parser`/`gaxios` under `google-gax`/`firebase-admin`), so they cannot move without
bumping the parent — which is a major. Forcing them via `overrides` risks breaking the Google/
Firebase SDK integration and is therefore **not** applied blindly.

## Remediation plan (isolated, test-gated — do before production)

**Batch A — runtime majors (highest priority, one PR each, full suite + smoke per bump):**

1. `@nestjs/*` 10→11 family (core, platform-express, config, swagger, testing, cli, schematics) —
   coordinated (they must move together); run full API suite + e2e.
   **BLOCKED → now unblocked (see A1 note below).** A first A1 attempt failed the customer wallet
   offline E2E: under NestJS 11 / Express 5, response timing shifted enough that Chromium reported
   `navigator.onLine === true` on an **offline-reloaded** wallet page, so the wallet (which trusted
   that single boolean) never showed the offline indicator. The correct fix was a **frontend
   prerequisite**, not a test tweak — shipped separately as `fix/customer-web-offline-detection`
   (see `CUSTOMER-WEB-OFFLINE-DETECTION-HARDENING.md`). **A combined NestJS + Next.js upgrade in one
   PR was rejected** — it would have entangled two independent majors and made the offline
   regression impossible to attribute.
2. `next` 15→16 (customer/organizer/admin web) — per-app; run web build + Playwright e2e.
3. `@sentry/node` →10 — verify worker + API instrumentation still initializes.
4. `google-gax` / `firebase-admin` / `fast-xml-parser` / `gaxios` — bump the SDK parent so the
   patched transitive resolves; verify push-notification + any Google integration paths.
5. `uuid` →14, `file-type` — low blast radius; bump + typecheck.

**Batch B — tooling majors (dev-only; batch together, gate on CI green):**
`vitest`→4, `jest`→25 + `ts-jest`, `eslint`→10 + `eslint-config-next`, `@angular-devkit/*`. Not in
the shipped runtime — schedule after Batch A.

**Interim safe step already in place:** the P6.3 `security.yml` workflow runs `npm audit` +
`dependency-review` (fail-on-high for _new_ deps) + TruffleHog on every PR, so no _new_ high-severity
dependency can enter `main` while Batch A/B are worked.

## Verification of applied changes

None applied to the lockfile in this pass (the `npm update` churn was reverted). The only
dependency-adjacent change on this branch is the `security.yml` scanner. Each Batch A/B upgrade must
re-run: full API suite (161/1176), web builds, Playwright e2e, `npm audit` delta.

## Batch A1 retry sequence (NestJS 10→11)

The offline regression was a **customer-web** defect exposed by (not caused by) NestJS 11. Sequence:

1. **Prerequisite (this PR):** merge `fix/customer-web-offline-detection` — hardens offline
   detection so the wallet no longer relies solely on `navigator.onLine`. Proven against **both**
   Express 4 (NestJS 10) and Express 5 (NestJS 11) locally: 50+ paced offline-E2E reps per backend,
   0 offline-detection failures. See `CUSTOMER-WEB-OFFLINE-DETECTION-HARDENING.md`.
2. **After it merges to `main`:** retry **Batch A1 only** (`@nestjs/*` 10→11 family) from the
   updated `main`. The offline E2E now passes because the UI no longer trusts a stale `navigator.
onLine`. Do **not** bundle any Next.js change into A1.
3. **Only after A1 is green + merged:** begin **Batch A2** (`next` 15→16). Never combine A1 and A2.

## Gate

**PRODUCTION GATE (SEC-1):** Batch A must be completed + verified before production. Batch B before
or shortly after pilot. The 2 criticals (`next`, `vitest`) are a web-SSR major and a dev test
runner — neither is in the API money path, but `next` must be upgraded before public web launch.
**Batch A1 is gated on the customer-web offline-detection fix landing first (above).**
