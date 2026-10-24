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

## Data safety (draft answers)

Built from what the app sends to the ETicketsGo API (`apps/customer-mobile/src`) and from
Razorpay's published table for its Android SDK
(razorpay.com/docs/payments/payment-gateway/android-integration/standard/google-data-safety).
All data is encrypted in transit (HTTPS only). Users can request deletion (in app, and the
URL above).

| Data type                    | Collected                                                                           | Shared                                                 | Why                                                       | Optional |
| ---------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------- | -------- |
| Name                         | Yes                                                                                 | Yes, with the event organizer and the payment provider | Bookings, tickets, account                                | No       |
| Email address                | Yes                                                                                 | Yes, as above                                          | Account, tickets and receipts                             | No       |
| Phone number                 | Yes, when used to sign in, entered at payment, or added to the account              | Yes, with the payment provider                         | Payment (the provider requires a contact number), account | Yes      |
| User IDs                     | Yes                                                                                 | No                                                     | Account                                                   | No       |
| Purchase history             | Yes                                                                                 | Yes, with the organizer of the event                   | Bookings, refunds, receipts                               | No       |
| User payment info            | Collected by the Razorpay SDK, never by ETicketsGo                                  | Razorpay                                               | Payment                                                   | No       |
| Approximate location         | Yes: the city is estimated on the server from the network address, never from GPS   | No                                                     | Show what is on nearby                                    | No       |
| App interactions             | Razorpay SDK, on its payment screens only                                           | Razorpay                                               | Payment, fraud prevention                                 | No       |
| Installed apps               | Razorpay SDK, only to find installed UPI apps                                       | Razorpay                                               | UPI payment                                               | No       |
| Crash logs, diagnostics      | Only when crash reporting is configured (Sentry); account id only, no email or name | No                                                     | App stability                                             | No       |
| Device or other IDs          | Push token, once push is configured; Razorpay SDK device data                       | No (ETicketsGo); Razorpay                              | Notifications; payment                                    | No       |
| App and device integrity     | Play Integrity verdict, only when the server asks for a bot check (sign-in, codes)  | Decoded by Google for us; no copy kept                 | Fraud prevention, security                                | No       |
| Other user-generated content | Refund reasons and support messages                                                 | Refund reasons, with the organizer                     | Support, refunds                                          | Yes      |

Not collected: precise location, contacts, photos, files, calendar, messages, health,
browsing history, credit score.

**Permissions in the release manifest** (for the review questions): `INTERNET`,
`POST_NOTIFICATIONS`, `VIBRATE`, network and Wi-Fi state; from the Razorpay SDK `NFC` and
`READ_BASIC_PHONE_STATE`; from `androidx.biometric` `USE_BIOMETRIC` and `USE_FINGERPRINT`;
from expo-notifications boot and badge permissions. None is a runtime "dangerous" permission.
Camera, microphone, storage, contacts and location permissions are not requested;
`WRITE_SETTINGS` and `SYSTEM_ALERT_WINDOW` are explicitly removed in `app.config.ts`.

## Content rating (IARC questionnaire, draft)

No violence, sexual content, profanity, controlled substances or gambling in the app itself.
It sells tickets to events, some of which carry age limits (shown on the event page), and it
lists films with their certificates (UA13+, A). Users can make purchases. No user-to-user
communication, no user-generated content shown to others. Expected rating: Everyone / 3+,
with "Users interact" no and "Digital purchases" yes. The answers are the owner's to submit.

## Developer identity (organization account)

Published from a DeepTrics organization account (see `docs/PLAY-RELEASE.md` section 4).
Play shows the developer's legal name and address on the listing, so the entity chosen there
must be one the privacy policy names: DeepTrics LLC, or DeepTrics Software Solutions Private
Limited for India. Developer email: `support@eticketsgo.com` (public). Website:
`https://www.eticketsgo.com`.

The 12-tester, 14-day closed test is a rule for personal accounts and does not apply. A short
closed test with the team and a few organizers is still recommended before production.

## Target audience and other declarations

- Target audience: 18 and over (purchasing). Not designed for children.
- Ads: none.
- Government app: no. Financial features: payments through Razorpay; no loans or crypto.
- News app: no. Health: no.
