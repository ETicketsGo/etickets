# QA certification

How to prove a provider actually works, and what "prove" has to mean.

**Nothing here has been run.** No provider credentials exist in this repository, so every
market is `BLOCKED_EXTERNAL_SETUP`. This is the sequence to run once they do.

---

## The rule

> Never report PASS because a variable is set.

`GET /api/admin/notifications/readiness/certification` judges on **delivery evidence**, not on
configuration, and reports one of four levels per channel:

| Level                            | Means                                                                                  |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `CODE_READY`                     | The adapter, routing and callbacks exist. Nothing is configured.                       |
| `CONFIG_READY`                   | Credentials and templates present. **Nothing has ever been sent.**                     |
| `EXTERNAL_VERIFICATION_REQUIRED` | Sends are accepted, but no callback has come back — or no rate exists.                 |
| `LIVE_CERTIFIED`                 | A real send was accepted **and** a real callback arrived **and** a rate is configured. |

A market reports the level of its **weakest** channel. "Email is live" is not "India is live"
when every Indian buyer expects WhatsApp.

---

## Test destinations

Put them in the environment. **Never commit a phone number or an address.**

```bash
QA_TEST_EMAIL=          # a mailbox you own
QA_TEST_PHONE_IN=       # +91…, a handset you own
QA_TEST_PHONE_US=       # +1…
QA_TEST_PHONE_CA=       # +1…
```

Test sends are classified `sendKind = TEST`. They appear in cost reports (a WhatsApp test in
India is real money) and are excluded from customer counts and cost-per-booking.

---

## Sequence, per market

Run against QA. Never production, never a real customer's contact details.

### 1. Confirm what is configured

```
GET /api/admin/notifications/readiness            # per-market config, no secrets
GET /api/admin/notifications/readiness/certification
```

Expect `CONFIG_READY` at best. Work through `externalActions` — each names the console and the
exact setting.

### 2. Send one message per channel

```
POST /api/admin/notifications/readiness/test-send   (PLATFORM_CONFIG)
{ "channel": "email", "to": "<QA_TEST_EMAIL>", "market": "IN" }
```

**Expected database state** — `NotificationDelivery`:

| Column              | Expected                                                        |
| ------------------- | --------------------------------------------------------------- |
| `sendKind`          | `TEST`                                                          |
| `status`            | `ACCEPTED`                                                      |
| `outcomeClass`      | `PROVIDER_ACCEPTED`                                             |
| `provider`          | `ses` / `msg91` / `twilio` / `cloud` / `expo`                   |
| `providerMessageId` | non-null — the provider's own reference                         |
| `acceptedAt`        | set                                                             |
| `costMicro`         | set if a rate exists; **null with `costSource=UNKNOWN` if not** |

If `providerMessageId` is null, the send did not reach the provider. Read `failureReason`.

### 3. Wait for the callback

Re-read the same row. Within a minute or two:

| Column           | Expected                                               |
| ---------------- | ------------------------------------------------------ |
| `status`         | `DELIVERED`                                            |
| `deliveredAt`    | set                                                    |
| `providerStatus` | the provider's own word (`delivered`, `Delivery`, `1`) |

**No callback is the most common failure, and it is silent from the send side.** Check, in
order: the webhook is registered in the provider console; `PUBLIC_API_URL` exactly matches the
host the provider calls (Twilio signs the URL); the secret in the path matches; and for SES,
that `SES_CONFIGURATION_SET` is set — without it SES publishes no events at all.

### 4. Confirm certification advanced

```
GET /api/admin/notifications/readiness/certification
```

The channel should now be `LIVE_CERTIFIED` / `PASS`.

---

## SES bounce and complaint

**Use the AWS simulator mailboxes. Never send deliberately bad mail to a real address** — a
bounce against a stranger's mailbox is somebody else's spam complaint and your sending
reputation.

| Send to                             | Produces         |
| ----------------------------------- | ---------------- |
| `bounce@simulator.amazonses.com`    | permanent bounce |
| `complaint@simulator.amazonses.com` | complaint        |
| `success@simulator.amazonses.com`   | delivery         |

Expected afterwards:

- **Permanent bounce** → `status=BOUNCED`, and a `SuppressedDestination` row on `email` with
  `reason=HARD_BOUNCE`. `deliveredAt` **stays set** if a delivery arrived first — both
  happened, and both are recorded.
- **Complaint** → `status=COMPLAINED`, suppression with `reason=COMPLAINT`.
- **`costMicro` unchanged** on both. The provider carried it and charged for it; a total that
  shrinks as things go wrong is the opposite of useful.
- **A transient bounce creates no suppression.** A full mailbox is not a dead address.
- **Send the same SNS event twice** → the second is `duplicate`, nothing changes.

Then confirm the suppression works and is reversible:

```
GET  /api/admin/notifications/suppressions
POST /api/admin/notifications/suppressions/<id>/lift    (PLATFORM_CONFIG, audited)
```

---

## Out-of-order events (Meta WhatsApp)

WhatsApp routinely reports `read` before `delivered`. After both arrive:

- `status` = `READ`
- `deliveredAt` **and** `readAt` both set, and **different**
- A late `sent` afterwards changes nothing

---

## Reminders

Enable **only in QA**:

```bash
NOTIFICATION_REMINDERS_ENABLED=true
NOTIFICATION_REMINDER_LEAD_HOURS=24
```

| Case                              | Expected                                                                |
| --------------------------------- | ----------------------------------------------------------------------- |
| Confirmed booking, show in ~24h   | exactly one `EVENT_REMINDER`, on in-app/push/WhatsApp — **never email** |
| Same sweep run four times         | still one                                                               |
| Booking refunded after scheduling | none — eligibility is re-checked at fire time                           |
| Show cancelled                    | none                                                                    |
| Show 72h away                     | none                                                                    |

**Set `NOTIFICATION_REMINDERS_ENABLED=false` again afterwards.**

---

## WhatsApp opt-in

First with enforcement **off** (the launch default) — confirm grant → withdraw → grant leaves
three append-only `MarketingConsent` rows on `whatsapp:transactional`, newest winning.

Then in QA only, `WHATSAPP_TRANSACTIONAL_OPT_IN_REQUIRED=true`:

- opted in → WhatsApp selected
- not opted in → WhatsApp **removed**, email and push unaffected, the notification still goes

**Restore to `false`.**

---

## Provider outage

Point a provider at an unreachable host, or revoke a credential in QA, then:

| Action            | Must still succeed                                |
| ----------------- | ------------------------------------------------- |
| Confirm a booking | ✅ payment stays `SUCCEEDED`, booking `CONFIRMED` |
| Complete a refund | ✅ refund `COMPLETED`, credit note issued         |
| Cancel a show     | ✅ session `CANCELLED`, organizer gets a response |

The notification stays `PENDING` and retries. `outcomeClass` is `PROVIDER_UNAVAILABLE`, and
provider health shows _that provider_ degraded — not the platform.

**No notification outage may become a money-path outage.** This is the one test to re-run
before every release.

---

## Booking end-to-end

Book → pay → confirm, and check the `Notification` rows for that booking:

| Channel  | Expected              |
| -------- | --------------------- |
| email    | ✅                    |
| in_app   | ✅                    |
| push     | ✅                    |
| whatsapp | ✅                    |
| **sms**  | **❌ must be absent** |

Then cancel the show and check the same booking:

- Four `SHOW_CANCELLED` rows (email, in_app, push, whatsapp) — **no SMS immediately**
- After the fallback window with no delivery on any of them, **one** SMS
- Re-running the fan-out produces nothing further

Do not wait thirty real minutes. Age the rows, or call
`NotificationFallbackService.runDue(new Date(Date.now() + 31*60*1000))`.
