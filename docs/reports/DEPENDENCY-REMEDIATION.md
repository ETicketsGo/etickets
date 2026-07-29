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

1. ⚠️ **Batch A1 (`@nestjs/*` 10→11) — BLOCKED on a customer-web fix, NOT on Next.js.** All API-level
   gates pass (162/1180, boot, migrations, audit 91→69; family owns 0 crit / 5 high incl runtime
   `multer`). **Blocker root cause CORRECTED** (branch `chore/sec1-nestjs-next-workspace-remediation`,
   report `SEC1-NESTJS-NEXT-WORKSPACE-UPGRADE-REPORT.md`): a controlled local isolation experiment
   proved the offline e2e regression is caused by **NestJS 11 / Express 5**, **not** `next` hoisting
   (NestJS 10 + hoisted next → passes; NestJS 11 + hoisted next → fails, matching CI). The prior
   "hoisting/combine-with-Next" diagnosis (PR #24/#25) is **superseded**. On the offline wallet page
   under NestJS 11, `navigator.onLine` stays `true` (banner shows "Up to date" not "Offline"); a
   customer-web offline-detection/hydration fix is required (verified by the offline e2e) — this is a
   **customer-web change, not a dependency batch**. Also fix `packages/web-kit`'s `next: "14.2.15"`
   residue (align `^14.2.35`) for a clean workspace layout (safe; unrelated to the regression).
2. `next` 15→16 (customer/organizer/admin web) — per-app; run web build + Playwright e2e. **Note: NOT
   a prerequisite for the NestJS batch** (that was a wrong assumption; see A1).
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

## Gate

**PRODUCTION GATE (SEC-1):** Batch A must be completed + verified before production. Batch B before
or shortly after pilot. The 2 criticals (`next`, `vitest`) are a web-SSR major and a dev test
runner — neither is in the API money path, but `next` must be upgraded before public web launch.
