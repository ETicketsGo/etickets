# ETicketsGo — Merge Readiness Checklist

- **Date:** 2026-07-13 · **HEAD:** `feat/hardening-excellence`

## Quality gate (all must pass to merge)

| Gate                                      | Status                                         |
| ----------------------------------------- | ---------------------------------------------- |
| Lint (ESLint, all packages)               | ✅ clean                                       |
| Format (Prettier `--check`)               | ✅ clean                                       |
| Typecheck (16 packages)                   | ✅ 16/16                                       |
| Unit tests                                | ✅ 85/85 (16 suites)                           |
| Circular dependencies (`madge`)           | ✅ none                                        |
| Build (turbo, all apps+packages)          | ✅ 8/8                                         |
| Playwright e2e                            | ✅ 4/4                                         |
| Migrations additive / backward compatible | ✅ verified (no destructive DDL)               |
| No Critical architecture findings         | ✅ 0 open                                      |
| No High architecture findings             | ✅ 0 open                                      |
| No duplicated business logic introduced   | ✅ (inventory logic centralized in strategies) |

## The PR stack (merge in order — they are stacked, not independent)

1. **#1** `feat/experience-domain` → base `feat/eticketsgo-platform`
2. **#2** `feat/movie-cinema-domain` → #1
3. **#3** `feat/seat-reservation` → #2
4. **#4** `feat/discovery-platform` → #3
5. **#5** `feat/hardening-excellence` → #4 _(includes this review's payout fix + the 5 reports)_

**Recommended merge procedure**

1. Merge #1 → #2 → #3 → #4 → #5 sequentially (or squash the chain into `main` in one ordered sequence).
2. After each merge, run the quality gate in CI (the workflow already does).
3. Apply migrations with `db:deploy` (all additive — safe to run forward; no down-migration needed for compatibility).
4. Re-seed only in non-production; production data is untouched by these additive migrations.

## Pre-merge notes

- Set `PAYMENTS_MOCK_ENABLED=false` (or `NODE_ENV=production`) in production so the mock-pay path is disabled.
- Configure the `FEATURE_*` flags for the deployment (enterprise capabilities default off).
- No secrets are committed; `.env.example` documents required vars.

## Blocking issues

**None.** All gates green; zero open Critical/High. The stack is merge-ready. The Technical Debt Register items are non-blocking and scheduled as follow-ups.
