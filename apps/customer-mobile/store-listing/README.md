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
**Account deletion URL:** `https://www.eticketsgo.com/delete-account` (PR 477, merged 2026-10-24; live once deployed)

## Data safety (reviewed 2026-10-24 against the 1.0.0 AAB)

Answers for **Android 1.0.0 (versionCode 4) as built**: no `google-services.json` (push off)
and no Sentry DSN (crash reporting off). When either is switched on, the rows marked "later"
change and the form must be updated BEFORE that build is released. Sources: what the app
sends to the API (`apps/customer-mobile/src`), the release manifest (bundletool), and
Razorpay's published table for its Android SDK
(razorpay.com/docs/payments/payment-gateway/android-integration/standard/google-data-safety).

Security answers: data is encrypted in transit (HTTPS only; cleartext is off). Users can ask
for their data to be deleted: in the app (Account > Delete account) and at
`https://www.eticketsgo.com/delete-account` (**404 on production today**; see the release
checklist).

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
