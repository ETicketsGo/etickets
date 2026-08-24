# Notification providers — what to buy, and where each value goes

Everything below is **placeholder-ready**: the code reads these variables today and falls
back to a `log` transport when they are absent, so nothing breaks while you are still
signing up. Fill them in and the same notifications start reaching real people.

**No credential belongs in git.** Every value here is a Railway service variable.

---

## What is actually needed

| Channel         | Needed for                                     | Provider                | Cost to start                                     |
| --------------- | ---------------------------------------------- | ----------------------- | ------------------------------------------------- |
| **Email**       | Tickets, approval requests, approval decisions | SendGrid **or** AWS SES | SendGrid free tier ~100/day; SES ~$0.10 per 1,000 |
| **Mobile push** | The phone app                                  | **Expo**                | **Free, no account needed**                       |
| **Web push**    | Browser notifications                          | VAPID (self-generated)  | Free                                              |
| SMS             | Not required for the pilot                     | Twilio / MSG91          | Per message                                       |
| WhatsApp        | Not required for the pilot                     | Meta BSP                | Per conversation                                  |

**Only email costs money to start.** Push needs nothing bought.

---

## Email — the one to decide

Pick **one**. Both are already implemented; `EMAIL_PROVIDER` selects.

### SendGrid

```
EMAIL_PROVIDER=sendgrid
EMAIL_FROM=noreply@eticketsgo.com        # must be a VERIFIED sender or domain
SENDGRID_API_KEY=SG.xxxxxxxx             # Settings → API Keys → Restricted, "Mail Send" only
```

Verify the **domain**, not just an address — an unverified sender lands in spam, and a
ticket in a spam folder is a customer at a gate without one.

### AWS SES

```
EMAIL_PROVIDER=ses
EMAIL_FROM=noreply@eticketsgo.com
AWS_SES_REGION=ap-south-1                # Mumbai, for an India pilot
```

Credentials come from the standard AWS chain (task role or `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY`).

> **SES starts in a sandbox** that only sends to addresses you have verified. Production
> access is a support request that takes a day or so. Raise it **before** the pilot, not
> during it — the failure mode is silent from our side and looks like "the customer never
> got their ticket".

---

## Mobile push — free, and already matched to the app

```
PUSH_PROVIDER=expo
```

That is the whole configuration. The app registers `ExponentPushToken[...]` through
`expo-notifications`, and the device token itself authorises delivery, so **no account, key
or subscription is required**.

`EXPO_ACCESS_TOKEN` is optional and only needed if you switch on _enhanced security for push
notifications_ in the Expo dashboard. The code sends the header when the variable is
present, so enabling it later needs no code change.

> **Do not set `PUSH_PROVIDER=fcm`** unless the app is changed to register native FCM
> tokens. FCM cannot deliver to an Expo token — that mismatch is exactly why push never
> arrived before: devices registered successfully and every send went nowhere.

### Also required for real devices

- **iOS** — an Apple Developer Program membership (**$99/year**) to ship the app at all.
  Expo handles the APNs key during `eas build`; there is no separate push purchase.
- **Android** — a Google Play developer account (**$25 once**). Expo handles FCM
  credentials during the build.

Neither is a _notification_ cost; they are the cost of shipping the app.

---

## Web push — free

```
WEBPUSH_PROVIDER=vapid
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:ops@eticketsgo.com
```

Generate with `npx web-push generate-vapid-keys`. Self-issued; nothing to buy.

---

## Recommended pilot posture

| Environment               | Email                                                       | Mobile push                                              |
| ------------------------- | ----------------------------------------------------------- | -------------------------------------------------------- |
| LOCAL / DEV               | `log`                                                       | `log`                                                    |
| QA                        | `log`                                                       | `expo` (safe: only your own test devices are registered) |
| **UAT (pilot rehearsal)** | **`sendgrid` or `ses`** — testers must receive real tickets | **`expo`**                                               |
| PRODUCTION                | `sendgrid` or `ses`                                         | `expo`                                                   |

`log` writes the message to the service log and sends nothing. It is honest and free, and
it is the wrong choice the moment a human has to receive something.

---

## What is wired today

| Event                                   | Who is notified               | Type                                  |
| --------------------------------------- | ----------------------------- | ------------------------------------- |
| Organization registers                  | **every active admin**        | `ORGANIZATION_REGISTERED`             |
| Admin approves / rejects it             | the organization's **owners** | `ORGANIZATION_APPROVED` / `_REJECTED` |
| Event submitted for review              | **every active admin**        | `EVENT_SUBMITTED`                     |
| Admin approves / rejects it             | the organization's **owners** | `EVENT_APPROVED` / `_REJECTED`        |
| Payment succeeds                        | the **buyer**                 | `BOOKING_CONFIRMED`                   |
| Refund completes                        | the buyer                     | `REFUND_COMPLETED`                    |
| Ticket checked in, shared, transferred… | the holder                    | (existing types)                      |

Every one goes to **email + the in-app inbox + push**, subject to the recipient's
preferences. Admin fan-out is per-person rather than to a shared mailbox, so one admin
reading a request does not hide it from the others, and each gets it on their own devices.

Approval notifications **never throw**: they run inside the request that registers the
organization or submits the event, and a mail outage must not lose that work. Failures are
logged loudly instead.
