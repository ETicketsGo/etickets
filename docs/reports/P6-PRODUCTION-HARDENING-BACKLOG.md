# P6 — Production Hardening Backlog (Booking Compensation & Refunds)

Handoff after P5 close. The booking-engine **feature** scope is frozen (see
`P5-BOOKING-PLATFORM-COMPLETION-REPORT.md`); everything here is hardening, operationalization, and
prerequisites for **safely enabling** money movement in production. Nothing below is a new booking
feature. Ordered roughly by "must-do before production auto-refund" → "nice-to-have".

## Gate: prerequisites before ANY production auto-refund

1. **Settlement lookup wiring.** The refund executor passes `settlementStatus: undefined`
   (fail-closed) — so auto-refund is dormant even under `FULL_GROSS`. Wire a real settlement
   state read (`Payment.settlementId` → `Settlement.status`) into the policy context before
   enabling. Until then, refunds are manual-review-only regardless of flags.
2. **Product/finance policy sign-off.** Choose the production `BOOKING_REFUND_POLICY_MODE` and a
   real `BOOKING_REFUND_POLICY_VERSION`; document the approving owner. `TICKET_ONLY` requires the
   fee/component split to be defined and signed off (currently blocked by design).
3. **Commercial-provider idempotent refund proof.** No production provider advertises
   `supportsIdempotentRefund` today. Verify + set the capability per provider only after a sandbox
   proof of idempotent full refund + refund-status query (Stripe/PayPal/Square/Razorpay).
4. **Sandbox e2e per provider.** Execute a real refund + async/ambiguous recovery against each
   provider sandbox; capture evidence. Mock-only proof is insufficient for production.
5. **Production enablement runbook + change ticket.** Staged rollout (staging → limited cohort →
   general) with an explicit rollback (`AUTO_REFUND_ENABLED=false` / restore `MANUAL_ONLY`).

## Reliability & correctness hardening

6. **Durable status-recovery worker.** Today recovery is inline in the executor. Add a scheduled
   reconciliation/recovery job that sweeps `PROCESSING` refund intents past the age threshold and
   drives `INTENT_WITHOUT_OUTCOME` → `getRefund`, bounded + audited.
7. **Refund reconciliation service + persisted classifications.** Promote
   `classifyRefundReconciliation` into a scheduled service that queries local+provider state and
   records/exposes classifications (currently a pure function used ad hoc).
8. **Partial-refund policy & data model.** Explicitly out of scope in P5. If ever needed, design a
   verified partial policy (amount source, fee/tax handling, per-ticket) + data model + invariants
   before any implementation.
9. **Settlement reversal / clawback path.** Post-settlement refunds (funds already moved to the
   organizer) need a reversal/clawback flow; currently blocks to manual review.
10. **Chargeback / dispute interplay.** Ensure a refund and an inbound dispute on the same payment
    can't both finalize (guard + reconciliation class).
11. **Refund amount vs `refundedMinor` ledger for multi-refund futures.** Current full-refund sets
    `refundedMinor == captured`; a future multi/partial world needs a cumulative-sum guard at the DB.
12. **Provider webhook ingestion for refunds.** Add signed refund-webhook handling that feeds the
    same guarded exactly-once finalize (complements polling recovery).
13. **Idempotency key rotation/audit.** Confirm the compensation `idempotencyKey` is stable across
    retries for every provider's refund idempotency semantics.
14. **Timeout/attempt tuning.** `BOOKING_REFUND_TIMEOUT_MS` / `_MAX_ATTEMPTS` /
    `_STATUS_POLL_INTERVAL_SECONDS` defaults are conservative guesses — tune from sandbox latency.

## Observability & operations

15. **Alerting** on refund `MANUAL_REVIEW` / `DEAD_LETTERED` backlog growth, `OVER_REFUND` /
    `NEGATIVE_REFUND` (should be zero → page), and status-recovery failure rate.
16. **Dashboards** for refund throughput, outcome mix, recovery latency, policy-decision reasons.
17. **Audit completeness review** — ensure every refund approval/finalize/failure is audited with
    actor + correlation id (admin path audits today; verify the worker path).
18. **Customer-facing refund status** surface (booking status → "Refunded"/"Action pending") wired
    to the domain events, with copy reviewed. (Status values exist; UX intentionally not built.)
19. **Operator refund dry-run UX** — the planner dry-run exists; add a refund-specific preview that
    shows the policy decision + eligibility gate results without executing.

## Security & compliance

20. **PII review** of refund events/health/logs (currently PII-free by construction — re-audit
    after webhook + reconciliation persistence lands).
21. **RBAC review** for the refund-approve endpoint (financial action — confirm scope + 4-eyes if
    finance requires dual approval).
22. **Rate/again-limit** on admin refund approval to prevent bulk-approval mistakes.

## Debt & follow-through carried from earlier stages

23. **Branch merge decision** — this branch carries 15 unmerged payments commits; owner to decide
    merge order/strategy (out of P5 scope).
24. **Durable outbox external broker adapter (P2.1 deferred)** — refund events currently flow the
    in-process outbox path; an external broker adapter remains deferred.
25. **Active-mode inventory-lock wiring (P3 deferred)** — `INVENTORY_LOCKS_ENABLED` shadow-mode
    only; refund never restores inventory, but active-mode wiring remains a separate track.

---

**Definition of "done" for enabling production auto-refund:** gate items 1–5 complete + at least
items 6, 15, 16 in place. Until then the platform stays in its safe default: **manual review, no
automatic captured-money movement, production-forbidden.**
