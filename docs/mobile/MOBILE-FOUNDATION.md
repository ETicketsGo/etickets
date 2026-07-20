# ETicketsGo — Customer Mobile (Expo) · Sprint 1: Foundation

`apps/customer-mobile` is a new Expo (React Native) client that consumes the **existing**
NestJS API — no new backend, no duplicated business logic. It reuses the repo's shared
packages and follows Clean Architecture.

## Expo SDK decision (PR #20 hardening)

**Selected: Expo SDK 56.** Actual installed + `expo install --fix`-aligned versions (verified
against the running toolchain, not guessed): React Native **0.85.3**, React **19.2.3**,
Expo Router **~56.2.7**, NativeWind **4.2.x**, Reanimated **4.3.1** (+ `react-native-worklets`
**0.8.3**, which Reanimated 4 split into a separate peer), react-native-screens **4.25.2**,
react-native-web **~0.21.2**, Sentry RN **~7.11.0**.

> **Correction (verification pass):** an earlier draft of this doc listed SDK 57's matrix
> (RN 0.86 / reanimated 4.5 / sentry 8.19), taken from `main`'s `bundledNativeModules.json`.
> Running `npx expo install --check` then `--fix` against a real SDK 56 install proved SDK 56
> resolves to **RN 0.85.3** etc.; `package.json` was corrected to the real numbers.

Rationale for 56 over 57: SDK 57 was ~3 weeks old and carries early-adopter library-compat
risk (NativeWind 4 + Reanimated 4 + expo-router in a monorepo) — the exact "unresolved
monorepo/library issues" case that warrants the current stable line. SDK 56 is current and
supported. Re-evaluate 57 on a dev machine once its ecosystem settles.

## What Sprint 1 delivers (foundation only, not feature screens)

Expo SDK 56 + Expo Router (typed routes, deep linking `etickets://` + universal links),
NativeWind theme (light/dark from the shared design tokens), Axios API client with
single-flight token refresh, Expo Secure Store token storage, TanStack Query, Zustand
auth store, React Hook Form + the shared Zod `loginSchema`, Sentry, Expo Notifications
(registers via the existing push endpoint), Expo Camera permission (for QR check-in),
Reanimated + Gesture Handler, error boundary, and the five reusable screen states
(Loading / Skeleton / Empty / Error / Offline) with accessibility.

A minimal Welcome → Login → Home flow is included **to prove the whole stack end-to-end**
(form → shared validation → repository → store → secure store → auth-gated navigation),
not as the final UI — Phases 2–6 build the real screens on this shell.

## Reuse (single source of truth)

| Concern                                         | Reused from                                        |
| ----------------------------------------------- | -------------------------------------------------- |
| Domain enums / constants / models               | `@eticketsgo/shared-types` (pure, RN-safe)         |
| Request DTOs + Zod schemas (e.g. `loginSchema`) | `@eticketsgo/validation`                           |
| Design tokens (colors, radius, type scale)      | `@eticketsgo/design-tokens`                        |
| API endpoints + business logic                  | the existing NestJS API (the client only calls it) |

The mobile app never redefines DTOs, schemas, enums or constants. **Follow-up:** the API
_response_ types currently live in `packages/web-kit` (React-DOM coupled); lift the pure
ones into `shared-types` so web + mobile share one definition (tracked in the auth
repository).

## Clean Architecture layout

```
app/                     Expo Router routes (presentation shell + navigation)
  _layout.tsx            providers, fonts, splash, Sentry, auth hydrate
  index.tsx              auth gate → (app) or (auth)
  (auth)/                welcome, login (Phase 2 expands)
  (app)/                 authenticated area (Phase 3+)
src/
  services/              env, secure-store, api-client, sentry, notifications
  application/           query-client, auth-store (Zustand)
  data/                  repositories (thin API wrappers reusing shared types)
  domain/  → types/      re-exports @eticketsgo/shared-types
  theme/                 imperative palette + reused token scales
  hooks/                 use-auth, use-online
  components/            screen, states, error-boundary, providers
assets/                  icons/splash (placeholders — replace before store build)
```

## Monorepo integration (non-breaking)

- `apps/customer-mobile` is a workspace (`apps/*` glob). Its check scripts are named
  `typecheck:mobile` / `lint:mobile`, so the root Turbo tasks (`build/typecheck/lint/
test/dev`) **skip it** — the existing web/API gate is unchanged.
- A dedicated `.github/workflows/mobile-ci.yml` runs the mobile checks in isolation,
  path-filtered so it never gates the web/API `ci.yml`.
- Shared packages publish `dist`; the mobile typecheck/CI builds them first.

## Running it

```sh
cd apps/customer-mobile
cp .env.example .env            # point EXPO_PUBLIC_API_URL at the running API
npm install                     # from repo root: installs the workspace
npm run start                   # then press i / a / w for iOS / Android / Web
```

## Hardening (PR #20 review)

- **Shared API contracts** — `AuthUser`, `AuthResponse`, `RefreshResponse`, `PushRegistration`,
  `SessionDevice` now live once in `@eticketsgo/shared-types`; web-kit aliases `AuthUser` to
  the shared type and mobile consumes them. No mirrored DTOs remain.
- **Auth security** — refresh tokens live **only** in Expo SecureStore (never AsyncStorage);
  single-flight refresh (concurrent 401s → one `/auth/refresh`); auth endpoints
  (`/auth/login|refresh|register|logout`) never trigger a refresh (no loop); failed refresh
  clears the session once and routes to login; logout revokes the server session;
  `redactSecretKeys` strips tokens/OTPs/auth headers from Sentry (shared + unit-tested);
  production builds **throw** if the API URL is missing or local (`isLocalApiUrl`, tested).
- **EAS** — `eas.json` with development/preview/production profiles + per-env app identifiers
  (`com.eticketsgo.customer[.dev|.preview]`). Secrets (EXPO_TOKEN, store creds) are NOT in
  source control.

## Monorepo dependency strategy (React 18 web / React 19 mobile)

The repo runs **two React majors**: the web apps are React 18 (Next 14), the mobile app is
React 19 (RN 0.85). Under npm's hoisting this creates real, non-obvious resolution conflicts.
The following make a single, self-consistent install work **without touching the web/API
toolchain** (verified: `turbo typecheck lint` stays 16/16):

- **`react-native` is hoisted to the root** (`devDependencies` in the root `package.json`).
  It only peers React 19, so npm otherwise nests it under the app, and the root-hoisted Expo
  build tools (`react-native-css-interop`/NativeWind, `@react-native/jest-preset`) then fail
  to resolve `react-native/package.json`. Hoisting it fixes `expo export`, jest, and
  expo-doctor. It is inert for the web apps (they never import it).
- **Single React in the bundle** is forced by Metro (`metro.config.js` →
  `resolver.extraNodeModules` pins `react`/`react-dom` to the app's React 19) and mirrored for
  Jest (`moduleNameMapper` maps `^react(/.*)?$` → the app's React 19). The successful web
  export (static-renders 8 routes server-side; a duplicate React would throw _Invalid hook
  call_) is the proof.
- **`@types/react` stays 18 at the root** (pinned) for the web apps; the mobile app nests
  `@types/react` 19. Because `react-native` is hoisted to the root it would otherwise pick up
  React-18 types, so **`tsconfig.typecheck.json`** aliases `react` types to the app's 19 for
  `tsc` only. The alias is kept out of `tsconfig.json` on purpose — Expo Metro and jest-expo
  read `tsconfig.json`'s `paths` and would remap the _runtime_ `react` import to types-only
  `@types/react`, breaking bundling/tests.
- **ESLint**: the root pins ESLint 8 (Next 14 `next lint`); mobile needs ESLint 9. The
  mobile `eslint.config.js` therefore bridges Expo's **legacy** config via `FlatCompat`
  (`eslint-config-expo/flat` requires `eslint/config`, which root ESLint 8 doesn't export) and
  resolves plugins from `eslint-config-expo`'s own `node_modules` (the root-hoisted
  `eslint-plugin-react-hooks` is an ESLint-8-era build).

`react`/`react-dom` therefore appear as "duplicates" in `expo-doctor` — this is **by design**
for a React-18-web/19-mobile monorepo (they are JS-only, and exactly one is bundled). A clean
long-term fix (pnpm strict linking, or unifying the repo on React 19 via Next 15) is a
separate, larger change.

## Verification status (honest — every result below was actually executed)

**Executed and passing (this verification pass, real toolchain — Node 24, npm 11.11.0, Windows):**

| Check                                                 | Result                                                                                                               |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Clean install — `rm -rf node_modules && npm ci`       | ✅ exit 0 (620+ pkgs)                                                                                                |
| `expo install --check` / `--fix` alignment            | ✅ SDK 56 matrix corrected (RN 0.85.3 …)                                                                             |
| `typecheck:mobile` (`tsc -p tsconfig.typecheck.json`) | ✅ 0 errors                                                                                                          |
| `lint:mobile` (ESLint 9 + Expo ruleset)               | ✅ 0 errors                                                                                                          |
| `test:mobile` (jest-expo, auth-store spec)            | ✅ **5/5**                                                                                                           |
| `expo export --platform web` (Metro)                  | ✅ 2816+2683 modules, **8 static routes**, single React proven                                                       |
| Metro dev-server startup (`expo start`)               | ✅ boots, "Waiting on http://localhost:8099"                                                                         |
| `expo-doctor`                                         | ⚠️ **19/21** — only the intentional react/react-dom split + minor version advisories (screens 4.25↔4.26, TS 5.9↔6.0) |
| Web + API regression — `turbo typecheck lint`         | ✅ **16/16** (mobile skipped by design)                                                                              |
| web-kit vitest (shared security helpers)              | ✅ 127/127                                                                                                           |

**NOT executed — genuinely impossible in this headless CI-less environment (no Apple/Google
accounts, no devices, no EAS project, no CI secret). Documented with exact blockers in the
PR-20 verification report, not misrepresented:** company Expo/EAS project creation · Android
EAS dev build · iOS EAS dev build (needs Apple Developer Program) · physical-device smoke
test (push/deep-link/camera) · CI run with `EXPO_TOKEN` secret.

## Definition of Done (merge gate for PR #20)

Executed & green: supported Expo SDK (56 ✅) · `npm ci` ✅ · existing monorepo checks (16/16 ✅)
· `typecheck:mobile` ✅ · `lint:mobile` ✅ · `test:mobile` ✅ · `expo-doctor` (19/21; residual
is the intended React split ✅) · `expo export --platform web` ✅ · Metro startup ✅ · shared
auth contracts de-duplicated ✅ · no secrets committed ✅ · no **new** critical/high dep issues
(mobile adds only _moderate_ Expo-toolchain advisories; the repo's pre-existing high/critical
live in `multer`/`vite`/`next`/`@nestjs/cli` and are unchanged by this PR) ✅ · docs reflect
verified results ✅.

**Still required before external release (not code-blocked):** Android + iOS EAS dev builds,
physical-device validation, real store assets (see `assets/README.md`).

## Next sprints (map to the brief's phases)

Phase 2 Auth (OTP, forgot password, profile setup) · Phase 3 Home/Movies/Events/Search ·
Phase 4 Details · Phase 5 Booking/Seat/Checkout/QR ticket · Phase 6 Profile/Settings.
Each built sprint-by-sprint with the same enterprise process (states, a11y, tests, gate).
