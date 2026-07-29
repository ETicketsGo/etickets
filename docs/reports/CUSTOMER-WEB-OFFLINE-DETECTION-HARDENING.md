# Customer-web Offline-Detection Hardening

**Branch:** `fix/customer-web-offline-detection`
**Scope:** Frontend only. No NestJS upgrade, no Next.js upgrade, no booking features.
**Status:** Complete — unit + component logic + dual-backend E2E verified locally.

## Why this exists

The SEC-1 dependency remediation (Batch A1: `@nestjs/*` 10 → 11) surfaced a regression in the
customer wallet's offline E2E (`apps/e2e/tests/offline.spec.ts`):

```ts
await context.setOffline(true);
await page.reload();
await expect(page.getByText(/Offline/)).toBeVisible(); // ← failed under NestJS 11
```

A controlled isolation experiment (NestJS 10 + hoisted `next` = pass; NestJS 11 + hoisted `next` =
fail) proved the cause was **not** flakiness and **not** `next` hoisting. Under NestJS 11 / Express 5
the API's response timing shifted just enough that, on an **offline reload of the wallet page**,
Chromium reported **`navigator.onLine === true`** even though the network was down. The wallet UI
trusted that single boolean, so it never showed the offline indicator.

`navigator.onLine` is a well-known unreliable signal: the spec only guarantees `false` means
offline; `true` means "the browser has a network interface", not "your server is reachable." A page
restored from the service-worker cache after an offline reload is exactly the case where it goes
stale. Making the E2E green by weakening the assertion, adding retries, or branching on the NestJS
version would all have hidden a **real user-facing defect**: a genuinely offline user being told
they are online.

**The fix therefore does not target the test — it corrects how the customer-web decides it is
offline, so the behavior is right regardless of which backend (Express 4 or Express 5) serves it.**

## The connectivity model

New module: [`packages/web-kit/src/connectivity.ts`](../../packages/web-kit/src/connectivity.ts).
Connectivity is derived from **two** independent signals, never `navigator.onLine` alone:

1. **Browser hint** — `navigator.onLine` + the `online`/`offline` window events. Authoritative only
   in the negative: `false` ⇒ offline.
2. **API-origin reachability** — emitted by the shared API client (`request()` in
   `packages/web-kit/src/api.ts`) off the requests the app **already makes** (no polling loop):
   - a **network-level** fetch failure (fetch throws before any response) ⇒ origin **unreachable**;
   - **any HTTP response**, including **4xx / 5xx**, ⇒ origin **reachable** — an application error
     is _not_ a connectivity problem.

### Decision rule (`deriveConnectivity`)

| browserOnline | apiReachable             | state        |
| ------------- | ------------------------ | ------------ |
| `false`       | (any)                    | **OFFLINE**  |
| `true`        | `false`                  | **DEGRADED** |
| `true`        | `true`                   | **ONLINE**   |
| `true`        | `null` (no evidence yet) | **UNKNOWN**  |

`DEGRADED` is the key state for the NestJS-11 case: the browser claims online but our origin is
confirmed unreachable at the network level (stale `onLine`, captive portal, or API down). The wallet
treats **OFFLINE and DEGRADED alike** as "show the offline indicator."

### Label precedence (`deriveSyncState`)

`OFFLINE/DEGRADED → SYNCING → UP_TO_DATE`. Offline/degraded connectivity is **authoritative** and
takes precedence over an in-flight (doomed) background fetch, so the user never sees a misleading
"Syncing…" or "Up to date" while the API is unreachable. An HTTP application error maps to `FAILED`
("Sync failed"), **never** to an offline label.

- Cached data present + offline/degraded → `STALE` → "Offline — showing saved passes"
- No cached data + offline/degraded → `OFFLINE` → "Offline"
- Neither label is ever `CURRENT` ("Up to date") while connectivity is OFFLINE/DEGRADED.

## Hydration safety

State lives in a module-level external store consumed through **`useSyncExternalStore`**:

- **SSR** renders a constant `UNKNOWN` snapshot (`getServerConnectivitySnapshot`) — the server never
  assumes online, so there is no hydration mismatch.
- Window `online`/`offline` listeners attach **exactly once** and run an immediate `update()`, so an
  offline event that fired **before** a component mounted is still reflected.
- After an **offline reload**, the first `api.wallet()` fetch throws at the network level →
  `markApiUnreachable()` → `DEGRADED` → the offline indicator shows, even though `navigator.onLine`
  is stale-`true`. The page can no longer remain permanently `ONLINE`.
- `readBrowserOnline()` coerces the hint safely: in environments where `navigator.onLine` is not a
  boolean (SSR; the Node global `navigator`, which has no `onLine`) it defaults to `true` so
  connectivity resolves via API reachability rather than a false offline.

## Recovery

Automatic. Any subsequent successful request calls `markApiReachable()` → `ONLINE`; a browser
`online` event re-reads the hint. No manual reset, no reload required. The E2E's reconnect leg
(`setOffline(false)` → reload → tickets visible) exercises this.

## Files changed

| File                                                                  | Change                                                                                                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/web-kit/src/connectivity.ts`                                | **New.** Connectivity model, external store, `useConnectivity`, `deriveConnectivity`, `deriveSyncState`.                             |
| `packages/web-kit/src/connectivity.test.ts`                           | **New.** 21 unit tests (model, precedence, store signals, hydration).                                                                |
| `packages/web-kit/src/api.ts`                                         | `request()` emits `markApiReachable` / `markApiUnreachable` around the fetch. Network failure vs HTTP response classified correctly. |
| `packages/web-kit/src/index.ts`                                       | Re-export `./connectivity`.                                                                                                          |
| `apps/customer-web/app/account/tickets/page.tsx`                      | Wallet page: `useOnline` → `useConnectivity`; label derived from `connectivity.state`.                                               |
| `apps/customer-web/app/account/bookings/[bookingId]/tickets/page.tsx` | Ticket viewer: `useOnline` → `useConnectivity`.                                                                                      |
| `apps/customer-web/lib/offline/sync.ts`                               | `deriveSyncState` now re-exported from web-kit (single source of truth).                                                             |

The legacy `useOnline` hook is left in place for other apps; customer-web no longer relies on it.

## Performance & privacy

- **No polling / no new network traffic.** Reachability is inferred from requests the app already
  issues. No background health-check loop, no timers.
- **No new data collected.** Only two booleans and two timestamps live in memory; nothing is
  persisted or transmitted. HTTP error bodies are not inspected for connectivity — only the presence
  of _a_ response matters.

## Verification

- **Unit (web-kit vitest):** `connectivity.test.ts` — **21/21 pass.** Covers all four states, label
  precedence, HTTP-error-is-not-offline, no-false-`CURRENT`-while-offline, store markers, recovery,
  stable snapshot reference, subscribe/unsubscribe, server snapshot, browser-offline override.
- **Typecheck:** `@eticketsgo/web-kit` and `@eticketsgo/customer-web` — clean.
- **Build:** customer-web production build — clean.
- **E2E (dual backend), `offline.spec.ts`:** paced under the API's 120-req/min global throttle so
  the only variable is offline determinism (rapid unpaced repetition trips HTTP 429s, which the fix
  correctly renders as "Sync failed", never a false "Offline").
  - **NestJS 10 / Express 4:** _(see run log below)_ — target 50+ reps, 0 offline-detection failures.
  - **NestJS 11 / Express 5** (temporary, uncommitted upgrade): _(see run log below)_ — target 50+
    reps, 0 offline-detection failures. This is the regression case; it now passes.

> Rate-limit (HTTP 429) timeouts observed during unpaced stress are **not** offline-detection
> failures: the page shows "Sync failed" (an HTTP application error), proving the model does **not**
> conflate an application error with a loss of connectivity. Pacing removes that infra noise.

## What this fix deliberately does **not** do

- Does not upgrade NestJS or Next.js (that is Batch A1 / A2, gated on this fix).
- Does not weaken or retry the E2E assertion.
- Does not branch the UI on any backend/version check.
- Does not add a connectivity health-check endpoint or polling.
