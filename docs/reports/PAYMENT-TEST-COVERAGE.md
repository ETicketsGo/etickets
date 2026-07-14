# Payment Binding — Test Coverage Matrix

All tests use mocks and local fake secret managers; **no real provider API is
called in CI** (the only real-call path is the opt-in `npm run certify`).

| Required test                               | Spec file                                                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secret manager selection                    | `secrets/secret-manager.spec.ts` (`selectSecretManager`)                                                                                                |
| Production rejection of environment secrets | `secrets/secret-manager.spec.ts` (rejects `env` in UAT/STAGING/PRODUCTION)                                                                              |
| Provider factory construction               | `payments/provider/factory/payment-provider-factory.spec.ts`                                                                                            |
| Missing secret failure                      | `payment-provider-factory.spec.ts` (fails closed on unresolved secret)                                                                                  |
| Placeholder credential rejection            | `credential-validator` cases + factory spec                                                                                                             |
| Test-key rejection in production            | `payment-provider-factory.spec.ts` + `credential-validator`                                                                                             |
| Provider instance refresh after rotation    | `payment-provider-factory.spec.ts` (`refresh` invalidates + rebuilds)                                                                                   |
| Merchant activation rules                   | `payments/onboarding/merchant-onboarding.spec.ts`                                                                                                       |
| Environment promotion validation            | `payments/promotion/promotion.spec.ts`                                                                                                                  |
| Production readiness gate                   | `payments/readiness/payment-live-readiness.spec.ts`                                                                                                     |
| Failover safety                             | `payments/orchestration/resilient-executor.spec.ts` (no failover on terminal; pre-capture only) + `outage/payment-outage.spec.ts` (circuit force/reset) |
| Reconciliation discrepancies                | `payments/finance/finance-reconciliation.spec.ts`                                                                                                       |
| RBAC and tenant isolation                   | `auth/roles.guard.spec.ts` (ADMIN/SUPER_ADMIN only; CUSTOMER/ORGANIZER denied)                                                                          |
| Webhook replay protection                   | `payments/payments.service.spec.ts` (idempotent confirm — re-delivery ⇒ `already_confirmed`, no double-issue)                                           |
| Secret-safe error handling                  | `secrets/secret-manager.spec.ts` (no value in errors) + `common/all-exceptions.filter.spec.ts` (no provider-message leak)                               |
| Sandbox certification runner                | `payments/certification/certification.spec.ts`                                                                                                          |

Run: `cd apps/api && npx jest`. Current: **71 suites green**.
