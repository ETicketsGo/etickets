# ETicketsGo — Security Report (Hardening Sprint)

- **Date:** 2026-07-13
- **Scope:** `apps/api` (NestJS + Prisma + Postgres). Authorized hardening of the team's own codebase.
- **Sprint outcome:** 3 fixes landed (D7 auth rate-limiting, D5 refresh-token reuse detection, D8 financial-read RBAC), security tests expanded, no schema migration, no business-behaviour change. `npm run typecheck` clean; `npx jest` → **30 suites / 181 tests green**.

This report states protections **as they actually exist in the code**. Items not implemented this sprint are marked Deferred with a reason and remain in `docs/reports/TECH-DEBT-REGISTER.md`.

---

## Summary table

| Area                    | Status                                | Notes                                                                                                                                    |
| ----------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication          | OK                                    | bcrypt cost 12; JWT access (short TTL) + rotating opaque refresh tokens; refresh tokens stored **hashed** (SHA-256), never in plaintext. |
| Rate limits (auth)      | **Fixed this sprint (D7)**            | Per-route `@Throttle` 10 req/60s on `login` / `register` / `refresh`; global stays 120/60s.                                              |
| Refresh tokens          | **Fixed this sprint (D5)**            | Reuse of a revoked/rotated token now burns the whole family + rejects.                                                                   |
| Authorization / RBAC    | **Fixed this sprint (D8)** + OK       | Financial reads (payouts list, organizer event report) restricted to OWNER/MANAGER + admin. Global JWT + Roles guards.                   |
| Tenant isolation        | OK                                    | `OrgAccessService.assertMember` on every org-scoped path; admins bypass explicitly.                                                      |
| SQL injection           | OK                                    | Prisma parameterization everywhere, incl. raw queries and the seat-lock `Prisma.join`.                                                   |
| Security headers        | OK                                    | `helmet()` applied globally in `main.ts`.                                                                                                |
| CORS                    | OK                                    | Allow-list from `CORS_ORIGINS`, `credentials: true`.                                                                                     |
| Webhook validation      | OK                                    | HMAC-SHA256 signature compared with `timingSafeEqual`.                                                                                   |
| Payment security        | OK                                    | Atomic + idempotent money paths; confirmation only via signed webhook, never a browser redirect.                                         |
| QR security             | Deferred (D15)                        | Signed (HMAC + `timingSafeEqual`), but **no expiry window**; nonce/version not rotated on reversal.                                      |
| Cookies / token storage | Deferred (D6)                         | Tokens in `localStorage` (frontend); HttpOnly-cookie migration is a larger change.                                                       |
| CSRF                    | OK (current design) / revisit with D6 | Bearer-token auth (no ambient cookie) → no CSRF surface today; adding a cookie refresh (D6) will require CSRF protection.                |
| XSS                     | Partial                               | React auto-escaping + helmet; residual risk is the `localStorage` token (D6).                                                            |
| Audit logs              | OK                                    | `AuditService.record` on sensitive mutations (payout generate/paid, refund process, …).                                                  |
| API versioning          | Deferred (D12)                        | Single `/api` prefix; no `enableVersioning`.                                                                                             |

---

## Fixed this sprint

### 1. Auth-endpoint rate limiting (D7)

- **What:** Added `@Throttle({ default: { limit: 10, ttl: 60_000 } })` to `login`, `register`, and `refresh` in `apps/api/src/auth/auth.controller.ts` (constant `AUTH_THROTTLE`).
- **Values:** **10 requests / 60 s** per client, per route. Chosen to stop credential-stuffing / token-replay bursts while sitting far above any legitimate login/refresh flow (and the e2e suite's handful of logins).
- **Blast radius:** The global `ThrottlerModule` limit (120/60s) is **unchanged** for all other routes. The `ThrottlerGuard` is already registered globally as an `APP_GUARD` in `app.module.ts`, so the per-route override takes effect with no wiring change.
- **Residual:** `trust proxy` is still unset, so throttling keys on the socket IP; behind a reverse proxy all clients can share one key. Tracked as the remainder of D7 (needs an infra/deploy decision on the proxy hop count).

### 2. Refresh-token reuse detection (D5)

- **Where:** `AuthService.refresh()` in `apps/api/src/auth/auth.service.ts`.
- **How it works:** The presented token is SHA-256 hashed and looked up.
  - Unknown token, or expired-but-not-revoked → rejected as before (no side effects).
  - **Recognized but already `revokedAt` set** → this is a replay of a token that was already rotated (or logged out). The same secret now exists in two places, i.e. a compromise signal. The service revokes **every still-active refresh token for that user** (`updateMany where { userId, revokedAt: null }`), then rejects — forcing a fresh sign-in everywhere and burning any token the attacker may hold.
  - Valid token → normal rotation is untouched: issue a new pair, then revoke the used token and link `replacedByTokenId` to the replacement.
- **Schema:** No migration. Uses the existing `RefreshToken` fields (`id`, `userId`, `revokedAt`, `replacedByTokenId`, `tokenHash`).
- **Tests:** `apps/api/src/auth/auth.service.spec.ts` — valid token rotates (no family revoke); replayed revoked token triggers the family `updateMany` and rejects; unknown/expired tokens reject without burning the family.

### 3. Financial-read role tightening (D8)

- **Where:** `PayoutsService.listForOrg` (`apps/api/src/payouts/payouts.service.ts`) and `ReportsService.organizerEventReport` (`apps/api/src/reports/reports.service.ts`).
- **How:** Both now pass `allowedRoles: [ORGANIZER_OWNER, ORGANIZER_MANAGER]` to `assertMember`, mirroring how `RefundsService.process` gates to owner. Platform admins still bypass via `isPlatformAdmin`. Any other active member — notably `CHECKIN_STAFF` — is now `TENANT_FORBIDDEN` on these settlement/revenue reads.
- **AnalyticsService.organizer:** Verified already gated — `canViewFinancials()` omits the `revenue`/`refunds`/`coupons` blocks for non-OWNER/MANAGER members (non-financial attendance/conversion metrics remain visible by design). **Left unchanged.**
- **Not touched:** `PayoutsService.generate` / `markPaid` (mutations, admin/owner-driven and separately guarded) — out of scope for this "financial-read" item; behaviour preserved.
- **Tests:** `apps/api/src/payouts/payouts.service.spec.ts` and new `apps/api/src/reports/reports.service.spec.ts` — CHECKIN_STAFF forbidden; OWNER/MANAGER/admin allowed; read short-circuits before any aggregation on denial.

---

## Reviewed — OK (no change needed)

- **SQL injection:** All persistence goes through Prisma's parameterized client. Raw SQL (`reports.service.ts` sales-by-day, `analytics.service.ts` favorite orgs/venues) uses tagged-template `$queryRaw` with interpolated **parameters**, not string concatenation; the seat-lock in `inventory/seat-based.strategy.ts` builds its `IN (...)` list with `Prisma.join`, which emits bound placeholders. No dynamic SQL string building found.
- **Headers / CORS:** `helmet()` is applied globally and CORS is an explicit allow-list from `CORS_ORIGINS` (`main.ts`), with `credentials: true`.
- **Password storage:** `bcrypt.hash(password, 12)` on register; `bcrypt.compare` on login; a missing user still runs the compare path so responses don't trivially leak account existence beyond the generic error.
- **Webhook validation:** Payment confirmation is driven by a signed webhook (`payments/provider/mock-payment.provider.ts`), verified with HMAC-SHA256 and a **length-checked `timingSafeEqual`** comparison — constant-time, no early-exit oracle. Browser redirects are never trusted to confirm payment.
- **Payment security / money paths:** Confirmed atomic and idempotent (prior sprint) — payout finalize is a single guarded `updateMany` (pay-once under concurrent admins), only one open payout per scope, refunds claim `REQUESTED → PROCESSING` atomically before calling the provider (provider called at most once; failure marks `FAILED`).
- **Tenant isolation:** Every org-scoped service call runs `OrgAccessService.assertMember`; platform-admin bypass is explicit and unit-tested.
- **Audit logs:** Sensitive mutations record via `AuditService` (actor, org, action, entity).
- **CSRF:** With `Authorization: Bearer` tokens and no ambient session cookie, there is no cross-site request-forgery surface for authenticated calls today. (This changes if D6 introduces a cookie-based refresh — see below.)

---

## Deferred (accepted, with reason) — see TECH-DEBT-REGISTER

- **D6 — token storage in `localStorage` → HttpOnly cookie.** Deferred: a larger frontend change (access token in memory, refresh in `HttpOnly`+`Secure`+`SameSite` cookie, plus CSRF for the cookie refresh). Residual risk: any XSS on a web app yields a persistent account takeover. **Highest-priority security backlog item.**
- **D15 — QR token expiry / rotation.** Deferred: `QrService.verify` validates the HMAC signature but never checks `issuedAt` against a validity window, and `nonce`/`version` are not rotated on check-in reversal. Enforcing an expiry could break in-flight check-in flows, so it needs a coordinated rollout. Mitigations today: tokens are server-signed (not forgeable) and check-in state is enforced server-side.
- **D12 — API versioning.** Deferred: single `/api` prefix; no `enableVersioning`. No security impact; operational/compatibility concern.
- **D7 remainder — `trust proxy`.** Deferred: throttle now keys on socket IP; correct per-client keying behind a proxy needs a deployment decision.

## Residual security backlog (priority order)

1. **D6** — move refresh token to an `HttpOnly` cookie + CSRF (eliminates XSS→persistent-ATO).
2. **D7 remainder** — configure `trust proxy` so auth throttling keys on the real client IP.
3. **D15** — QR validity window + nonce/version rotation on reversal.
4. **D12** — API versioning (`/api/v1`).
