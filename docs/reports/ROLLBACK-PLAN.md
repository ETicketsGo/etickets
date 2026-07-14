# ETicketsGo — Rollback Plan

> How to safely revert a bad production release. The short version: because
> migrations are **additive and backward-compatible**, the previous image keeps
> working against the new schema, so rollback is normally just **redeploying the
> prior release tag** — no down-migration. This plan sequences that and says when
> the heavier tools (maintenance mode, PITR restore) are warranted.
>
> Companions: [Deployment §10 (rollback)](../guides/DEPLOYMENT.md) ·
> [Disaster Recovery](./DISASTER-RECOVERY.md) · [Operations](./OPERATIONS.md) ·
> [Go-Live Checklist](./GO-LIVE-CHECKLIST.md) ·
> [Monitoring Checklist](./MONITORING-CHECKLIST.md).

---

## 1. When to roll back

Roll back when a deploy makes production worse and a fix-forward is slower than a
revert. Typical triggers (usually surfaced by the alerts in the
[Monitoring Checklist §3](./MONITORING-CHECKLIST.md)):

- `HighHttp5xxRate` / `ApiLatencyP95High` spike right after a rollout.
- `PaymentsFailureRateHigh` or `BookingConfirmErrorRateHigh` — money path
  regressed.
- Post-deploy **smoke test fails** (`/api/health`, `/api/ready`, `/api/metrics`, or
  the synthetic booking → webhook → confirm).
- A functional regression reported that blocks buying / check-in.

If the problem is a **bad image / code**, use the standard rollback (§2). If it is a
**bad data state** (corruption, a data-mutating bug that wrote wrong rows), code
rollback is not enough — go to §4 (PITR).

## 2. Standard rollback — redeploy the prior release tag

Migrations are additive-only, so the last-good image runs against the current
schema with **no destructive down-migration**.

1. **Identify the last-good git SHA** — its five images are in GHCR, tagged by SHA
   (`ghcr.io/<owner>/<repo>/{api,worker,customer-web,organizer-web,admin-web}:<sha>`).
2. **Re-point services to that tag and restart:**
   ```bash
   REGISTRY=ghcr.io/<owner>/<repo> IMAGE_TAG=<last-good-sha> \
     docker compose -f docker-compose.prod.yml --env-file .env.production up -d
   ```
   (or `kubectl rollout undo deploy/<svc>` / your platform's rollback). Gate
   rollout on `GET /api/ready` before shifting traffic back.
3. **Do not run a down-migration.** The additive migration stays applied; the older
   image ignores the new, unused columns/tables. (Automate this in the pipeline's
   deploy job — if smoke fails, redeploy the previous tag; see the commented example
   in `.github/workflows/deploy.yml`.)
4. If a web bundle is involved, remember `NEXT_PUBLIC_API_URL` is **build-time** —
   rolling the web image tag rolls its inlined config too.

> **Rare exception:** if the bad release shipped a _non-additive_ migration (should
> never happen — CI/PR review enforces additive-only), a code rollback alone is
> unsafe; treat it as a data incident (§4).

## 3. When to use maintenance mode

Use the ops-console **maintenance mode** (`/admin/ops`, `apps/api/src/ops`) to stop
the bleeding while you roll back or restore:

- **During a money-integrity incident** — freeze new bookings/payments so you are
  not accumulating more affected transactions while investigating (SEV1).
- **Before a PITR restore** (§4) — quiesce writes so the restore target is clean and
  you are not racing new writes against the restore.
- **During active security exploitation** — per the
  [Escalation Matrix §6](../pilot/ESCALATION-MATRIX.md) /
  [Incident Response](../pilot/INCIDENT-RESPONSE.md).

Announce it (§6) and lift it as soon as `/api/ready` + smoke are green on the
rolled-back revision.

## 4. When a PITR restore is needed

A code rollback fixes bad **code**; it cannot undo bad **data**. Escalate to a
**point-in-time restore** ([Disaster Recovery](./DISASTER-RECOVERY.md)) when:

- A migration or a data-mutating bug **wrote incorrect rows** (bookings, payments,
  refunds, payouts, seats) that a new deploy won't correct.
- Corruption or an accidental destructive operation on Postgres.

Procedure (summary — full steps in [DR](./DISASTER-RECOVERY.md)): enable maintenance
mode → restore the managed-Postgres cluster to a timestamp **just before** the
incident (RPO ≤ 5 min via WAL) → re-point `DATABASE_URL` → `npm run db:deploy`
(no-op if schema matches) → smoke test → lift maintenance mode. RTO target ≤ 60 min.
Redis needs no restore (cache/queues re-derive; hold-expiry runs lazily).

## 5. Verification after rollback (smoke)

Re-run the go-live smoke against the rolled-back revision
([Deployment §8](../guides/DEPLOYMENT.md), [Operations §6](./OPERATIONS.md)):

1. `GET /api/health` → `{status:"ok"}`.
2. `GET /api/ready` → 200 (Postgres + Redis up).
3. `GET /api/metrics` → 200 with `etg_` series.
4. **Synthetic booking → payment webhook → confirmation** on a canary org/event —
   confirm `etg_bookings_confirmed_total` + `etg_gmv_minor_total` move.
5. Confirm the triggering alert has cleared and 5xx / payment-failure rates are back
   to baseline on the Grafana Overview.

## 6. Communications

- **Internal** — post in the incident channel: what was rolled back (from-SHA →
  to-SHA), why, current status, and whether maintenance mode is on. Owner: On-call
  engineer / Program Owner ([Escalation Matrix §1](../pilot/ESCALATION-MATRIX.md)).
- **User-facing** — only if customers were impacted (maintenance mode, failed
  checkouts). Route disclosure through the **Program Owner**; keep it factual.
- **Follow-up** — log the rollback in `/admin/audit` context, and open a postmortem
  per [Incident Response](../pilot/INCIDENT-RESPONSE.md) for any SEV1/SEV2.

---

## Why rollback is low-risk here (invariants)

- **Additive-only migrations** → previous image is forward-compatible → rollback
  rarely needs a down-migration.
- **Money/inventory transitions are atomic + idempotent** — no double-issue /
  double-refund / double-payout, so a mid-rollout retry can't corrupt money.
- **Seat holds auto-expire and return stock**, so a stalled payment path self-heals
  during the disruption. (See [Disaster Recovery — Invariants](./DISASTER-RECOVERY.md).)
