# ETicketsGo — RC1 Readiness Report

**Date:** 2026-07-16 · **Assessment:** Release Candidate 1 · **Verdict:** ✅ GO for controlled production launch.

---

## 1. Executive summary

ETicketsGo Phase 1 is a mature, defense-in-depth event operating system. An RC1
production-readiness program ran a four-track audit — configuration/secrets/dependencies,
security, observability, and infrastructure/ops — across the entire platform. The audits
found **no Critical blockers**. Two HIGH and a handful of MEDIUM/LOW items were genuine and
have been fixed with minimal, backward-compatible changes; the remainder are documented as
accepted limitations with follow-ups. No system was redesigned.

The platform boots fail-closed, keeps every risky capability behind an off-by-default flag,
never leaks secrets to clients, enforces authorization consistently, and degrades gracefully
under dependency failure. RC1 is recommended for a controlled production launch.

**Quality gate (this RC):** typecheck 13/13 · lint clean · madge 0 cycles · web-kit vitest
100 · API jest 603 (added a config-guard spec) · build 8/8 · e2e flag-off 10 passed /
13 skipped / 0 failed · offline pilot simulation green · flag-off posture verified
(offline 404, Swagger off in prod, wallet unavailable).

## 2. Production readiness score

| Dimension               | Score        | Notes                                                                                                |
| ----------------------- | ------------ | ---------------------------------------------------------------------------------------------------- |
| Configuration & secrets | 9.5 / 10     | Zod-validated, fail-fast; **now** rejects placeholder/weak core secrets + unconfigured CORS in prod. |
| Security                | 9.5 / 10     | Strong authz/IDOR, replay, signing; one cross-tenant read fixed.                                     |
| Observability           | 8.5 / 10     | Metrics, health, correlation IDs, audit; JSON-log + a few counters are follow-ups.                   |
| Resilience              | 9 / 10       | DB-backed holds, fail-open cache; Redis-hang fixed; payment failover + circuit breaker.              |
| Data & migrations       | 9.5 / 10     | Additive-only, `migrate deploy`, PITR/backup documented.                                             |
| Build & CI/CD           | 9 / 10       | Lockfile, pinned Node/pm, full CI gate; deploy host step is a placeholder.                           |
| Accessibility           | 9 / 10       | Broad aria/role usage, non-color status; no regression found.                                        |
| Performance             | 9 / 10       | Paginated hot paths, indexed, no N+1 in reviewed paths.                                              |
| Documentation           | 9.5 / 10     | Deep guides + RC release doc set.                                                                    |
| **Overall**             | **9.2 / 10** | **Production-ready for a controlled launch.**                                                        |

## 3. Security assessment

**Posture: STRONG.** Verified solid: no client secret leakage; consistent org/ownership
authorization (live DB membership checks); no IDOR in reviewed id-endpoints; bearer-token
auth (CSRF-immune); no XSS sinks; no SSRF (provider URLs are config-derived); parameterized
Prisma only (no raw-unsafe SQL); QR/manifest replay protection (rotating nonce + atomic
single-use claim, monotonic signed manifest); offline gate is server-authoritative and
cannot convert a rejected scan to ACCEPTED; wallet issuance is authz-gated, ACTIVE-only,
fail-closed; activation is scoped, evidence-gated, and revocable.

**Fixed this RC:**

- Fail-closed production guard against placeholder/weak `JWT_*` / `QR_SIGNING_SECRET` /
  `PAYMENT_WEBHOOK_SECRET` / `MANIFEST_SIGNING_SECRET` and unconfigured CORS (HIGH).
- `assertMember` added to `GET /checkin/offline-readiness` and `/checkin/activation` (LOW
  cross-tenant read).
- Security headers (HSTS/X-Frame-Options/nosniff/Referrer-Policy/CSP frame-ancestors) on all
  web apps; Swagger gated out of production; exception-log query-string redaction.

**Residual (accepted, documented):** per-instance rate limiting (dilutes at horizontal
scale), platform-role revocation lag bounded by the 15-min access-token TTL. See
[KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md).

## 4. Operational readiness

- **Health/readiness:** API + worker gate on DB + Redis; web apps now expose `/api/health`.
- **Metrics:** Prometheus for API + worker (bookings, payments, refunds, checkins, QR,
  webhooks, reconciliation, HTTP, DB, queue). Payout/wallet/notification counters are follow-ups.
- **Logging/error:** normalized error envelope + correlation IDs; **payment errors now
  classified** (declines→402, provider-down→503) instead of opaque 500s.
- **Resilience:** cache + maintenance guard fail open; **Redis command timeout added** so an
  outage degrades instead of hanging; DB-backed seat holds survive a Redis/worker outage;
  bounded retry/backoff + circuit breaker on payments; BullMQ retries + failed-job retention.
- **Audit:** wide coverage; **auth events + maintenance toggle now audited**.
- **DR:** managed-Postgres PITR + `pg_dump`/restore documented (RPO ≤ 5 min / RTO ≤ 60 min).
- **Runbooks:** deployment, rollback, operations, provider-outage, credential-rotation,
  disaster-recovery, offline-pilot — all present.

## 5. Remaining external dependencies

To go live, provision (see [EXTERNAL-DEPENDENCIES.md](EXTERNAL-DEPENDENCIES.md)):

- **Required:** managed PostgreSQL (PITR), managed Redis, Node 20 runtime, TLS/reverse proxy.
- **For real payments:** a configured provider + ACTIVE merchant + PASS sandbox certification
  - live-readiness GO + `PAYMENT_LIVE_ENABLED=true`; a cloud secret manager (env backend is
    rejected in prod).
- **Optional/feature-gated:** notification providers (email/SMS/WhatsApp/push), Apple/Google
  wallet issuer credentials, Sentry/OTel/Prometheus, durable object storage.
- **CI/CD:** wire the `deploy.yml` rollout step to the chosen host/registry/orchestrator.

All conditional dependencies fail closed / no-op when unconfigured.

## 6. Release recommendation

**✅ GO for a controlled production launch.** RC1 is stable, secure, observable, and
fail-closed by default, with no Critical/High open issues. Recommended launch shape:

1. Deploy with real secrets, `PAYMENT_LIVE_ENABLED=false`, `OFFLINE_CHECKIN_ENABLED=false`.
2. Validate via the [DEPLOYMENT-CHECKLIST.md](DEPLOYMENT-CHECKLIST.md) and smoke test.
3. Enable live payments per provider only after certification + readiness GO.
4. Run the offline check-in pilot ([PILOT-RUNBOOK.md](../guides/PILOT-RUNBOOK.md)) before any
   broad offline rollout.
5. Address the Known-Limitations follow-ups (shared throttling, JSON logs, extra counters)
   before high-scale, multi-instance operation.

## 7. Final commit

RC1 base (Phase 1 complete): `bc062d4`. RC1 hardening + documentation commits on `main`:

| Commit    | Change                                                               |
| --------- | -------------------------------------------------------------------- |
| `9e24cd0` | fail-closed prod config guard + Swagger prod-gate                    |
| `9831ebe` | org membership on offline readiness/activation reads                 |
| `3bceaf3` | redis fail-open timeout + payment error classification + log hygiene |
| `a94c9c1` | audit auth events + maintenance toggle                               |
| `f77bd9f` | web security headers + health routes                                 |
| `98b04ac` | env docs, Node pin, license                                          |
| `d92ef72` | RC1 release documentation set                                        |

The RC1 line is `bc062d4 → d92ef72` on `main`, finalized by the commit recording this table.
