# SEC-1 — NestJS + Next Workspace Diagnosis (Batch A1+A2 investigation)

**Branch:** `chore/sec1-nestjs-next-workspace-remediation` (from `main` `b015abe`). **Outcome:
diagnosis only — the combined-upgrade premise was DISPROVEN.** No dependency change is committed; the
branch carries this report.

## TL;DR — the offline regression is caused by **NestJS 11 / Express 5**, not `next` hoisting

The premise going in (mine, PR #24/#25, and the A1+A2 task) was that the NestJS major's lockfile
regen **hoisted `next`** (nested→hoisted) and that hoisting broke the customer-web offline e2e. **A
controlled local isolation experiment disproves this.** The real cause is the NestJS 11 / Express 5
upgrade itself, interacting with the customer-web offline wallet page.

## The isolation experiment (local, real servers + Playwright)

Environment: local Postgres + Redis seeded; `next build` + `next start` (production, exactly as CI);
Playwright chromium; `apps/e2e/tests/offline.spec.ts`.

| #   | NestJS        | `next` layout                         | Result (`offline.spec.ts`)                                                                                               |
| --- | ------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | **10** (main) | **hoisted 14.2.35** (residue removed) | ✅ **2 passed** (clean run)                                                                                              |
| 2   | **11**        | hoisted 14.2.35                       | ❌ wallet test (`:22`) **fails at line 50 `getByText(/Offline/)`**; privacy test (`:79`) passes — **matches CI exactly** |

Same customer-web build in both; the **only** difference between the pass and the fail is the NestJS
version. **→ next hoisting is NOT the cause; NestJS 11 / Express 5 is.** (Corroborated by CI: `main`
= NestJS 10 passes `:22` in 3.8 s; the NestJS-11 branch fails it 4×.)

## Why `next` splits on main (the red herring, now explained)

`packages/web-kit` (the shared UI kit containing the `useOnline` hook) has a **`devDependencies.next:
"14.2.15"` exact** pin — used only for web-kit's own typecheck/vitest (web-kit ships TS source;
`main: ./src/index.ts`, so the apps compile it with _their_ next). That exact pin makes npm hoist
`14.2.15` to root, forcing the 3 apps to **nest** their `^14.2.35`. A fresh regen instead hoists
`14.2.35`. **Both layouts use next 14.2.35 to build the apps**, and experiment #1 shows the hoisted
layout is fine with NestJS 10 — so the split/hoisting is a workspace-hygiene issue, **not** the cause
of the offline regression. (It is still worth fixing web-kit's residue, separately.)

## Failure micro-mechanism (as far as isolated)

`offline.spec.ts:22` asserts the wallet page shows `/Offline/` after `context.setOffline(true)` +
reload. The banner text is `SYNC_LABEL[deriveSyncState(...)]`. Labels containing "Offline": `STALE`
("Offline — showing saved passes") and `OFFLINE` ("Offline"). `SYNCING` ("Syncing…") and `CURRENT`
("Up to date") do **not**.

- First hypothesis: `deriveSyncState` checks `isFetching` (→`SYNCING`) **before** offline, so an
  in-flight doomed fetch could mask the banner. I applied a fix making **offline take precedence over
  syncing** and re-verified under NestJS 11 — **it did NOT fix the wallet test** (still fails at line
  50). That reverted change was a legitimate UX improvement but is **not** the fix here.
- Because the offline-precedence fix (which forces `STALE`/`OFFLINE` whenever `!online`) did not help,
  the stuck variable is **`online` itself**: on the offline-reloaded wallet page under NestJS 11,
  `useOnline()` (pure `navigator.onLine` + online/offline events) stays **`true`**, so the banner
  renders "Up to date". This is a **client hydration / online-detection** effect that only manifests
  when the online-phase requests were served by the **NestJS 11 / Express 5** API.

The exact Express-5 behavior that perturbs the offline page's hydration/`navigator.onLine` timing
needs **browser-level tracing** (Playwright trace + console) to pin — not resolved here.

## Corrected recommendation

- **Do NOT pursue "combine NestJS + Next.js" to fix this** — Next.js is not involved. Upgrading Next
  will not fix (and is not needed to fix) the offline regression.
- **Adopting NestJS 11 requires a customer-web offline-robustness fix**, most likely making the wallet
  page's offline detection deterministic/hydration-safe (e.g., initialize `useOnline` from
  `navigator.onLine` synchronously and/or make the offline banner independent of the doomed
  online-phase query state). This is a **customer-web change**, verified by the offline e2e, and
  belongs in its own focused effort — not a dependency batch.
- **Separately**, fix the `packages/web-kit` `next: "14.2.15"` residue (align to `^14.2.35`) for a
  clean, reproducible workspace layout — this is safe (experiment #1) and unrelated to the regression.
- Re-sequence SEC-1: the NestJS batch is blocked on the customer-web offline fix, **not** on Next.js.

## Verdict: **NO-GO for a combined NestJS+Next upgrade** (wrong target). The real blocker is a

NestJS-11/Express-5 ↔ customer-web offline-detection interaction requiring a customer-web fix + trace-
level diagnosis. `main` untouched. Prior "hoisting" diagnoses (PR #24/#25) are superseded by this.
