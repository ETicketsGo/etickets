# SEC-1 Batch A3 — Next.js Runtime Family Remediation

**Branch:** `chore/sec1-nextjs-runtime-remediation`
**Base:** `main` @ `96328690` (after PR #28 Sentry A2 merged)
**Scope:** Next.js runtime family only (customer-web, admin-web, organizer-web, web-kit). No React
major, no ESLint/Firebase/Google/Vitest/Jest/Sentry/NestJS change; no backend behaviour change; no
product features.
**Verdict:** **CONDITIONAL GO** — the launch-blocking Next.js **critical is removed** and all
Next.js-framework highs are cleared; one residual "next" high is an unreachable transitive (`sharp`,
see §Security). Standard CI must confirm on the PR.

## Target-version decision (Stages 4–5)

- `next@14.2.35` is the **end of the 14.x line** (14.2 max = 14.2.35); **no 14.x patch exists**. It
  carries an unpatched **critical** (Next.js middleware authorization-bypass class) plus many high
  Server-Component DoS / SSRF / cache-poisoning advisories.
- **Next 15 and Next 16 both accept `react: ^18.2.0`** (verified peerDependencies) — **React 19 is
  NOT mandatory**; React 18.3.1 is supported. The failure-policy React-major STOP does not trigger.
- **ESLint constraint is decisive:** `eslint-config-next@15` accepts ESLint `^8` (installed 8.57.1);
  `eslint-config-next@16` **requires ESLint ≥9** — a tooling major explicitly out of scope for this
  batch. **Next 16 is therefore out of scope; Next 15 is the correct, lowest-risk secure target.**
- Node 24 satisfies both engines.

**Chosen target: `next@15.5.22` + `eslint-config-next@15.5.22`, React/React-DOM kept at 18.3.1,
ESLint kept at 8.57.1.**

## Versions before → after

| Package (all 3 web apps)  | Before   | After                                |
| ------------------------- | -------- | ------------------------------------ |
| `next`                    | ^14.2.35 | **^15.5.22**                         |
| `eslint-config-next`      | ^14.2.35 | **^15.5.22**                         |
| `react` / `react-dom`     | ^18.3.1  | **^18.3.1** (unchanged)              |
| `@types/react` / `-dom`   | ^18.3.x  | ^18.3.x (unchanged)                  |
| `packages/web-kit` `next` | 14.2.15  | **^15.5.22** (devDep, for typecheck) |

**Deliberately unchanged:** React, ESLint (8.57.1), NestJS 11, Sentry 10, Firebase/Google SDKs,
Vitest/Jest, all UI libraries, all backend deps.

## Breaking changes that applied

Next 15 made request `params`/`searchParams` **async (Promises)**. Exactly **one** file used them
synchronously — `apps/customer-web/app/blog/[slug]/page.tsx` (a static blog route) — migrated to
`params: Promise<{ slug }>` + `await params` in both the page and `generateMetadata`. **No other
Next 15 breaking change applied:** no `next/headers` (`cookies()`/`headers()`/`draftMode()`) usage,
no server actions, no middleware, no server-side `fetch()` to the API (all data is client-side React
Query — see §Cache). admin-web and organizer-web built with **zero** source changes.

## Lockfile changes (Stages 6–7)

Clean regeneration (`rm -rf node_modules package-lock.json && npm install`), reproduced with a second
`npm ci` — single coherent `next@15.5.22`, single `react@18.3.1` / `react-dom@18.3.1`, no peer
errors, no incompatible duplicates. Non-Next drift:

- **`@img/sharp-*` (72 platform binaries) ADDED** — Next 15 replaced the old squoosh image fallback
  with `sharp`. **Unused by this app** (zero `next/image` imports — see §Security).
- **`^`-range re-floats** on unrelated runtime deps within existing ranges (no manifest change):
  `stripe` 22.3.2→22.4.0, `bullmq` 5.81.2→.3, `jose` 6.2.4→.5, plus transitive placement shuffles
  (`mime-types`, `source-map`, `commander`, `lru-cache`). All covered by the green backend suite.
- NestJS 11 / Sentry 10 / Express 5 confirmed intact after the regen.

## App-by-app results (Stage 8)

- **customer-web** — typecheck ✓, production build ✓ (46 static pages). One async-params migration
  (blog route). Wallet, events/sessions, booking flow, payment init, offline, SW registration, auth,
  API client all client-side React Query — unaffected.
- **admin-web** — typecheck ✓, build ✓ (25 pages). No source change.
- **organizer-web** — typecheck ✓, build ✓ (20 pages). No source change.

## Routing / middleware audit (Stage 10)

**No `middleware.ts` in any app** — auth is client-side (`tokenStore` + `router.push('/login')`) and
enforced server-side by the NestJS API's JWT guards. The Next.js middleware-bypass advisory class is
therefore **not applicable** to these apps. Only route handlers are `/api/health` (all
`dynamic = 'force-dynamic'`). `next.config` `async headers()` (HSTS, X-Frame-Options SAMEORIGIN,
X-Content-Type-Options nosniff, Referrer-Policy, CSP `frame-ancestors 'self'`) preserved and valid
under Next 15. No route paths changed (page counts match the app structure).

## Cache / data-consistency audit (Stage 11)

Next 15 changed server `fetch`/GET-route-handler caching defaults. **Inert here:** all dynamic data
(bookings, seat availability, booking/payment status, wallet, admin, organizer) is fetched
**client-side via React Query** (51 `useQuery` in customer-web; **0 server-side API fetches**), so
none of it ever enters Next's data cache. No server actions, no authed data in shared cache, no auth
token in cache keys. Booking/seat/payment freshness is unchanged by the upgrade.

## PWA / offline verification (Stages 9 & 14)

The PR #26 connectivity model (browser hint + API-origin reachability, not just `navigator.onLine`)
remains correct on Next 15. Fresh customer-web production build; `--retries=0`; inventory re-seeded
per batch.

- Offline `cached pass` E2E: **54/54** (re-seeded paced 9×6), 0 offline-detection failures.
- CI-equivalent `offline.spec.ts --repeat-each=10 --retries=0`: **20/20** (full spec, both tests).
- Online recovery verified; no false "Up to date" while API unreachable.

## E2E (Stage 13)

Full Playwright against production builds (all 3 web servers, `--retries=0`): **10 passed, 13
skipped, 0 failed**. The 13 skips are the pre-existing staff offline **check-in** specs guarded by
`test.skip(!flagOn)` (feature flag off by default) — identical to baseline, not upgrade-related. The
customer wallet `offline.spec.ts`, `organizer.spec.ts`, and `wallet-passes` all pass.

## Security before → after (Stage 15)

- `npm audit` (all): 50 (C2 H39 M9 L0) → **51 (C1 H41 M9 L0)**.
- **Critical 2 → 1: the Next.js critical (middleware authorization bypass) is REMOVED.** The
  remaining critical is `vitest` (dev-only, out of scope).
- **All Next.js-framework-authored advisories are cleared** — the only advisory now attributed to
  `next` is transitive: `postcss` (build-time CSS; path-traversal via `sourceMappingURL` — not in the
  runtime request path; present at baseline) and **`sharp`/libvips** (image optimization). The
  `sharp` chain is **newly present** (Next 15 pulls it) but **not runtime-reachable**: the apps use
  **zero `next/image`** (plain `<img>` throughout; 10 `no-img-element` disables), so the image
  optimizer that uses `sharp` is never invoked. npm's own `fixAvailable` for this residual is a
  _downgrade_ to `next@9.3.3` (its vulnerable range spans through 16.3.0-preview.7) — i.e. **no
  stable Next version fixes it**, so escalating to Next 16 would not help (and would pull the
  forbidden ESLint 9). **No new runtime-exploitable Critical/High is introduced.**
- Headers/CSP preserved; no server-only secret exposure (no server fetch of authed data); no open
  redirects (client `router.push` to fixed paths); no SSRF-sensitive server fetch (none exist).

## Performance (Stage 16 — indicative)

Production build times (Next 15): customer-web ~10–30s, admin-web ~23s, organizer-web ~27s —
comparable to Next 14. No material regression observed. (Not a production performance claim.)

## Backend regression (Stage 17)

No backend change intended. After the regen: API + worker **build** clean; **full API suite
162 suites / 1183 tests** pass; NestJS 11 / Sentry 10 / Express 5 intact; Prisma valid; boots clean.

## Rollback

Revert this PR, or restore the 4 web manifests + `apps/customer-web/app/blog/[slug]/page.tsx` +
`package-lock.json` to `96328690` and run `npm ci`. No DB migration; no backend change.

## Remaining risks

- Residual `next`-transitive high (`sharp`/libvips, `postcss`) — unreachable / build-time; no stable
  Next fix. Revisit if the app ever adopts `next/image`.
- Fully clearing them would require Next 16 (ESLint 9, out of scope) — deferred deliberately.
- Standard CI (Linux) must re-confirm all gates.

## Verdict

**CONDITIONAL GO** — launch-blocking Next.js critical removed; all Next.js-framework highs cleared;
React 18 & ESLint 8 preserved; backend unchanged; offline + E2E green (see run logs). Residual
`sharp`/postcss transitives are not runtime-reachable and have no stable Next fix.
