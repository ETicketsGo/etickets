# Google Play release runbook

What exists, what each step needs, and who does it. Checked against Google's help pages on
2026-10-24: new apps must target **Android 16 (API 36)** (from 31 August 2026), and a
personal developer account created after 13 November 2023 must run a **closed test with at
least 12 testers opted in continuously for 14 days** before it can apply for production.

## 1. Identity and versions

|                                   | QA                                | UAT                               | Production                |
| --------------------------------- | --------------------------------- | --------------------------------- | ------------------------- |
| EAS profile                       | `qa`                              | `preview`                         | `production`              |
| Application id                    | `com.eticketsgo.customer.preview` | `com.eticketsgo.customer.preview` | `com.eticketsgo.customer` |
| Label                             | ETicketsGo (Preview)              | ETicketsGo (Preview)              | ETicketsGo                |
| API                               | api-qa.eticketsgo.com             | api-uat.eticketsgo.com            | api.eticketsgo.com        |
| Web host (legal links, App Links) | qa.eticketsgo.com                 | uat.eticketsgo.com                | www.eticketsgo.com        |
| Artifact                          | APK                               | APK                               | AAB                       |

- `targetSdkVersion` 36, `compileSdkVersion` 36, `minSdkVersion` 24 (Expo SDK 57 defaults;
  verified in the built manifest).
- `version` is `0.1.0` in `app.config.ts`. `versionCode` is owned by EAS
  (`appVersionSource: remote`, `autoIncrement` on production). A local Gradle build is
  versionCode 1. Set `version` to `1.0.0` for the first public release.
- The production web host is `www.eticketsgo.com`: the bare `eticketsgo.com` returns 404 for
  `/privacy`, which is the URL Play checks.

## 2. Signing

**Decided (owner, 2026-10-24): EAS-managed upload key + Play App Signing.** The upload
keystore was created on Expo's servers on 2026-10-24 by the first
`eas build --profile production` ("Using remote Android credentials (Expo server) - Created
keystore"). It has never been on a laptop or in git. Its SHA-1/SHA-256 are shown by
`npx eas-cli credentials` (interactive: Android > production) and in Play Console after the
first upload. When enrolling the app in Play App Signing, choose **"Use Google-generated key"**;
the EAS key is then only the upload key.

Background, kept for reference:

Play App Signing is mandatory for new apps: Google holds the key that signs what users
install; we sign uploads with an **upload key**. Two ways to hold the upload key:

1. **EAS-managed (recommended).** `eas credentials` > Android > production > generate a new
   keystore. The key never sits on a laptop; CI and EAS builds sign with it. Download a
   backup (`eas credentials` can export it) into the owner's password manager.
2. **Self-managed.** `keytool -genkeypair -v -keystore upload.jks -alias upload -keyalg RSA
-keysize 2048 -validity 10000`, stored only in the password manager and given to EAS
   (`eas credentials`) or to Gradle through environment variables, never committed
   (`*.jks` and `*.keystore` must stay out of git).

Losing the upload key is recoverable (Play support resets it); losing the app signing key is
not, which is why Play holds it.

After the first upload: Play Console > Setup > App integrity > copy the **App signing key**
SHA-256 and set it in `ANDROID_APP_LINKS` on the production customer-web service
(`com.eticketsgo.customer:<SHA-256>`), so App Links verify (PR 477).

## 3. Building

EAS (the supported path; needs build quota on the Expo account). **Status 2026-10-24: the
Free plan's Android builds are used up until 2026-11-01**, so no signed AAB exists yet. Either
the owner upgrades (`eas billing:subscribe starter --account srinivasdeeptrics`, costs money)
or the build runs on 1 November. The project, credentials and versionCode (remote, now 2) are
ready; nothing else blocks it:

```
cd apps/customer-mobile
npx eas build --profile production --platform android      # signed AAB
npx eas build --profile qa --platform android              # QA APK
```

Local (works today without EAS; signs with the DEBUG key, so it is for testing only and Play
rejects it):

```
# QA APK
EXPO_PUBLIC_ENV=staging EXPO_PUBLIC_API_URL=https://api-qa.eticketsgo.com/api \
EXPO_PUBLIC_WEB_HOST=qa.eticketsgo.com SENTRY_DISABLE_AUTO_UPLOAD=true NODE_ENV=production \
  npx expo prebuild --platform android --no-install --clean
(cd android && ./gradlew assembleRelease)

# Production AAB (debug-signed)
EXPO_PUBLIC_ENV=production EXPO_PUBLIC_API_URL=https://api.eticketsgo.com/api \
EXPO_PUBLIC_WEB_HOST=www.eticketsgo.com SENTRY_DISABLE_AUTO_UPLOAD=true NODE_ENV=production \
  npx expo prebuild --platform android --no-install --clean
(cd android && ./gradlew bundleRelease)
```

Optional build inputs, never committed:

| Variable                                   | Effect                                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `GOOGLE_SERVICES_JSON` (EAS file variable) | Turns push on (Firebase). Without it the app never asks for notification permission.                       |
| `EXPO_PUBLIC_SENTRY_DSN`                   | Turns crash reporting on. Without it Sentry does nothing.                                                  |
| `SENTRY_AUTH_TOKEN` (EAS secret)           | Uploads source maps. Production leaves auto-upload on, so set it or set `SENTRY_DISABLE_AUTO_UPLOAD=true`. |

## 4. Play Console steps (owner)

1. Create the app: name ETicketsGo, default language English, app, free.
2. App content: privacy policy URL, ads (none), app access (a test account for reviewers:
   create a dedicated one on production; QA accounts do not exist there), content rating,
   target audience, data safety, account deletion URL. Drafts in `store-listing/README.md`.
3. Main store listing: text and assets in `store-listing/`.
4. Internal testing: upload the signed AAB, add up to 100 testers by email, share the opt-in
   link. Available within minutes, no review.
5. Closed testing: a track with at least 12 testers who stay opted in for 14 days in a row.
   Required before production for a personal account created after 13 November 2023.
6. Production: apply for access after the closed test, then a staged rollout (start at 10%).

## 5. Release checklist

- [x] PRs merged: 461, 476 (app), 477 (web: assetlinks + deletion page), 478 (API: deletion
      clears the phone number). 2026-10-24.
- [ ] PR 479 merged (Play Integrity + phone sign-in).
- [x] Upload keystore created, EAS-managed.
- [ ] Signed AAB from the production profile (blocked on EAS build quota until 2026-11-01).
- [ ] Production smoke on a physical phone: browse, sign up, buy a ticket with a real low
      amount only with the owner's approval, open the ticket offline, refund request.
- [ ] Push credential and Sentry DSN set, or knowingly shipped without.
- [ ] App Links fingerprint set on www after the first Play upload; verify with
      `adb shell pm get-app-links com.eticketsgo.customer`.
- [ ] Store listing, data safety, content rating, deletion URL submitted.
- [ ] Closed test running 14 days with 12+ testers.

## 6. Owner setup for push, crash reporting and phone sign-in

None of these can be done from the repository: each needs the owner's Google, Firebase or
Sentry account. The code for all three is merged or in PR 479 and stays off until configured.

### Play Integrity (phone sign-in and every guarded route)

1. Google Cloud console: create (or pick) a project; note its **project NUMBER**.
2. Enable **Google Play Integrity API** in that project.
3. Play Console > the app > Test and release > App integrity > Play Integrity API > **Link
   cloud project** (the one above).
4. IAM > Service accounts > create one (no role needed) > Keys > add a JSON key.
5. On the API service of each environment that should accept it (QA first):
   - `PLAY_INTEGRITY_PACKAGE_NAMES` = `com.eticketsgo.customer,com.eticketsgo.customer.preview`
   - `PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER` = the number
   - `PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON` = the key (secret)
   - QA only, for sideloaded APKs: `PLAY_INTEGRITY_ALLOW_UNRECOGNIZED_APP=true` (refused at
     boot in production).
6. The check only runs when `TURNSTILE_MODE` is `adaptive` or `always` (QA: unset = off).
7. A live code also needs an SMS provider; QA has `SMS_PROVIDER=log` and answers
   `SMS_UNAVAILABLE`, which the app shows as "use email instead".

Verify: install from the internal-testing track, Account > Sign in > Mobile > send a code; the
API metric `etg_human_check_total{outcome="pi_passed"}` counts it.

### Firebase Cloud Messaging (push)

1. Firebase console: add an Android app `com.eticketsgo.customer` (and
   `com.eticketsgo.customer.preview` for QA) to a project; download `google-services.json`.
2. `npx eas-cli env:create --environment production --name GOOGLE_SERVICES_JSON --type file
--value ./google-services.json --visibility secret` (and `preview`). The build then turns
   push on (`pushEnabled`); without it the app never asks for permission.
3. Firebase > Project settings > Service accounts > generate a key; upload it to Expo as the
   **FCM V1** credential: `npx eas-cli credentials` > Android > production > Push
   notifications: FCM V1.
4. API and worker: `PUSH_PROVIDER=expo` (QA first). On QA a variable change redeploys main.

### Sentry (crash reporting)

1. Sentry: create a React Native project `customer-mobile` in the `eticketsgo` org.
2. EAS production env: `EXPO_PUBLIC_SENTRY_DSN` (plain) and `SENTRY_AUTH_TOKEN` (secret,
   for source maps; then remove `SENTRY_DISABLE_AUTO_UPLOAD`).
3. What is sent: `sendDefaultPii: false`; the user is reduced to the account id; no email,
   name, phone, token, or payment field (`src/services/sentry.ts`). The API side also drops
   the bot-check headers.

## 7. Rollback and recovery

- **A bad release on Play:** halt the staged rollout (Play Console > Release > Halt). Users
  who already updated keep it; fix forward with a higher versionCode. Play does not allow a
  lower versionCode, so a rollback IS a new build of the previous commit with a new
  versionCode.
- **Server-side protection:** every money and ticket decision is the server's (booking
  status, payment confirmation, refunds, sale states), so most defects can be stopped from
  the API side (pausing sales on an event) without an app update.
- **Lost upload key:** Play Console > App integrity > request an upload key reset.
- **QA builds** are sideloaded APKs; to roll back, install the previous APK after
  uninstalling (signatures must match).
