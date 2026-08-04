# Release

## Status

**No build has been produced.** There is no EAS authentication, no Android SDK, no Java
and no macOS in the environment this was developed in. Everything below is configured and
ready; none of it has been executed.

## Identifiers

| Profile      | Bundle id / package               | App name             |
| ------------ | --------------------------------- | -------------------- |
| development  | `com.eticketsgo.customer.dev`     | ETicketsGo (Dev)     |
| qa / preview | `com.eticketsgo.customer.preview` | ETicketsGo (Preview) |
| production   | `com.eticketsgo.customer`         | ETicketsGo           |

Distinct ids per environment so a tester can hold all three on one device at once.
Derived in `app.config.ts` from `EXPO_PUBLIC_ENV`.

## Versioning

`app.config.ts` carries the marketing version (`0.1.0`). Build numbers are remote:
`eas.json` sets `cli.appVersionSource: "remote"` and `autoIncrement` on the production
profile, so EAS owns `versionCode` / `buildNumber` and two machines cannot mint the same
one.

Bump the marketing version by hand in `app.config.ts` for a user-visible release.

## Build profiles

See [ENVIRONMENTS.md](ENVIRONMENTS.md) for the full table. In short: `development` (dev
client, APK), `development-simulator` (iOS simulator), `qa` (internal APK against the QA
API), `preview` (internal APK against UAT — **not provisioned**), `production` (AAB —
**not provisioned**).

## Owner commands

First time only:

```bash
cd apps/customer-mobile
npx eas login
npx eas init                      # creates the Expo project id
```

Then set `extra.eas.projectId` in `app.config.ts` — the app config does not carry one yet.

Secrets go to EAS, never into the repo:

```bash
npx eas secret:create --scope project --name SENTRY_AUTH_TOKEN --value <token>
```

Builds:

```bash
npx eas build --profile qa --platform android          # internal APK for QA
npx eas build --profile qa --platform ios              # needs an Apple Developer account
npx eas build --profile production --platform android  # AAB
```

Local validation with no EAS account:

```bash
npm run doctor                    # expo-doctor
npx expo config --type public --json
npm run export:web                # proves the whole app bundles
npm run smoke:web                 # runs it against QA
npx expo prebuild --platform android --no-install   # generates android/, needs no SDK
```

`prebuild` generates the native project without building it, which is a useful check that
the config plugins resolve. Compiling it needs the Android SDK and JDK 17.

## Do not

- Publish to any app store. Not in scope, and see
  [APP-STORE-READINESS.md](APP-STORE-READINESS.md) for why it would fail review.
- Commit `google-services.json`, `GoogleService-Info.plist`, a keystore, or a `.p8`/`.p12`.
- Put a real credential in `.env.example`.

## Signing

No signing material exists in this repo and none should. Let EAS manage credentials
(`eas credentials`), which keeps the keystore off developer machines and out of git.
