# TestFlight and App Store release

What stands between the native app on `main` and a TestFlight build, who does each step, and the
order. Nothing here is done by an automated session without the owner's explicit approval:
uploading, submitting and enabling production are owner decisions.

## Status (2026-11-05)

| Area | State |
| --- | --- |
| Code on `main` | Native SwiftUI app (PRs #568–#573). Unit and simulator UI suites pass |
| Prod build | Compiles unsigned. Bundle ID `com.eticketsgo.customer`. All production switches `NO` |
| Signing | **Blocked**: no Apple Developer membership or Team ID on the build Mac |
| QA deploy of `main` | **Blocked**: `RAILWAY_TOKEN_QA` is rejected as invalid ("Invalid RAILWAY_TOKEN"). QA still runs its previous build |
| Live QA certification | Passed: sign-in, history and tickets, refresh, logout, account deletion, holds |
| Live QA certification | Waiting: Stripe test payment, ticket confirmation and check-in (see below) |

## 1. Apple enrollment checklist (owner)

1. Enroll the **organization** (not an individual) in the Apple Developer Program. You need a D-U-N-S number for the legal entity, and approval can take several days.
2. In Certificates, Identifiers & Profiles, register the App ID **`com.eticketsgo.customer`** with the **Associated Domains** capability.
   - If the ID is already taken by another team, stop and decide on a new one. The Prod bundle ID lives only in `Config/Prod.xcconfig`.
   - Also register `com.eticketsgo.customer.native.qa` if QA builds go to TestFlight too.
3. Add the build Mac's Apple ID to the team as Admin or App Manager, and sign in under Xcode > Settings > Accounts.
4. Copy `Config/Signing.local.xcconfig.example` to `Config/Signing.local.xcconfig`, which is gitignored, and set `DEVELOPMENT_TEAM` to the Team ID shown under Membership details. Never commit it.
5. In App Store Connect, create the app record:
   - **Name:** ETicketsGo
   - **Bundle ID:** `com.eticketsgo.customer`
   - **SKU:** your choice
   - **Primary language:** English

## 2. App Store Connect metadata (owner)

- **Privacy "nutrition label":** must match `ETicketsGo/Resources/PrivacyInfo.xcprivacy`.
  - Collected, linked to the user and used only for app functionality: name, email address, phone number, user ID and purchase history.
  - No tracking.
  - Card details are entered on the provider's page, never in the app.
- **URLs:**
  - Support: `https://eticketsgo.com/help`
  - Privacy policy: `https://eticketsgo.com/privacy`
- **Account deletion (Guideline 5.1.1(v)):** in the app under Profile > Delete account.
- **App Review:**
  - Provide a demo customer account. The account must have **no** organization, because deleting a sole organization owner's account is refused.
  - Notes should say that payments are made on Stripe's hosted page.
- **Export compliance:** answered in the build (`ITSAppUsesNonExemptEncryption = NO`, HTTPS only).
- **Media:** screenshots for 6.9" and 6.5" iPhone, plus the 1024px app icon (already in the asset catalog).

## 3. Signed archive (engineer, after section 1)

```sh
cd apps/customer-ios
xcodebuild archive -project ETicketsGo.xcodeproj -scheme "ETicketsGo Prod" -configuration Prod \
  -destination 'generic/platform=iOS' -archivePath build/ETicketsGo.xcarchive -allowProvisioningUpdates
```

Check the archive before anything leaves the Mac:
- the bundle ID
- the `associated-domains` entitlement (`applinks:eticketsgo.com`)
- all four production switches still `NO` in `Info.plist`

**Uploading to TestFlight needs the owner's explicit approval.**

## 4. Production enablement (owner decision, per switch)

All of these are `NO` in `Config/Prod.xcconfig`, and a unit test fails if any of them changes.

| Switch | Turns on | Prerequisite |
| --- | --- | --- |
| `ALLOW_MUTATIONS` + `PROD_LAUNCH_APPROVED` | Sign-in, sign-up and account deletion for everyone | Launch approval. Both must be `YES`; either alone does nothing |
| `ALLOW_BOOKING_WRITES` | Holds and cancellations | The above, plus a decision to sell |
| `NATIVE_CHECKOUT` | Opening Stripe's hosted page from the app | Live Stripe and Connect activated (docs/ops/PRODUCTION-READINESS-2026-10.md, item 8) |

## 5. Owner blockers outside Apple

1. **Railway QA token.**
   - The `deploy-railway.yml` dispatch for QA fails at its first step with "Invalid RAILWAY_TOKEN". The last successful workflow deploy was 2026-08-27.
   - Fix: create a new project token for the QA environment in Railway and store it as `RAILWAY_TOKEN_QA` on the `qa` GitHub Environment.
   - Before the next QA deploy, set:
     - `APP_CHECKOUT_RETURN_ENABLED=true` on the QA API
     - `NEXT_PUBLIC_APP_RETURN_SCHEME=etgnative-qa` on QA customer-web. It is a build argument, so set it before the build.
   - After the Team ID exists, also set `APPLE_APP_IDS=<TEAMID>.com.eticketsgo.customer` on QA customer-web.
2. **Stripe Connect test onboarding.**
   - A disposable US QA organizer has a Stripe test connected account in `ONBOARDING`.
   - Stripe's hosted onboarding shows a CAPTCHA to automated browsers, so a person has to finish it. In the organizer console: Payouts > continue setup, then Stripe's "Use test phone number" and test-data buttons. It takes about two minutes.
3. **QA admin approvals.** The disposable organizer organization (PENDING) and its free test event (UNDER_REVIEW) need approving in the QA admin console before check-in can be certified.

## 6. QA certification still to run (after section 5)

Run with [qa-booking-certification.md](qa-booking-certification.md). It changes QA data only with written approval.

1. Paid USD event from the onboarded organizer:
   1. Hold, then Stripe test checkout (`4242 4242 4242 4242`).
   2. Webhook confirmation, then the ticket and its QR.
2. Declined card (`4000 0000 0000 0002`): the booking stays unpaid and the hold is released.
3. Check-in:
   - first scan admitted
   - second scan refused as a duplicate
   - a cancelled or unpaid booking's ticket refused (#469)
4. On a signed QA build, with QA redeployed:
   - The checkout return comes back into the app, and the app confirms by polling the server, not by trusting the return.
   - Universal links (`/events`, `/movies`, `/booking`) open the right screens.

## 7. Feature gaps against Android

Each one is iOS-only and suits its own PR, in suggested order:

| # | Gap | Notes |
| --- | --- | --- |
| 1 | Edit profile | `PATCH /users/me` (name, country of residence) |
| 2 | Refund requests | Android's refund sheet; the server decides eligibility |
| 3 | Push notifications | APNs needs the Team ID and an APNs key; the server already sends to Expo tokens. Needs an API decision |
| 4 | Razorpay / INR checkout | Needs a server-hosted page or the native SDK (phase-3-checkout-design.md §10-A) |
| 5 | Become an organizer | Android has it; low priority for the customer app |
