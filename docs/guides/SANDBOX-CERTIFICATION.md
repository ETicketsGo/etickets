# Sandbox Certification Guide

Certification runs the end-to-end transaction lifecycle for a merchant/provider and
records an evidence report (ADR-027). A merchant should be certified (PASS) before
going live.

## The 10 steps

1. Provider health check
2. Create a low-value sandbox payment
3. Verify the payment webhook
4. Confirm the payment
5. Issue a ticket
6. Execute a partial refund
7. Verify the refund webhook
8. Reconcile the payment
9. Reconcile the refund
10. Verify the settlement projection

Each step records `PASS` / `FAIL` / `SKIP`. Webhook-dependent steps run via the
dummy signer or are `SKIP`-ped for real providers driven without a live webhook
(never a false pass). Result = `FAIL` if any step failed, `PARTIAL` if any skipped,
else `PASS`.

## Running it

**Admin (recorded, in-process):**

```
POST /admin/payments/onboarding/:id/certify
GET  /admin/payments/onboarding/:id/certifications
```

Or the "Run certification" button on the onboarding detail.

**Opt-in command (real sandbox calls — NOT part of CI):**

```bash
CERTIFY_ENABLED=true npm run certify -- <merchantOnboardingId>
```

Requires the merchant's sandbox credentials to be resolvable by the secret manager.
Exit code is non-zero on `FAIL`.

## Evidence

Each run stores env, provider, per-step status + detail, transaction references
(tx ids, never secrets), counts, operator, and timestamp — surfaced in the launch
gate and readiness (a recent PASS is a live-readiness requirement).
