# P5 — Provider-Neutral Booking Platform: Completion Report

**Scope:** P5.3A (compensation foundation) + P5.3A.1 (allocation/HA follow-through) + P5.3B
Phases 4–6 (provider reservation cancellation, controlled payment void, controlled FULL refund).
**Branch:** `feat/provider-neutral-booking-orchestration`.
**Verdict:** ✅ **CONDITIONAL GO** to close the P5 booking-engine feature scope. All code gates
pass; the only remainders are staging-execution + product/finance policy approval + production
monitoring — none of which can be truthfully marked complete from code. Automatic money movement
is **off by default and production-forbidden**.

## Verification snapshot (2026-07-28)

- **Full API suite:** 161 suites / **1176 tests** green (baseline before Phase 6: 156 / 1120).
- **tsc** (`tsconfig.json`) clean; **API build** (`tsconfig.build.json`) clean; **worker** tsc clean.
- **prettier** clean on all touched source + docs (pre-existing `docs/release/*` warnings untouched).
- **prisma validate** OK; migrations through `20260728130000` applied (Phase 6 needed **no new
  migration** — `Refund` / `RefundStatus` / `BookingStatus.REFUNDED` / `Payment.refundedMinor`
  pre-exist).
- **Real-PostgreSQL proofs** executed (not skipped): compensation lease/claim, allocation
  accounting, provider-authoritative HA, one-refund-plan concurrency, **refund finalize-once +
  money invariant**.

## 42-point completion checklist

### A. Refund policy & safety model

1. ✅ Versioned refund policy abstraction (`DefaultBookingRefundPolicy`), deterministic.
2. ✅ Default `MANUAL_ONLY` — nothing auto-refunds without an explicit approved mode.
3. ✅ Modes limited to `MANUAL_ONLY / FULL_GROSS / TICKET_ONLY / EVENT_CANCELLATION_FULL` (no partial).
4. ✅ No invented fee/tax/GST/processing/settlement/cancellation-window/per-ticket policy.
5. ✅ Missing/uncertain inputs fail **closed** → manual review.
6. ✅ `TICKET_ONLY` never auto-approved (needs finance sign-off) — enforced in policy **and** startup.
7. ✅ Check-in blocks auto-refund (policy gate).
8. ✅ Settlement uncertain/completed blocks refund.
9. ✅ Provider-confirmed cancellation stays manual (never auto-cancels a confirmed provider booking).
10. ✅ Inventory never auto-restored (`inventoryResellable:false` always).

### B. Provider-neutral capability accuracy

11. ✅ `supportsFullRefund / supportsIdempotentRefund / supportsRefundStatusQuery / refundMayBeAsynchronous` added.
12. ✅ Auto-refund gated on `supportsFullRefund && supportsIdempotentRefund`.
13. ✅ Honest adapters: **only mock** qualifies today; Stripe/PayPal/Square = full-but-not-idempotent → manual; Razorpay = async + status-queryable.
14. ✅ Mock provider `refund`/`getRefund` with fail/ambiguous scenarios (dev/test only).

### C. Execution spine (reused Phase-5 discipline)

15. ✅ Eligibility revalidation (defence-in-depth over the policy).
16. ✅ Captured-only (`SUCCEEDED`); already-`REFUNDED` = idempotent success without a call.
17. ✅ Amount invariant `0 < amount <= captured`; currency unchanged; provider ref required.
18. ✅ **Durable intent before the external call** (`PROCESSING` Refund row + `BookingPaymentRefundRequested`).
19. ✅ Stable idempotency key (compensation `idempotencyKey`) reused for dedupe + provider call.
20. ✅ Provider `refund()` classified: COMPLETED / async-PENDING / FAILED / throw.
21. ✅ **Exactly-once finalize** in one tx: guarded `payment SUCCEEDED→REFUNDED` + `refundedMinor=amount` + `booking→REFUNDED` + `Refund→COMPLETED` + `BookingPaymentRefunded`.
22. ✅ Ambiguous/async/timeout → **status recovery** via `getRefund`, never assumed successful.
23. ✅ Duplicate workers / recovery replays never double-refund (guarded `count===1`).
24. ✅ Outbox insert failure rolls the whole finalization back (provider refund stays recoverable).

### D. Reconciliation, admin & observability

25. ✅ Read-only financial reconciliation classifier (13 classifications incl. `OVER_REFUND`/`NEGATIVE_REFUND`/`DUPLICATE_COMPLETED_REFUND`).
26. ✅ Reconciliation moves no money; drift → manual review / bounded status re-query.
27. ✅ Admin approve/retry permits `PAYMENT_REFUND` only under AUTO_REFUND + approved policy; never edits amounts.
28. ✅ Executor re-validates every gate after an admin approval.
29. ✅ Counts-only refund health block (by state + `policyMode` + capable-provider flag); no ids/PII.
30. ✅ Metrics: refund counter (provider/outcome), duration histogram, status-recovery counter, policy-decision counter.
31. ✅ Domain events versioned + PII-free (requested/refunded/pending/ambiguous/rejected/recovery-requested/recovered).

### E. Flags, validation & rollout

32. ✅ Flags: `BOOKING_COMPENSATION_AUTO_REFUND_ENABLED=false`, `BOOKING_REFUND_POLICY_MODE=MANUAL_ONLY`, `BOOKING_REFUND_POLICY_VERSION`, `BOOKING_REFUND_STATUS_RECOVERY_ENABLED=false`, `_MAX_ATTEMPTS`, `_TIMEOUT_MS`, `_STATUS_POLL_INTERVAL_SECONDS`.
33. ✅ Startup **rejects** auto-refund without execution.
34. ✅ Startup rejects auto-refund with `MANUAL_ONLY`.
35. ✅ Startup rejects auto-refund with `TICKET_ONLY`.
36. ✅ Startup rejects auto-refund without an idempotent-full-refund-capable provider (non-mock).
37. ✅ Startup rejects auto-refund **in production**.

### F. Tests & docs

38. ✅ Unit: policy (9), executor (12), reconciliation (14), mock refund (6), config-matrix (Phase-6 subset), service dispatch (4), admin (3), health (1).
39. ✅ Real-Postgres: refund finalize-once + `0<=refunded<=captured` invariant + guarded late no-op.
40. ✅ ADR-043 Phase 6 section; matrix refund cases + reconciliation classes; runbook refund procedures + invariants.
41. ✅ P5 completion report (this file) + P6 hardening backlog produced.

### G. Discipline / scope

42. ✅ **STOP:** no new booking features, no orchestration redesign, no cross-provider failover, no dynamic pricing/loyalty/waiting-room/bot-mitigation/theatre-portal/customer-UX added. Feature scope closed.

## Remaining conditions (why CONDITIONAL, not unconditional GO)

These are **operational, not code** — they are intentionally _not_ marked done:

- **Staging execution** of a live refund against a real provider sandbox (mock proves the spine;
  a commercial-provider sandbox refund + status-recovery run has not been executed here).
- **Product/finance policy approval** to pick a non-`MANUAL_ONLY` mode and a real
  `BOOKING_REFUND_POLICY_VERSION`; `TICKET_ONLY` explicitly needs finance sign-off on the split.
- **Settlement wiring** — the executor currently treats settlement as _uncertain_ (fail-closed),
  so even `FULL_GROSS` resolves to manual review until a settlement lookup is wired. This is safe
  but means auto-refund is effectively dormant until P6 (see backlog #1).
- **Production monitoring/alerting** on the refund metrics + health before any production enablement.

## Merge note (unchanged from Stage-A readiness review)

This branch also carries **15 unmerged payments commits**; whether to merge them alongside the
booking-orchestration work is an owner decision and out of scope for this report. The branch is
**not** pushed/merged by this increment.
