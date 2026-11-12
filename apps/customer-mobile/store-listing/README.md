# Google Play listing (draft for owner approval)

Everything Play Console asks for in _Main store listing_ and _App content_, prepared from the
app as it is. Nothing here is submitted: publishing needs the owner's approval.

## Assets in this folder

| Asset             | File                                                | Play requirement                                                          |
| ----------------- | --------------------------------------------------- | ------------------------------------------------------------------------- |
| App icon          | `play-icon-512.png`                                 | 512 x 512, 32-bit PNG, no transparency                                    |
| Feature graphic   | `feature-graphic-1024x500.png`                      | 1024 x 500 (draft: wordmark spacing is looser than the website's; review) |
| Phone screenshots | `screenshots/01-home.png` ... `07-your-tickets.png` | 2-8, long side at most 2x the short side; these are 1200 x 2400           |

The screenshots are real screens of the release build on an Android 14 emulator against QA,
taken in Android's demo mode (clean status bar). They show QA content: "Sample event" labels,
a test account and a QA test ticket. **Before production, retake them on the production build
against real events**, or approve these knowingly.

## Screenshots (retaken 2026-10-25, demonstration content)

Seven phone screenshots, 1200 x 2400 (Play allows at most 2:1; the 1080 x 2400 captures are
padded with the brand paper colour). Taken on an Android 14 emulator in demo mode (clean
status bar) with the 1.0.0 code against QA, a controlled environment:

| File                    | Shows                                            |
| ----------------------- | ------------------------------------------------ |
| `01-home.png`           | Home in Bengaluru, a featured event              |
| `02-event.png`          | Event page: facts, time zone note, price from    |
| `03-choose-tickets.png` | Choosing ticket types and quantities             |
| `04-checkout.png`       | Checkout with the price breakdown, before paying |
| `05-your-tickets.png`   | Your tickets (saved for offline use)             |
| `06-film-times.png`     | A film's showtimes by date                       |
| `07-seat-map.png`       | Choosing seats on a cinema seat map              |

Safety of the content:

- **Demonstration events only**, each visibly labelled `Sample event` in the app. They belong
  to the QA demo organization and are fictional; no screenshot claims a real, live event.
- **Synthetic account**: name "Demo Customer", email `store-demo@eticketsgo.test` (a reserved
  test domain). No personal email, name or phone anywhere.
- **No usable ticket**: the ticket pass (QR code) is deliberately not included. The booking
  shown in "Your tickets" (ETG-IND-2026-000077) is a Razorpay test-mode purchase on QA.
- The previous drafts (QA test account email, a scannable QA ticket) were removed from this
  folder; they remain in git history only.

Before the PRODUCTION listing goes public, decide whether to keep demonstration screenshots
or retake them with real published events on the production build. Play requires
screenshots to show the app as it is; the "Sample event" label keeps these honest.

## Store listing text

**App name** (30 max): `ETicketsGo`

**Short description** (80 max, 67 used):
`Tickets for films and live events. Every fee shown before you pay.`

**Full description** (4000 max):

```
Find films, concerts, comedy, theatre and workshops near you, choose your seats, and keep
your tickets on your phone.

Every fee before you pay
The total you see before you pay is the total you are charged. Each fee is on its own line.

Your ticket works without a signal
Your tickets are saved on your phone, so the QR code opens at the gate even when the venue
network does not.

Choose your seats
For seated shows, pick your exact seats on the seat map, or use the list view.

Times at the venue
Every time is shown in the venue's own time zone, so a ticket says what the door says.

Refunds, in plain words
Before you buy, the event says whether you can get your money back, and until when. You can
ask for a refund from your booking.

Your account, on any device
Sign in to see your tickets on your phone and on the web. You can delete your account at any
time from Account, Delete account.
```

**Category:** Events. **Contact email:** owner to provide (Play shows it publicly).
**Privacy policy URL:** `https://www.eticketsgo.com/privacy`
**Account deletion URL:** `https://www.eticketsgo.com/delete-account` (live on production; checked 2026-11-04)

## Data safety (reviewed 2026-10-24 against the 1.0.0 AAB)

Answers for **Android 1.0.0 (versionCode 4) as built**: no `google-services.json` (push off)
and no Sentry DSN (crash reporting off). When either is switched on, the rows marked "later"
change and the form must be updated BEFORE that build is released. Sources: what the app
sends to the API (`apps/customer-mobile/src`), the release manifest (bundletool), and
Razorpay's published table for its Android SDK
(razorpay.com/docs/payments/payment-gateway/android-integration/standard/google-data-safety).

Security answers: data is encrypted in transit (HTTPS only; cleartext is off). Users can ask
for their data to be deleted: in the app (Account > Delete account) and at
`https://www.eticketsgo.com/delete-account` (live on production; checked 2026-11-04).

| Data type (Play)                                  | Collected in 1.0.0                                                                   | Shared                                         | Purpose                                        | Optional |
| ------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------- | ---------------------------------------------- | -------- |
| Personal info: Name                               | Yes                                                                                  | Yes: the event organizer; the payment provider | App functionality, account management          | No       |
| Personal info: Email address                      | Yes                                                                                  | Yes: as above                                  | App functionality, account management          | No       |
| Personal info: Phone number                       | Yes, when used to sign in, entered at payment, or added to the account               | Yes: the payment provider                      | App functionality, account management          | Yes      |
| Personal info: User IDs                           | Yes                                                                                  | No                                             | Account management                             | No       |
| Financial info: Purchase history                  | Yes                                                                                  | Yes: the organizer of the event                | App functionality                              | No       |
| Financial info: User payment info                 | Collected by the Razorpay SDK on its own screens; never by ETicketsGo                | Razorpay                                       | App functionality (payments), fraud prevention | No       |
| Location: Approximate location                    | Yes: the city is estimated on the server from the network address. GPS is never used | No                                             | App functionality (what is on nearby)          | No       |
| App activity: App interactions                    | Razorpay SDK, on its payment screens only                                            | Razorpay                                       | Fraud prevention, security                     | No       |
| App activity: Installed apps                      | Razorpay SDK, only to find installed UPI apps                                        | Razorpay                                       | App functionality (UPI)                        | No       |
| App activity: Other user-generated content        | Refund reasons and support messages                                                  | Refund reasons: the organizer                  | App functionality, customer support            | Yes      |
| Device or other IDs                               | Razorpay SDK device data. ETicketsGo: **no** in 1.0.0 (later: the push token)        | Razorpay                                       | Fraud prevention (Razorpay)                    | No       |
| App info and performance: Crash logs, Diagnostics | **No** in 1.0.0 (later: Sentry, account id only, no name, email or phone)            | No                                             | (later) Analytics: app stability               | No       |

Not collected: precise location, contacts, photos and videos, files, calendar, messages,
health and fitness, web browsing history, credit score.

**Play Integrity** (bot check, used only when the server asks for one; off on QA and
production today): Google Play processes the request under the Play terms and returns a
verdict; ETicketsGo receives only that verdict, does not store it and gets no device
identifier from it ([Google's data safety notes](https://developer.android.com/google/play/integrity/terms)).
Google leaves the answer to the developer; the recommendation is no extra row, plus the
privacy-policy sentence below. Owner decides.

**Permissions in the 1.0.0 manifest** (all normal or signature permissions; none is a
runtime "dangerous" permission): `INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE`,
`POST_NOTIFICATIONS` (asked only after a booking, and only in a build with push), `VIBRATE`,
`WAKE_LOCK`, `RECEIVE_BOOT_COMPLETED` and the launcher badge permissions
(expo-notifications), `com.google.android.c2dm.permission.RECEIVE` (push delivery), `NFC`
and `READ_BASIC_PHONE_STATE` (Razorpay SDK), `USE_BIOMETRIC` and `USE_FINGERPRINT`
(androidx.biometric), and the Play install referrer service. Camera, microphone, storage,
contacts and location permissions are not requested; `WRITE_SETTINGS` and
`SYSTEM_ALERT_WINDOW` are removed in `app.config.ts`.

## Privacy policy (version 2, effective 2026-10-25)

Owner-approved in principle on 2026-10-24 and written in `apps/customer-web/app/[locale]/privacy/page.tsx` (registry: `packages/shared-types/src/legal.ts`, v1 kept as superseded). It now matches the Data safety answers above:

- Section 1: approximate location (city from the network address; no GPS).
- Section 4: self-service deletion in the app and at `/delete-account`, and what deletion keeps.
- Section 9, the app: Razorpay (India) and Stripe (where we take payment elsewhere) collect payment and device data on their own screens; notifications, crash reports and the Google Play integrity check are described as **built in but not switched on**.

When push, crash reporting or the integrity check is switched on, update the Data safety form first, then this section if the behaviour differs from what it says.

## App access (reviewer instructions, draft)

Paste into App content > App access > "All or some functionality is restricted". The owner
creates the account on PRODUCTION; never put a password in this file.

```
Browsing events, films and seat maps needs no account.

Sign-in is needed for checkout, Your tickets and Account. Use email sign-in:
1. Open Account, tap "Sign in", choose "Email".
2. Email: <reviewer email>   Password: <reviewer password>
Phone sign-in sends a one-time code by SMS and cannot be used by reviewers.

To book without paying, open the free event "<free event title>" (city: <city>), tap
"Get my tickets", and open the ticket under Tickets. "Cancel tickets" gives it back.

Payment for paid events opens Razorpay (India) or Stripe (US) on the provider's own page.
Please do not complete a payment: it charges a real card.

Account deletion: Account > Delete account. This permanently deletes the reviewer account;
we will recreate it if needed. The same is available at
https://www.eticketsgo.com/delete-account
```

## Submission checklist (2026-11-11, build after PRs 643/644)

Status words: DONE = proven; OWNER = needs Play Console or a business decision; BLOCKED = waits on
something outside engineering. Nothing here is marked done without the evidence named.

| Item                                                                  | Status          | Evidence / action                                                                                                                                                               |
| --------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Organization developer account (DeepTrics Software Solutions Pvt Ltd) | BLOCKED         | D-U-N-S pending, then Google's organization verification. Never a personal account.                                                                                             |
| Package `com.eticketsgo.customer`, versionName 1.0.0                  | DONE            | Built and checked with bundletool; versionCode comes from EAS (remote, auto-increment).                                                                                         |
| Target API 36 (required for new apps from 2026-08-31)                 | DONE            | `targetSdkVersion` 36 in the bundle manifest.                                                                                                                                   |
| Signing                                                               | DONE / OWNER    | Upload key on EAS (SHA-256 `86:D8:AE:...:E3:2A`). The owner turns on Play App Signing when creating the app.                                                                    |
| Permissions                                                           | DONE            | No camera, location, storage, contacts or draw-over-apps; `POST_NOTIFICATIONS` only asked in a build with push (push is off).                                                   |
| Privacy policy URL                                                    | DONE            | `https://www.eticketsgo.com/privacy` (v2, live).                                                                                                                                |
| Account deletion URL + in-app path                                    | DONE            | `https://www.eticketsgo.com/delete-account` (live); Account > Delete account (verified on QA).                                                                                  |
| Data safety                                                           | OWNER           | Draft above; no SDK added since it was written (Expo 57 patch versions only). The owner submits it.                                                                             |
| Content rating (IARC)                                                 | OWNER           | Inputs above.                                                                                                                                                                   |
| Target audience, ads, financial features                              | OWNER           | Inputs below.                                                                                                                                                                   |
| Store listing text, icon, feature graphic, 7 screenshots              | DONE / OWNER    | In this folder. Screenshots are labelled demonstration content from QA; retake on production once real events exist, or keep the "Sample event" label.                          |
| Release notes                                                         | DONE            | Above.                                                                                                                                                                          |
| App access (reviewer)                                                 | OWNER + BLOCKED | Reviewer account on production, and a published event (see next section).                                                                                                       |
| Countries                                                             | OWNER           | India and the United States (where the platform sells). Do not list other countries: the app has no catalogue or payment route there.                                           |
| App Links (website links open the app)                                | OWNER           | After the app exists: Play's app-signing SHA-256 into `ANDROID_APP_LINKS` on production customer-web (owner-approved change). Until then links open the website, which is safe. |

## How a reviewer can test without paying

Production lists **no public events** today (checked 2026-11-11: India 0, United States 0), so a
reviewer would open an empty app. Google may reject an app whose core function cannot be
reached. Before submitting for review:

1. Publish at least one real **free** event on production (any city in India or the US). A free
   event confirms without payment, so the reviewer can complete: browse > event > Get my tickets
   > ticket with QR code > Cancel tickets. No card is needed and no money moves.
2. Optionally publish real paid events; the reviewer is told not to pay (App access text).
3. Create the reviewer account on production with email sign-in and put it under App access.

A QA or test environment is not an option for review: the Play build talks only to production.

## Play Console setup steps (owner)

**1. Organization account (DeepTrics Software Solutions Pvt Ltd).** Needs the D-U-N-S number,
the legal name and address exactly as on the D-U-N-S record, a website
(`https://www.eticketsgo.com`), a verified developer email and phone, and a Google payments
profile in the same legal name. Google then verifies the organization. Never a personal account.

**2. Create the app.** All apps > Create app: name `ETicketsGo`, default language English
(United States), App, Free. Package is set by the first upload: `com.eticketsgo.customer`
(it can never change).

**3. Play App Signing.** On the first release, accept "Use a Google-generated app signing key"
(recommended). The bundle from EAS is signed with the UPLOAD key (SHA-256
`86:D8:AE:AD:09:E7:46:5B:A8:3B:DC:79:56:A9:97:79:17:AD:A5:64:FE:56:78:7D:57:01:71:BC:F5:D5:E3:2A`); Play
re-signs installs with its own key. Keep the upload key on EAS and its backup (section 6.4 of
`docs/PLAY-RELEASE.md`). If it is ever lost, request an upload-key reset in the Console.

**4. Internal testing first.** Testing > Internal testing > Create new release > upload the AAB
from `Documents/ETicketsGo-Releases/` after `sha256sum -c SHA256SUMS`; paste the release notes;
add testers by email; install from the opt-in link on a phone.

**5. App content.** Privacy policy URL, App access (reviewer text above), Ads: none, Content
rating (IARC inputs above), Target audience 18+, Data safety (table above), Financial features:
none, Government app: no, Account deletion URL. Countries: India and United States only.

**6. App Links fingerprint (after step 3).** Setup > App integrity > App signing > copy the
"App signing key certificate" SHA-256. With the owner's approval, set on production
customer-web: `ANDROID_APP_LINKS=com.eticketsgo.customer:<that SHA-256>` (add
`,com.eticketsgo.customer:<upload SHA-256>` only if testers install builds outside Play). Then
check `https://www.eticketsgo.com/.well-known/assetlinks.json` returns it, and on a phone with the
Play build: `adb shell pm verify-app-links --re-verify com.eticketsgo.customer` followed by
`adb shell pm get-app-links com.eticketsgo.customer` shows `www.eticketsgo.com: verified`.

**7. Production review.** Only after: a real free event is published on production, the
reviewer account exists, and internal testing passed on a physical phone.

## Release notes (1.0.0)

```
<en-US>
First release of ETicketsGo for Android. Find films and live events near you, choose your
seats, see every fee before you pay, and keep your tickets on your phone, even offline.
</en-US>
```

## Content rating (IARC questionnaire, draft)

No violence, sexual content, profanity, controlled substances or gambling in the app itself.
It sells tickets to real-world events, some with age limits (shown on the event page), and
lists films with their certificates (UA13+, A). No user-to-user communication and no
user-generated content shown to others. **Digital purchases: no** (event tickets are
real-world services, not digital goods; an earlier draft said yes, which was wrong). Expected
rating: Everyone / 3+. The answers are the owner's to submit.

## Developer identity (organization account)

Published from a DeepTrics organization account (see `docs/PLAY-RELEASE.md` section 4).
Developer (legal entity, subject to Google's verification): **DeepTrics Software Solutions
Private Limited**, which the privacy policy names as the operator in India. Play shows its
legal name and address on the listing. Developer email: `support@eticketsgo.com` (public). Website:
`https://www.eticketsgo.com`.

The 12-tester, 14-day closed test is a rule for personal accounts and does not apply. A short
closed test with the team and a few organizers is still recommended before production.

## Target audience and other declarations

- Target audience: 18 and over (purchasing). Not designed for children.
- Ads: none.
- Government app: no. Financial features: payments through Razorpay; no loans or crypto.
- News app: no. Health: no.
