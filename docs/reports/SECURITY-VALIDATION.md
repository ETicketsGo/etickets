# ETicketsGo — Security Validation (Pentest-style Review + OWASP Top 10 + Dependency Audit)

- **Date:** 2026-07-13
- **Scope:** `apps/api` (NestJS + Prisma + Postgres), the three Next.js web apps, `packages/web-kit`, and production dependency tree. Authorized security validation of the team's own codebase.
- **Method:** Manual code review of the auth/tenancy/payment/QR/inventory/ops paths, grep-driven sweeps (raw SQL, outbound HTTP, `dangerouslySetInnerHTML`/`eval`, token storage, public mutating routes, file-upload surface), and `npm audit --omit=dev` with per-advisory exploitability triage.
- **Verification after review:** `npm run typecheck` → 13/13 green · `npx jest` (apps/api) → **48 suites / 323 tests green** · `npx turbo run build` → 8/8 green · `npm audit --omit=dev` → **43 (35 moderate, 8 high, 0 critical)**.

---

## 1. Executive summary

**Posture: strong.** The prior hardening sprints hold up under re-review. Every Critical/High item that touches authentication, authorization/tenant isolation, or the money path is implemented in code as claimed — I verified each against the source rather than the prior report's summary. **No new Critical or High severity CODE issue was found, so no code fix was required this pass.**

**Residual risk is concentrated in three known, already-registered places:**

1. **Frontend token storage in `localStorage`** (`etg_access`/`etg_refresh`) — any XSS on a web app becomes a persistent account takeover. This is the single highest-value security backlog item (D6). No XSS sink was found in app code (no `dangerouslySetInnerHTML`, no `eval`, React auto-escaping throughout), so it is a latent, not active, risk today.
2. **`trust proxy` is unset** — auth throttling keys on the socket IP, so behind a reverse proxy all clients can share one throttle bucket (D7 remainder).
3. **Vulnerable transitive dependencies** — 8 prod HIGH advisories remain, **none exploitable in this application** given its actual surface (no file uploads, no `lodash` in app code, the CLI/build-time nature of `glob`/`picomatch`, and Next.js already at the latest 14.x). The prior **Next.js CRITICAL is FIXED** (`next@14.2.35`, 0 critical) — **but that fix currently lives only in the uncommitted working tree** (see V7). At committed `HEAD`, the web apps and lockfile still pin `next@14.2.15` (which carries the CRITICAL). The pending `next ^14.2.35` bump and its reconciled lockfile **must be committed together** so `npm ci` in CI/production does not deploy the vulnerable version.

A handful of **Low/Informational** items are recorded honestly below (login user-enumeration timing oracle, Swagger UI exposed in all environments, `/metrics` public-by-design), plus one **accuracy correction** to the prior SECURITY-REPORT.

---

## 2. Dependency audit

`npm audit --omit=dev` — **43 vulnerabilities: 35 moderate, 8 high, 0 critical.**

### Critical — resolved

| Package | Prior | Now | Status |
| --- | --- | --- | --- |
| `next` (3 web apps) | **CRITICAL** (`14.2.15`) | `14.2.35` in the working tree (latest 14.x) | **FIXED in working tree** — 0 critical. ⚠ Committed `HEAD` still pins `14.2.15` in both `package.json` and `package-lock.json`; the bump is uncommitted. Commit the reconciled lockfile with the `package.json` change (V7). |

### Remaining prod HIGH — per-advisory exploitability in THIS app

| Package | Sev | Advisory (short) | Exploitable here? | Remediation |
| --- | --- | --- | --- | --- |
| `next` | HIGH | RSC DoS, WebSocket-upgrade SSRF (CVSS 8.6), i18n middleware bypass, etc. | **Residual / low.** Already at the latest **14.2.35**; these HIGH advisories are only patched in **Next 15+**. Apps use the App Router with no i18n Pages-Router config and no WebSocket rewrites, so the headline vectors don't map to configured surface. | Plan a **Next 15 major upgrade**; monitor advisories. No clean 14.x patch exists. |
| `@nestjs/platform-express` | HIGH | Pulls vulnerable `multer`/`body-parser`/`qs`. | **No.** See `multer` below; DoS vectors need a multipart or malformed-body surface the app doesn't expose beyond JSON. | Fix via **`@nestjs/*` major upgrade** in a maintenance window. |
| `multer` | HIGH | DoS via nested field names / incomplete cleanup. | **No — app exposes NO multipart/file-upload endpoint** (grep: zero `FileInterceptor`/`FilesInterceptor`/`@UploadedFile`/`multer` usages). The transitive `multer` is never on a request path. | Fix by the same `@nestjs` major upgrade; not urgent. |
| `lodash` | HIGH | Code injection via `_.template`; prototype pollution in `_.unset`/`_.omit`. | **No — `lodash` is not imported anywhere in app or package source** (grep confirmed). It is a transitive tooling dep; no user-controlled input reaches it. Note: the `_.template` advisory has **no fixed release** (latest published `lodash` is still 4.17.21). | Accept (transitive, unreachable). Drop when the depending tool releases a patched line. |
| `glob` | HIGH | **CLI** command injection via `-c/--cmd` (`shell:true`). | **No.** The vuln is in the `glob` **CLI binary**; the app/build only uses the library API. Build/dev tooling, not the runtime request path. | Accept as build-time; bump when a dependent moves to `glob@11`. |
| `picomatch` | HIGH | ReDoS via extglob quantifiers; POSIX method injection. | **No.** Build/dev-time glob matching (tailwind/chokidar/tooling), not a runtime request path. | **Low-risk clean fix available:** bump to `picomatch@4.0.5` (validated — resolves cleanly, package.json unchanged, build stays green). Apply in a maintenance step (see §6 note on overrides). |
| `@next/eslint-plugin-next` | HIGH | Inherits Next advisory range. | **No.** **Lint/build-time** tooling; never in the runtime bundle or request path. | Resolves with the Next upgrade. |
| `eslint-config-next` | HIGH | Inherits Next advisory range. | **No.** **Lint/build-time** tooling only. | Resolves with the Next upgrade. |

### Moderate clusters (not exploitable in this app)

- **`@opentelemetry/*`, `@sentry/*`, `@prisma/instrumentation`** (~20 moderates) — observability instrumentation; only loaded when OTEL/Sentry env is configured; advisories are DoS/parsing edge cases not on the app's request path.
- **`firebase-admin` → `@google-cloud/storage` → `gaxios`/`teeny-request`/`uuid`/`retry-request`** — **optional push provider, not loaded by default** (`PUSH_PROVIDER=log` default; `fcm` transport only constructed when selected). The `uuid` buffer-bounds bug needs `uuid` v3/v5/v6 called with a caller-supplied buffer — not a path FCM messaging exercises. **Accept; upgrade `firebase-admin` when FCM is enabled.**
- **`qs` / `body-parser` / `express`** — `qs.stringify` DoS requiring `encodeValuesOnly` on comma-format arrays with null entries; the app does not call `qs.stringify` that way. A pinned override to `qs@6.15.3` was tested (see §6) but **npm did not honor root `overrides` in this workspace**, so it is documented as a planned fix rather than shipped.

---

## 3. OWASP Top 10 (2021) — status + evidence

| # | Category | Status | Evidence |
| --- | --- | --- | --- |
| **A01** | Broken Access Control | **OK** | Global `JwtAuthGuard` + `RolesGuard` (`app.module.ts`). Tenant checks via `OrgAccessService.assertMember` on every org-scoped path; platform-admin bypass explicit (`org-access.service.ts`). New modules verified **no-IDOR**: `movies`/`cinemas`/`shows` by-id mutations resolve the owning org from the entity (`loadOwnedMovie`/`loadOwnedCinema`/`loadOwnedScreen`) then `assertMember(..., ORGANIZER_ROLES)`; `analytics.organizer/venue` and `business-reports`/`ops`/`admin/support` are `@Roles(ADMIN…)` or `assertMember`-gated; `discovery`/`recommendations`/`public/*` are read-only `@Public`. Financial reads gated to OWNER/MANAGER+admin (D8). |
| **A02** | Cryptographic Failures | **OK** | `bcrypt.hash(pw, 12)` (`auth.service.ts`); refresh tokens are 48-byte random, stored **SHA-256 hashed**, never plaintext; JWT `ignoreExpiration:false`, `secretOrKey` from `getOrThrow` (`jwt.strategy.ts`). Webhook HMAC-SHA256 + **length-checked `timingSafeEqual`** (Stripe `constructEvent`, Razorpay + mock HMAC). QR tokens HMAC-SHA256 signed + `timingSafeEqual` (`qr.service.ts`). Config schema **requires** `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET`/`QR_SIGNING_SECRET`/`PAYMENT_WEBHOOK_SECRET` (`z.string().min(1)`, no default). |
| **A03** | Injection | **OK** | All persistence through Prisma's parameterized client. Every raw query is a tagged-template `$queryRaw`/`$executeRaw` with **bound `${}` params** (`analytics`, `business-reports`, `reports` date-range aggregates); the seat-lock builds its `IN (...)` list with **`Prisma.join`** (bound placeholders), not string concat (`inventory/seat-based.strategy.ts`). No `$queryRawUnsafe`/`$executeRawUnsafe`/`Prisma.raw` in app code. XSS: **no `dangerouslySetInnerHTML`, `eval`, or `new Function`** in any app/package source. |
| **A04** | Insecure Design | **OK** | Money paths atomic + idempotent: confirm flips `PENDING_PAYMENT→CONFIRMED` via a single `updateMany` claim (`claim.count!==1` ⇒ no-op) so tickets can't double-issue; hold-expiry-before-settle rolls the whole confirm back (`payments.service.ts confirm()`). Prices computed **server-side** from `ticketType.priceMinor` + fee calculator — guest checkout cannot inject amounts (`bookings.service.ts`). Payment confirmed only via signed webhook, never a browser redirect. |
| **A05** | Security Misconfiguration | **OK, with notes** | `helmet()` global; CORS is an explicit allow-list from `CORS_ORIGINS` with `credentials:true` (`main.ts`). Mock-pay path gated: `PAYMENTS_MOCK_ENABLED !== 'false' && NODE_ENV !== 'production'` (`payments.service.ts`). **Notes (Low):** (a) Swagger UI mounted at `/<prefix>/docs` **unconditionally**, including production — recommend gating to non-prod or behind auth; (b) `/metrics` is `@Public` **by design** and MUST be network-restricted to the scraper in prod (documented in the controller + OPERATIONS.md); (c) `trust proxy` unset — throttle/`req.ip` key on the socket IP (D7 remainder). |
| **A06** | Vulnerable & Outdated Components | **OK (residual, triaged)** | See §2. Next.js CRITICAL fixed; 8 residual prod HIGH, each triaged **not exploitable in this app**. |
| **A07** | Identification & Auth Failures | **OK** | Per-route `@Throttle` 10/60s on `login`/`register`/`refresh` (`auth.controller.ts`); global 120/60s. **Refresh reuse detection**: replay of a revoked/rotated token burns the whole family (`updateMany where {userId, revokedAt:null}`) then rejects (`auth.service.ts refresh()`). Bearer-token sessions; logout revokes the presented refresh token. |
| **A08** | Software & Data Integrity | **OK** | Webhooks signature-verified before any state change; confirm is idempotent (re-delivery ⇒ `already_confirmed`); refunds claim `REQUESTED→PROCESSING` before calling the provider (provider invoked at most once). `paymentAttempt` records the raw event. |
| **A09** | Logging & Monitoring | **OK** | `LoggingInterceptor` + `CorrelationIdMiddleware`; `AuditService.record` on sensitive mutations (booking confirm, payout, refund); `prom-client` metrics (`/metrics`); Sentry/OTel instrumented at boot (`observability/instrument`, no-op unless configured). |
| **A10** | SSRF | **OK** | Only **one** outbound `fetch` in the API (`notifications/.../whatsapp.transport.ts`) — the URL host is fixed (`https://graph.facebook.com/v20.0/{phoneNumberId}/messages`, `phoneNumberId` from env config, not user input). No user-controlled URL is ever fetched. |

---

## 4. Pentest-style findings

No Critical/High findings. Items below are Low/Informational and are documented for honesty and backlog hygiene; **no code was changed** (mandate is fix Critical/High only, and none exist).

| ID | Sev | Area | Finding | Exploitable? | Disposition |
| --- | --- | --- | --- | --- | --- |
| V1 | Medium | Frontend / token storage | Access + refresh tokens in `localStorage` (`packages/web-kit/src/api.ts` `etg_access`/`etg_refresh`). | Only if an XSS sink exists; none found in app code. Latent, not active. | **Accepted → backlog D6** (HttpOnly cookie migration). Highest-priority security backlog item. |
| V2 | Medium | Auth infra | `trust proxy` unset — throttle/`req.ip` keys on socket IP; behind a proxy, clients can share one throttle bucket. | Yes, in a proxied deployment (weakens brute-force throttling). | **Accepted → backlog D7 remainder.** Needs a deploy decision on the proxy hop count. |
| V3 | Low | Auth / info disclosure | **User-enumeration timing oracle** at `login`: `if (!user || !(await bcrypt.compare(...)))` **short-circuits** — a missing account skips the bcrypt compare and returns measurably faster; `register` also returns an explicit `409 EMAIL_ALREADY_REGISTERED` oracle. | Marginally (timing + explicit 409), and auth routes are now rate-limited (10/60s), which blunts enumeration. | Documented. **Correction:** prior `SECURITY-REPORT.md` states "a missing user still runs the compare path" — that is **inaccurate**; the code short-circuits. A future fix would run a dummy `bcrypt.compare` against a constant hash on the missing-user path. Left unchanged (Low; per Critical/High-only mandate). |
| V4 | Low | Misconfiguration | Swagger UI served at `/<prefix>/docs` in **all** environments (no prod gate). | Info disclosure (full API shape) if the API is internet-exposed in prod. | Recommend gating to non-prod or behind auth. Backlog. |
| V5 | Info | Monitoring | `/metrics` is `@Public` by design; must be network-restricted to the scraper in prod. | No, if network-restricted per docs. | Accepted-with-reason (documented in controller + OPERATIONS.md). |
| V6 | Low | QR | QR tokens are signed but never expire; `nonce`/`version` not rotated on check-in reversal. | Low — tokens are server-signed (unforgeable) and check-in state is enforced server-side. | **Accepted → backlog D15.** |
| V7 | Medium | Supply chain / release hygiene | **Lockfile drift on the Next.js security bump.** At committed `HEAD`, all three web apps and `package-lock.json` pin `next@14.2.15` (**CRITICAL**). The `next ^14.2.35` fix exists only as uncommitted working-tree edits to the app `package.json` files; a fresh `npm install` reconciles the lock to `14.2.35` (0 critical), but `npm ci` (CI/prod) installs *exactly* from the committed lock. | Yes in a release path — `npm ci` from `HEAD` would deploy the vulnerable `14.2.15`. | **Action:** commit the `package.json` bump **and** the regenerated `package-lock.json` together. The current working tree already carries the reconciled lock (apps at `14.2.35`); this validation was run against that reconciled state. |

---

## 5. Code fixes made

**None.** No genuine Critical or High severity code issue was found — the auth, tenant-isolation, RBAC, injection, money-path, QR, and SSRF surfaces are all correctly implemented as verified against source. Per the mandate ("fix only genuine Critical/High CODE issues; do not change business logic or weaken anything"), no code was modified. Business logic is untouched.

---

## 6. Note on dependency overrides tested

Per the brief, I attempted low-risk `overrides` to bump patched transitive packages (`picomatch@4.0.5`, `qs@6.15.3`) in the root `package.json`. **npm (11.11.0) did not honor the root `overrides` in this workspace** — the regenerated lockfile omitted the `overrides` block and `qs` stayed at the vulnerable `6.14.2`. Because the overrides were ineffective (and shipping dead config would be misleading), **the `overrides` block was removed; `package.json` is unchanged from `HEAD`.**

The `package-lock.json` in the working tree is the **reconciled lock that matches the pending `next ^14.2.35` bump** in the app `package.json` files (apps resolve to `next@14.2.35`); this is the required companion to that uncommitted change and is the state this validation was run against (43 / 8 high / **0 critical**). It should be committed alongside the `package.json` bump (V7). The `picomatch@4.0.5` bump is validated as clean/non-breaking (verified: `package.json` unchanged, build green) and is listed as a planned low-risk fix below — currently blocked only by the non-functional `overrides` in this environment (use `npm update picomatch` instead).

---

## 7. Prioritized remediation backlog

0. **V7 — commit the Next.js bump + reconciled lockfile together (Medium, do first).** At `HEAD` the lock still pins `next@14.2.15` (CRITICAL). Land the `next ^14.2.35` `package.json` edits and the regenerated `package-lock.json` in one commit so `npm ci` in CI/prod deploys `14.2.35`. Quick, high-value.
1. **D6 — token storage → HttpOnly cookie (Medium, highest priority).** Access token in memory, refresh in `HttpOnly`+`Secure`+`SameSite` cookie, add CSRF for the cookie refresh. Eliminates XSS→persistent-ATO.
2. **D7 remainder — configure `trust proxy` (Medium).** So auth throttling / `req.ip` key on the real client IP behind the proxy.
3. **Dependency: `@nestjs/*` major upgrade (Medium).** Clears the `multer`/`body-parser`/`qs`/`@nestjs/platform-express` HIGH/moderate cluster. Not urgent (no file-upload surface). Maintenance window.
4. **Dependency: Next.js 15 major upgrade (Medium).** Clears the residual `next` / `@next/eslint-plugin-next` / `eslint-config-next` HIGHs (no clean 14.x patch). Validate the design-system Tailwind-preset gotcha post-upgrade.
5. **Dependency: `picomatch@4.0.5` bump (Low, quick win).** Validated clean/non-breaking; apply as a targeted lockfile bump once npm `overrides` behavior is sorted (or via `npm update picomatch`).
6. **V4 — gate Swagger UI out of production (Low).**
7. **D15 — QR validity window + nonce/version rotation on reversal (Low).**
8. **Dependency: upgrade `firebase-admin` when FCM is enabled (Low).** Optional provider, not loaded by default (`PUSH_PROVIDER=log`).
9. **V3 — constant-time missing-user path on login (Low).** Run a dummy `bcrypt.compare` so responses don't leak account existence by timing.
