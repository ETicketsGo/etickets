# ETicketsGo — Customer Mobile App

React Native (Expo SDK 56) customer app for ETicketsGo, living in the monorepo at
`apps/customer-mobile`.

## Status, honestly

**Partially QA-ready.** The general-admission booking journey and reserved-seat
selection are built and exercised against the live QA API. The app has **never been run
on an Android or iOS device or emulator** — no Android SDK, Java, adb, emulator or macOS
exists in the environment it was built in. See [KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md).

## Quick start

```bash
# from the repo root
npm install

cd apps/customer-mobile
cp .env.example .env          # then set EXPO_PUBLIC_API_URL
npm start                     # Expo dev server
```

## The commands that actually exist

Run from `apps/customer-mobile`:

| Command                           | What it does                                              |
| --------------------------------- | --------------------------------------------------------- |
| `npm start`                       | Expo dev server                                           |
| `npm run android` / `npm run ios` | Launch on a device/emulator (needs the platform SDK)      |
| `npm run typecheck:mobile`        | `tsc --noEmit -p tsconfig.typecheck.json`                 |
| `npm run lint:mobile`             | ESLint                                                    |
| `npm run test:mobile`             | Jest                                                      |
| `npm run smoke:web`               | Export the web bundle and drive it in Chromium against QA |
| `npm run export:web`              | `expo export --platform web`                              |
| `npm run doctor`                  | `expo-doctor`                                             |
| `npm run prebuild`                | Generate native projects                                  |

From the repo root, `npm run verify` runs the whole-monorepo gate (lint, typecheck,
tests, builds, deploy-config checks). The mobile workspace is deliberately outside the
root `typecheck` task — see [DEVELOPMENT.md](DEVELOPMENT.md) for why.

## Documentation

| Doc                                              | Covers                                              |
| ------------------------------------------------ | --------------------------------------------------- |
| [ARCHITECTURE.md](ARCHITECTURE.md)               | Layering, state, why it lives in the monorepo       |
| [DEVELOPMENT.md](DEVELOPMENT.md)                 | Setup, the React 18/19 split, resolver pinning      |
| [ENVIRONMENTS.md](ENVIRONMENTS.md)               | Env vars, QA hosts, the API-domain switch checklist |
| [API-INTEGRATION.md](API-INTEGRATION.md)         | Endpoints used, contracts, verified gaps            |
| [AUTHENTICATION.md](AUTHENTICATION.md)           | Tokens, refresh, gating, storage                    |
| [PAYMENTS.md](PAYMENTS.md)                       | The provider-neutral seam and recovery states       |
| [NOTIFICATIONS.md](NOTIFICATIONS.md)             | Push architecture and what is not wired             |
| [DEEPLINKING.md](DEEPLINKING.md)                 | Routes, validation, association files               |
| [OFFLINE-BEHAVIOR.md](OFFLINE-BEHAVIOR.md)       | What works offline and what does not                |
| [SECURITY.md](SECURITY.md)                       | Controls actually implemented                       |
| [THREAT-MODEL.md](THREAT-MODEL.md)               | Assets, adversaries, mitigations, accepted risk     |
| [ACCESSIBILITY.md](ACCESSIBILITY.md)             | What is done, what is untested                      |
| [TESTING.md](TESTING.md)                         | Layers, counts, how to run                          |
| [RELEASE.md](RELEASE.md)                         | EAS profiles and build commands                     |
| [APP-STORE-READINESS.md](APP-STORE-READINESS.md) | Gap list before submission                          |
| [KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md)     | Every known gap in one place                        |
