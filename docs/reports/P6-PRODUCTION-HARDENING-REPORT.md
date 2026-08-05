# P6 — Production Hardening Report

**Date:** 2026-07-28 · **Branch:** `feat/p6-production-hardening` (cut from the P1–P5 baseline
`76de0b8`). This report states honestly what was **executed**, what is **infra-gated/PENDING**, and
gives a launch verdict. P6 is operational proof, **not** feature development — no new booking features
were added.

## Executive verdict: **CONDITIONAL GO for a controlled pilot; NO-GO for unrestricted production.**

The platform is code-complete, correctness-proven at the data layer, and safe-by-default. Production
launch is blocked on operational proofs that require infrastructure not available in this environment
(managed staging, payment sandbox credentials, load/chaos rigs) plus owner policy decisions. None of
these are code defects — they are gates.

## What was executed (and passed) here

| Area                                   | Result                                                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo/branch audit                      | Linear 118-commit stack; payments⊂platform⊂booking; exact ranges documented (MERGE-READINESS-REPORT.md).                                        |
| Payment PR (#21) isolated verification | 34 suites / **257 payment tests** at the payment tip; routing/webhook/secret/schema gates green.                                                |
| Payment PR (#21) **CI**                | ✅ **green** on GitHub Actions (real postgres service) after fixing pre-existing format debt.                                                   |
| Platform PR (#22)                      | Opened, stacked on the payment branch (105 commits, no payment duplication).                                                                    |
| Full P1–P5 suite                       | ✅ **161 suites / 1176 tests** passed locally.                                                                                                  |
| Migration integrity                    | ✅ `migrate status` up-to-date; **fresh-DB deploy** of all 39 migrations from zero — clean.                                                     |
| **P6.4 concurrency soak**              | ✅ **executed** — 230 rounds, real PostgreSQL: **0 double-finalize, 0 oversell, 0 over-capacity, 0 errors**.                                    |
| P6.8 security (code)                   | ✅ no secret literals, no unparameterized SQL, admin/promotion role-guarded, webhooks signature-verified, tenant isolation, PII-free telemetry. |
| Format/hygiene                         | Repo-wide prettier debt (36 files, pre-existing incl. `main`) fixed on both branches; CI format gate now green.                                 |

## What is PENDING (infrastructure / credentials / owner decision — not code)

| Gate                                | Blocker                                          | Deliverable provided                                                                                       |
| ----------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| **P6.1 staging**                    | No authenticated cloud/managed infra             | `docker-compose.staging.yml` (2×API/2×worker) + P6.1 deploy doc + exact commands                           |
| **P6.2 payment sandbox**            | No Stripe/Razorpay TEST keys                     | Harness spec + matrix + setup (P6.2-P6.5-P6.6-HARNESSES.md); **must not enable auto-refund on mock alone** |
| **P6.3 settlement + refund policy** | Owner (product+finance) decisions                | Owner-decision record + settlement-wiring prerequisite (P6.3 doc); stays `MANUAL_ONLY` fail-closed         |
| **P6.5 load**                       | No staging stack                                 | Runnable k6 harness (`scripts/load/booking-load.js`) + capacity method; **no local IPL-scale claim**       |
| **P6.6 failure injection**          | No staging stack                                 | Scenario + invariant matrix; DB-layer subset already proven, request-level PENDING                         |
| **P6.7 observability**              | Deploy Prometheus/Grafana + Alertmanager routing | Dashboards + alert rules mapped to real `etg_*` metrics with initial thresholds                            |
| **P6.9 backup/DR**                  | No managed-PG to restore                         | RPO/RTO + runbook + rehearsal steps; **DR not claimed proven until rehearsal runs**                        |
| **SEC-1 deps**                      | 23 high npm vulns (mostly build tooling)         | Triaged remediation plan; runtime highs need isolated upgrades — **production gate**                       |

## Open risks

1. **Auto-refund dormant by design** — settlement is fail-closed (`undefined`); even `FULL_GROSS`
   → manual review until P6.3 §1 wired. Correct and safe, but means refund automation is unproven end-to-end.
2. **No production-capable idempotent-full-refund provider today** — only the mock qualifies; sandbox
   proof per provider is required (P6.2).
3. **Queue/cache keys not env-namespaced** — staging MUST use its own Redis (enforced by the staging
   compose); a shared Redis would collide. Backlog item.
4. **Dependency highs (SEC-1)** — runtime-relevant packages need upgrading before production.
5. **Platform PR #22 carries a redundant format commit** — harmless (identical to payment branch's),
   reconciles at merge; noted for the reviewer.

## Rollback plan (unchanged, verified flag-gated)

Disable orchestration / provider confirmation / allocated inventory / compensation execution /
auto-void / auto-refund via their flags → `MANUAL_ONLY`; legacy booking path where the orchestrator
is not authoritative. Migrations are forward-only (no down-migrations → forward-fix). See the pilot
checklist kill switches.

## Recommended next action

1. Owner: review + merge PR #21 (payment, **CI-green**) preserving SHAs; then retarget + merge #22.
2. Stand up managed staging (P6.1) with sandbox keys → run P6.2 sandbox matrix + P6.5 load + P6.6 chaos.
3. Product/finance: complete P6.3 decisions; engineering wires settlement (fail-closed).
4. Remediate SEC-1 runtime highs; run the P6.8 staging attack matrix.
5. Run the P6.9 DR rehearsal.
6. Re-issue this report with the executed staging results → pilot GO decision + `ETICKETSGO-PILOT-LAUNCH-CHECKLIST.md` sign-off.

**Until 2–5 are executed, the honest verdict remains CONDITIONAL GO (pilot, money-off) / NO-GO
(unrestricted production).**
