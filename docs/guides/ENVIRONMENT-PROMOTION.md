# Environment Promotion Guide

Promote a provider configuration forward — **DEV → QA → UAT → STAGING → PRODUCTION**
— with validation and approval. Configuration is never copied blindly (ADR-026).
Console: `/admin/payment-promotion`; API: `/admin/payments/promotion/*`.

## Flow

1. **Preview report** (`GET .../promotion/report?from&to&provider`) — runs the
   validation checklist against the target env.
2. **Request** (`POST .../promotion`) — files a `PromotionRequest` with the report;
   PRODUCTION requires **two** approvals.
3. **Approve** (`POST .../:id/approve`) — distinct approvers; the requester cannot be
   a two-person approver.
4. **Apply** (`POST .../:id/apply`) — re-validates, then writes the target config
   with remapped secret refs + the correct mode, **disabled**. Enabling stays a
   separate deliberate action.

## Validation checklist

Provider enabled in source, not the dummy provider, credentials match the required
mode, secret references present + resolvable, secret manager healthy, webhook
configured, production endpoint selected, no test keys in production, no live keys
in a lower env (unless explicitly allowed), a target route exists, provider health
passing. (A verified merchant in the target is advisory.)

## Secret reference remap

References are remapped to the target env token:
`payments/stripe/test/secret-key` → (PRODUCTION) → `payments/stripe/production/secret-key`.
Ensure the target secrets exist in the secret manager before applying.

## Two-person approval

PRODUCTION promotions need two distinct approvers. If your role model later adds a
dedicated approver role, require the second approver to hold it; today distinct
ADMIN/SUPER_ADMIN users satisfy the control. Every step is audited.
