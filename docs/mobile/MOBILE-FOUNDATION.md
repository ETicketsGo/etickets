# ETicketsGo — Customer Mobile (Expo) · Sprint 1: Foundation

`apps/customer-mobile` is a new Expo (React Native) client that consumes the **existing**
NestJS API — no new backend, no duplicated business logic. It reuses the repo's shared
packages and follows Clean Architecture.

## Expo SDK decision (PR #20 hardening)

**Selected: Expo SDK 56** — RN **0.86.0**, React **19.2.3**, Expo Router **~56.2.15**,
NativeWind **4.2.6**, Reanimated **4.5.2**, react-native-web **0.21.x**, Sentry RN **8.19.x**.

Rationale: I evaluated SDK 57 (latest, released 2026-06-30) first. I could not run
`npx expo install --fix` / `expo-doctor` in the headless authoring environment to confirm
SDK 57's full dependency alignment (NativeWind 4 + Reanimated 4 + expo-router in a
monorepo), and SDK 57 being ~3 weeks old carries early-adopter library-compat risk — the
exact "unresolved monorepo/library issues" case that warrants 56. SDK 56 is current and
supported, and its exact mutually-compatible versions were taken from Expo's canonical
`bundledNativeModules.json`, so the alignment is real, not guessed. Verified: the whole
dependency tree **resolves** and the monorepo nests mobile React 19.2.3 **isolated** from
the web apps' React 18.3.1. Temporary constraint: final `expo install --fix`/`expo-doctor`
alignment and any SDK-57 re-evaluation should run on a networked dev machine.

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

## Verification status (honest — no result is claimed unless it actually ran)

**Executed here (passing):**

- Shared security helpers + contracts — `web-kit` vitest **127/127** (incl. the new
  `client-security.spec.ts`: redaction + local-URL guard).
- Existing web + API gate **unaffected** — `turbo typecheck` **13/13**, `turbo lint` **3/3**
  (mobile is skipped by the root pipeline by design).
- SDK 56 dependency tree **resolves**; root lockfile regenerated cleanly; mobile React 19 is
  nested and isolated from web React 18.

**NOT executed here — requires a dev machine with the Expo toolchain / an EAS account
(this environment has no iOS/Android simulators, no Metro runtime, no EAS):** these are
scripted + wired into `mobile-ci.yml` and must run before merge —
`npm ci` (full native install) · `typecheck:mobile` · `lint:mobile` · `test:mobile`
(the auth-store spec) · `expo-doctor` · `expo export --platform web` · Metro startup ·
**Android + iOS EAS development builds** · on-device push + deep-link testing.

## Definition of Done (merge gate for PR #20)

All must be **actually executed** and green (see the brief's merge gates): supported Expo SDK
(56 ✅) · `npm ci` · existing monorepo checks · `typecheck:mobile` · `lint:mobile` ·
`test:mobile` · `expo-doctor` · `expo export --platform web` · Android EAS dev build · iOS
EAS dev build (or an exact Apple-credential limitation documented, not misrepresented) ·
shared auth contracts de-duplicated (✅) · no secrets committed (✅) · no critical/high dep
issues · docs reflect verified results (✅).

## Next sprints (map to the brief's phases)

Phase 2 Auth (OTP, forgot password, profile setup) · Phase 3 Home/Movies/Events/Search ·
Phase 4 Details · Phase 5 Booking/Seat/Checkout/QR ticket · Phase 6 Profile/Settings.
Each built sprint-by-sprint with the same enterprise process (states, a11y, tests, gate).
