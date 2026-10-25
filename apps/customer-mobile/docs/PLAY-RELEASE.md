# Google Play release runbook

What exists, what each step needs, and who does it. Checked against Google's help pages on
2026-10-24: new apps must target **Android 16 (API 36)** (from 31 August 2026).

**The app will be published from an ORGANIZATION developer account under DeepTrics (owner,
2026-10-24), not a personal one.** Google's closed-testing rule (12 testers opted in for 14
days before production) is written for "personal developer accounts created after November
13, 2023" (Play Console Help 14151465), so it is not planned for. The organization's own
gate is verification: a D-U-N-S number and a legal name and address that match Dun &
Bradstreet (section 4).

## 0. Release candidate: Android 1.0.0

Approved by the owner (2026-10-24) for a FUTURE upload to the internal testing track of the
**DeepTrics Software Solutions Private Limited** organization account, once that account is
verified. Not uploaded anywhere.

|                               |                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Package                       | `com.eticketsgo.customer` (kept; never change it after the first upload)                                                                                     |
| Version                       | versionName **1.0.0**, versionCode **4**                                                                                                                     |
| SDK                           | targetSdk 36, minSdk 24                                                                                                                                      |
| Source                        | `main` at **d4ef7c83** (contains the declined-payment fix, PR 480, and the version, PR 482)                                                                  |
| EAS build                     | [83abb1a8-6e21-4e06-99e2-e9b0c9681692](https://expo.dev/accounts/srinivasdeeptrics/projects/eticketsgo-customer/builds/83abb1a8-6e21-4e06-99e2-e9b0c9681692) |
| AAB sha256                    | `0a793c78ebbdc50509a091109ed11b3f74fda69ac9da28aa29d3ded6e2e8f3c3`                                                                                           |
| Upload key SHA-256            | `86:D8:AE:AD:09:E7:46:5B:A8:3B:DC:79:56:A9:97:79:17:AD:A5:64:FE:56:78:7D:57:01:71:BC:F5:D5:E3:2A`                                                            |
| Upload key SHA-1              | `F0:BD:24:C3:4F:F3:57:C1:DE:4B:D3:49:F6:86:F6:D9:34:9A:60:8C`                                                                                                |
| Release security (bundletool) | not debuggable; no cleartext traffic; no keystore, source map or `google-services.json` inside; secure-store tokens excluded from backup                     |

**Retention.** The EAS artifact expires on 2026-11-23. The durable copy is in the owner's
OneDrive: `Documents/ETicketsGo-Releases/android-1.0.0-vc4/` (AAB, `SHA256SUMS`,
`BUILD-INFO.txt`). Check it with `sha256sum -c SHA256SUMS` before uploading. The upload key
stays on Expo (credentials `gPVK3PKg8z`); the owner keeps a backup (section 6.4).

A superseded candidate exists (versionCode 3, 0.1.0, EAS build 11a85cc4): do not upload it. It
lacks the declined-payment fix.

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
- `version` is `1.0.0` in `app.config.ts` (owner, 2026-10-24: the first Play release).
  The next build must be versionCode 5 or higher; EAS increments it. `versionCode` is owned by EAS
  (`appVersionSource: remote`, `autoIncrement` on production). A local Gradle build is
  versionCode 1. The first release is versionCode 4 (the remote counter was 3).
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

EAS (the supported path). The account is on the **Starter plan** (owner, 2026-10-24) with
build credit. The first signed production AAB is listed in section 5.

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

## 4. Play Console steps (owner): DeepTrics organization account

### 4.1 Before the account exists

1. **The legal entity: DeepTrics Software Solutions Private Limited** (owner, 2026-10-24,
   subject to Google's verification). Play shows this name under "Contains information about
   the developer". The privacy policy, terms and contact page already name it as the
   operator in India; they also name DeepTrics LLC for elsewhere, which stays true.
2. **D-U-N-S number for that entity** (free from Dun & Bradstreet; up to 30 days if it does
   not have one). Play will not create an organization account without it.
3. **Google payments profile** in the entity's exact legal name and address, matching the
   D-U-N-S record character for character. A mismatch is the usual reason verification fails.
4. **Contact details, each verified by a one-time code and kept working:** a contact name,
   email and phone (private, for Google), and a developer email and phone (public on the
   listing). Use role addresses, for example `support@eticketsgo.com`, not a person's.
5. **Organization website:** `https://www.eticketsgo.com`.
6. Pay the one-time registration fee and wait for verification.
7. **Users and permissions:** invite the release engineers with the least access they need
   (Release manager for testing tracks; production releases stay with the owner).

### 4.2 Creating the app

1. Create the app: name ETicketsGo, default language English (United States) or English
   (India), app, free. The tickets are paid in the app with Razorpay or Stripe: event tickets
   are real-world services, so Google Play Billing is not used and none is declared.
2. App content (drafts in `store-listing/README.md`):
   - Privacy policy: `https://www.eticketsgo.com/privacy`.
   - App access: a reviewer account. Create it on PRODUCTION (QA accounts do not exist
     there) with email sign-in. Phone sign-in cannot be used by reviewers.
   - Ads: none. Content rating questionnaire. Target audience: 18 and over.
   - Data safety, and the account deletion URL `https://www.eticketsgo.com/delete-account`.
   - Financial features: none (no loans, no wallet held by us).
   - Government app: no. News app: no. Health: no.
3. Main store listing: text and the assets in `store-listing/`. The screenshots are QA
   drafts (approved as drafts only): retake them on the production build before the
   production release.
4. **Play App Signing:** at the first upload, accept **Google-generated app signing key**.
   The EAS key in section 2 stays the upload key.
5. **App integrity > Play Integrity API:** link the Google Cloud project (section 6).

### 4.3 Releasing

1. **Internal testing** (up to 100 testers by email, no review): upload the AAB from
   section 5 and install from the opt-in link. Check:
   - the app installs and opens on a physical phone;
   - Play Integrity: `etg_human_check_total{outcome="pi_passed"}` on the API after a
     sign-in challenge (only once section 6 is done);
   - after this first upload: Setup > App integrity > copy the **app signing key SHA-256**
     into `ANDROID_APP_LINKS` on production customer-web (needs the owner's approval to
     change production), then `adb shell pm get-app-links com.eticketsgo.customer`.
2. **Closed testing** is optional for an organization account. Recommended anyway, with the
   team and a few organizers, for one to two weeks of real use before production.
3. **Production:** owner approval, then a staged rollout starting at 10%. Halt from
   Release > Production if crash or payment errors rise.

## 5. Release checklist

### 5.1 Done

- [x] PRs 461, 476-480, 482 merged; 1.0.0 (versionCode 4) built from d4ef7c83 (section 0).
- [x] Upload keystore created, EAS-managed; durable AAB copy with checksum (section 0).
- [x] QA payment regression on 1.0.0 code: declined and closed payments show no
      "undefined"; retry confirmed ETG-IND-2026-000076.
- [x] Account deletion verified on QA: in-app deletion, then the login is refused (401).
- [x] Data safety reviewed against the 1.0.0 manifest (`store-listing/README.md`).
- [x] Privacy policy v2 (the app, deletion, location, payments; push, crash reports and the
      integrity check described as not switched on).
- [x] Store screenshots retaken with labelled demonstration content and a synthetic account.

### 5.2 Required for INTERNAL TESTING (owner)

Internal testing has no Google review and reaches only invited testers.

- [ ] DeepTrics Software Solutions Private Limited organization account created and verified
      (D-U-N-S, matching payments profile, verified contacts). Never a personal account.
- [ ] App created with package `com.eticketsgo.customer`; Play App Signing with a
      Google-generated key.
- [ ] The 1.0.0 AAB uploaded from `Documents/ETicketsGo-Releases/android-1.0.0-vc4/` after
      `sha256sum -c SHA256SUMS`.
- [ ] Testers' emails added; install from the opt-in link on a physical phone.
- [ ] The minimum App content Play asks for before the first upload (privacy policy URL, app
      access, ads declaration).

### 5.3 Required for the PRODUCTION LAUNCH (owner approval for each)

- [ ] Production `/delete-account` live (customer-web deploy) and `/privacy` v2 live.
- [ ] Full App content submitted: Data safety, content rating (IARC, "Digital purchases: no"),
      target audience 18+, financial features none, account deletion URL.
- [ ] Main store listing: text, icon, feature graphic, screenshots (section above).
- [ ] Reviewer account created on PRODUCTION (email sign-in) and entered under App access.
- [ ] App Links: Play's app signing key SHA-256 in `ANDROID_APP_LINKS` on production
      customer-web; verify with `adb shell pm get-app-links com.eticketsgo.customer`.
- [ ] Decide for this release: push (6.2), crash reporting (6.3) and the integrity check
      (6.1). Each needs a new build (versionCode 5+) and a Data safety update first.
- [ ] Real events published on production, so a new user does not land on an empty app.
- [ ] Production smoke on a physical phone with the Play build: browse, sign up, open a
      ticket offline, delete an account. A real-money purchase only with the owner's
      approval.
- [ ] Staged rollout plan (start at 10%) and the rollback in section 7.

## 6. Owner configuration checklists

Before building the next version, run `node scripts/release-preflight.mjs production` (from
`apps/customer-mobile`). It lists the EAS variable NAMES (never values) and says which of push,
crash reporting and the integrity check the next build will switch on, and fails on an unsafe
Sentry combination. As of 2026-10-25 it reports all three off.

Each needs an account only the owner holds. The code is merged and stays OFF until the values
below exist; nothing fails while they are missing. Set QA first, check it, then production
(production variable changes need the owner's release approval). On QA, any Railway variable
change redeploys `main` (see the deploy runbook).

### 6.1 Play Integrity (bot check for phone codes, sign-in and sign-up)

Console steps:

1. console.cloud.google.com > create project `eticketsgo-play` (any name), owned by the
   DeepTrics Google Workspace or account. Note the **project NUMBER** (Dashboard > Project
   info), not the project ID.
2. APIs & Services > Library > **Google Play Integrity API** > Enable.
3. IAM & Admin > Service accounts > Create: `play-integrity-decoder`. No role is needed.
   Keys > Add key > JSON. Store the file in the password manager; do not email it.
4. Play Console (after the app exists) > Test and release > App integrity > Play Integrity
   API > **Link a Google Cloud project** > the project from step 1.

Railway variables (`api` service only):

| Variable                                | QA                                                        | Production                     |
| --------------------------------------- | --------------------------------------------------------- | ------------------------------ |
| `PLAY_INTEGRITY_PACKAGE_NAMES`          | `com.eticketsgo.customer,com.eticketsgo.customer.preview` | `com.eticketsgo.customer`      |
| `PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER`   | the number from step 1                                    | same                           |
| `PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON`   | the whole JSON key (secret)                               | same                           |
| `PLAY_INTEGRITY_ALLOW_UNRECOGNIZED_APP` | `true` (sideloaded QA APKs)                               | unset (boot refuses true)      |
| `PLAY_INTEGRITY_CERT_SHA256` (optional) | unset                                                     | Play's app signing key SHA-256 |

All three of the first three, or the API refuses to boot. The check only runs while
`TURNSTILE_MODE` is `adaptive` or `always`; it is unset (off) on QA today. Verify: Sign in >
Mobile > Send code from a Play-installed build; the API metric
`etg_human_check_total{outcome="pi_passed"}` goes up. A real code also needs an SMS provider
for the number's country (`SMS_PROVIDER` / `SMS_PROVIDER_BY_MARKET`); QA texts US and CA only.

### 6.2 Firebase Cloud Messaging (push notifications)

The app registers **Expo push tokens**; Expo delivers through FCM. So the API uses
`PUSH_PROVIDER=expo` and needs no Firebase key of its own (`FCM_*` stay unset).

Console steps:

1. console.firebase.google.com > Add project (it can reuse the Cloud project from 6.1).
2. Add app > Android > package `com.eticketsgo.customer` > Register > download
   `google-services.json`. Repeat for `com.eticketsgo.customer.preview` (QA/UAT builds),
   which adds it to the same file.
3. Project settings > Service accounts > Generate new private key (JSON).
4. expo.dev > project eticketsgo-customer > Credentials > Android > `com.eticketsgo.customer`
   > **FCM V1 service account key** > upload the key from step 3. Same for `.preview`.

EAS environment variables:

| Name                   | Type                    | Environments        |
| ---------------------- | ----------------------- | ------------------- |
| `GOOGLE_SERVICES_JSON` | file, visibility secret | production, preview |

`npx eas-cli env:create --environment production --name GOOGLE_SERVICES_JSON --type file --value ./google-services.json --visibility secret`

Railway variables (`api` AND `worker`): `PUSH_PROVIDER=expo`. `EXPO_ACCESS_TOKEN` only if
"enhanced push security" is turned on in the Expo dashboard. Then rebuild the app (push is
decided at build time). Verify: buy a ticket, accept the notification prompt, cancel the show
from the organizer console, and the phone shows the message.

### 6.3 Sentry (crash reporting)

Console steps:

1. sentry.io > organization `eticketsgo` (create it if missing) > Projects > Create >
   **React Native** > name `customer-mobile`.
2. Settings > Projects > customer-mobile > Client Keys (DSN) > copy the DSN.
3. Settings > Developer settings > Organization tokens > Create, scope `project:releases`
   (for source maps).
4. Settings > Projects > customer-mobile > Security & Privacy: turn on **Data Scrubber** and
   **Prevent storing of IP addresses**.

EAS environment variables (production; preview optional):

| Name                         | Visibility | Value                           |
| ---------------------------- | ---------- | ------------------------------- |
| `EXPO_PUBLIC_SENTRY_DSN`     | plain text | the DSN (public by design)      |
| `SENTRY_AUTH_TOKEN`          | secret     | the token from step 3           |
| `SENTRY_ORG`                 | plain text | only if not `eticketsgo`        |
| `SENTRY_PROJECT`             | plain text | only if not `customer-mobile`   |
| `SENTRY_DISABLE_AUTO_UPLOAD` | -          | DELETE it once the token exists |

What the app sends: `sendDefaultPii: false`; the user is reduced to the account id; no
email, name, phone, token or payment field (`src/services/sentry.ts`). A rebuild is needed
(the DSN is read at build time). The API and worker have their own `SENTRY_DSN`; leave them
as they are.

### 6.4 Upload key backup

`npx eas-cli credentials` (interactive) > Android > production > Keystore > **Download**.
Put the `.jks` and its passwords in the password manager, then delete the local file. Never
commit it (`*.jks` and `*.keystore` are git-ignored). Losing it is recoverable (Play Console

> App integrity > Request upload key reset); the app signing key is Google's.

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
