# ETicketsGo — Customer Mobile (Expo) · Sprint 1: Foundation

`apps/customer-mobile` is a new Expo (React Native) client that consumes the **existing**
NestJS API — no new backend, no duplicated business logic. It reuses the repo's shared
packages and follows Clean Architecture.

## What Sprint 1 delivers (foundation only, not feature screens)

Expo SDK 52 + Expo Router (typed routes, deep linking `etickets://` + universal links),
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

## Verification status (honest)

- Verified in this environment: file/config correctness; the existing web + API projects
  are **unaffected** (their Turbo gate does not run mobile; lockfile kept in sync).
- **Requires a dev machine with the Expo toolchain** (this environment has no iOS/Android
  simulators or Metro runtime): `npm run typecheck:mobile`, `npm run start`, and native
  iOS/Android/Web(Expo) compilation. `mobile-ci.yml` runs the typecheck/lint in CI.

## Next sprints (map to the brief's phases)

Phase 2 Auth (OTP, forgot password, profile setup) · Phase 3 Home/Movies/Events/Search ·
Phase 4 Details · Phase 5 Booking/Seat/Checkout/QR ticket · Phase 6 Profile/Settings.
Each built sprint-by-sprint with the same enterprise process (states, a11y, tests, gate).
