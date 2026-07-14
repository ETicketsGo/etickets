# Payment Security Sign-Off

**Scope:** The production-binding payment layer (ADR-024…030) — secret manager,
provider factory, merchant onboarding, environment promotion, sandbox certification,
production safety controls, finance reconciliation, and outage operations — plus the
existing multi-provider payment platform it builds on.

**Date:** 2026-07-14 · **Reviewer:** Security Engineering · **Result:** APPROVED —
no Critical or High findings open.

---

## Review matrix

| Area                         | Control                                                                                                                                                                                                                                      | Status              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Secret access permissions    | Cloud backends use managed identity / default cred chains; `env` backend refused in UAT/STAGING/PRODUCTION (`selectSecretManager`).                                                                                                          | ✅ Pass             |
| Secret caching               | Short configurable TTL (`SECRET_CACHE_TTL_MS`); in-memory only; never serialized/logged.                                                                                                                                                     | ✅ Pass             |
| Rotation                     | `SecretCache.invalidate` + `PaymentProviderFactory.refresh` rebuild instances without restart; TTL bounds staleness.                                                                                                                         | ✅ Pass             |
| Credential masking           | `maskSecret` / `redactSecrets`; `SecretResolutionError` carries only the reference + safe reason, never the value.                                                                                                                           | ✅ Pass             |
| Admin RBAC                   | All payment admin controllers (`admin/payments/*`, onboarding, promotion, finance, outage) are `@Roles(ADMIN, SUPER_ADMIN)`; webhooks are `@Public` by design (signature-verified).                                                          | ✅ Pass             |
| Merchant isolation           | Onboarding/config are admin-managed; no cross-organizer read/write path.                                                                                                                                                                     | ✅ Pass             |
| Webhook signature validation | Every adapter verifies: mock/razorpay HMAC-SHA256, Stripe `constructEvent`, Square HMAC (url+body), PayPal server-side verify-webhook-signature. Router assembles per-scheme material.                                                       | ✅ Pass             |
| Replay protection            | Settlement confirm is idempotent — a conditional `PENDING_PAYMENT → CONFIRMED` claim means re-delivered/duplicate webhooks never double-confirm or double-issue.                                                                             | ✅ Pass (mitigated) |
| Test/live separation         | `credential-validator` (test-in-prod, live-in-lower-env, mode/credential agreement) + promotion + readiness checks.                                                                                                                          | ✅ Pass             |
| Audit completeness           | Every config/onboarding/promotion/certification/discrepancy/outage/failover mutation writes an `AuditLog`.                                                                                                                                   | ✅ Pass             |
| Provider error redaction     | `AllExceptionsFilter` renders non-`HttpException` errors as a generic 500 (`"Something went wrong."`) — raw SDK/provider messages never reach the client (regression-tested). Secret-manager errors are pre-redacted.                        | ✅ Pass             |
| Environment promotion abuse  | Forward-path only (DEV→…→PROD); two distinct approvers for PRODUCTION; requester cannot be a two-person approver; apply re-validates and writes the target **disabled**.                                                                     | ✅ Pass             |
| Production activation abuse  | `PAYMENT_LIVE_ENABLED` master switch (off by default) + payment-live readiness gate (env, secret-manager, maintenance, per-provider credentials/health/merchant/webhook/certification/route/circuit); fail-closed config validation on boot. | ✅ Pass             |

---

## Findings

No **Critical** or **High** findings.

**Low / residual (accepted, with recommendation):**

1. **Health-check detail strings** (`test-connection`, provider health, readiness)
   surface the provider SDK's error `message` to admins. These are ADMIN-only and
   unlikely to contain full secrets, but a defense-in-depth pass could run
   `redactSecrets` over them. _Owner: payments; non-blocking._
2. **Webhook replay** is mitigated by the idempotent confirm rather than an explicit
   transmission-id/nonce store. Adequate today; an explicit replay cache is a
   hardening option if a provider lacks idempotent semantics. _Owner: payments._
3. **Cloud secret managers are feature-gated** (lazy SDK import). Verify the SDK is
   installed and health is green in each real environment before go-live (covered by
   readiness + the launch gate). _Owner: DevSecOps._

---

## Verifications performed

- Static review of all `admin/payments/*` controllers for role guards.
- Confirmed the exception filter cannot echo a non-`HttpException` message
  (new regression test in `all-exceptions.filter.spec.ts`).
- Confirmed no raw secret is stored (only public identifiers + `*Ref` references)
  across `PaymentProviderConfig`, `MerchantOnboarding`, `MerchantAccount`.
- Confirmed test/live/placeholder enforcement in `credential-validator` and its
  reuse by the factory, promotion, and readiness services.

**Sign-off:** Approved for controlled commercial launch, subject to the launch
gate (GO/NO-GO by country/provider) and the residual Low items tracked above.
