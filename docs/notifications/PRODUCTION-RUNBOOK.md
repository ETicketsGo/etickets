# Production runbook — notifications

For whoever is holding the pager. Every command here is an admin API call; nothing requires
database access, and **nothing here involves editing the database by hand.**

Two facts to hold on to before anything else:

1. **A notification outage is not a money outage.** Nothing in the payment, booking or refund
   path sends a message inline. If notifications are entirely down, people can still buy,
   still get refunded, and still see their tickets in the app. Escalate accordingly.
2. **Delivery is at-least-once.** Our own dedupe key stops us creating the same intent twice.
   It cannot stop a provider delivering a message twice after a timeout it saw and we didn't.
   A customer reporting two identical emails is behaving as designed — see ADR-046.

---

## The five things to look at

```
GET /api/admin/notifications/health?hours=1        # per-provider failure rate
GET /api/admin/notifications?status=FAILED&limit=50
GET /api/admin/notifications/suppressions
GET /api/admin/notifications/<id>                  # every attempt on one notification
GET /api/admin/notifications/readiness/certification
```

`OPS_READ` for all of them. The two mutating routes — resend and lift — need `PLATFORM_CONFIG`
and are audited with the actor.

---

## How delivery actually behaves

Worth knowing before diagnosing anything:

|                          |                                                                    |
| ------------------------ | ------------------------------------------------------------------ |
| Dispatch sweep           | every **5s** (`NOTIFICATION_SWEEP_INTERVAL_MS`), 500 rows per tick |
| Attempts                 | **3**, then `FAILED`                                               |
| Backoff between attempts | **none** — the next sweep retries                                  |
| Fallback sweep           | every 60s                                                          |
| Reminder sweep           | every 5 min                                                        |

**Three attempts at five-second intervals means an outage exhausts a notification's retries in
about fifteen seconds.** They do not wait the outage out. This is deliberate — a message that
sat in a queue for an hour is often worse than one that failed visibly — but it means the
recovery step after any outage is a **resend**, not patience.

A provider that refuses _permanently_ (no DLT template, no route to the destination) goes
straight to `FAILED` without burning retries. Retrying it would be refused for the same reason.

---

## Symptom → cause

### "Nothing is being delivered at all"

Check the worker first, not the providers. `dispatch-notifications` is the only thing that
talks to a provider; if the worker is down, every row sits `PENDING` with `attempts = 0` and
no failures are recorded anywhere. **A quiet health endpoint and a growing `PENDING` count is
a worker problem.** Once it comes back the backlog drains on its own — `dispatchDue` acts on
whatever is still pending and past due.

### "Sends succeed but nothing is ever marked delivered"

The classic. Sends are `ACCEPTED` with a `providerMessageId`, and `deliveredAt` stays null
forever. The send side is healthy; **the callback never arrives.** In order:

| Check                                                                           | Why                                                                           |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **SES**: `SES_CONFIGURATION_SET` set, and that set has an SNS event destination | without it SES publishes nothing, silently                                    |
| **SES**: the subscription reads _Confirmed_, not _PendingConfirmation_          | we verify but deliberately never auto-confirm                                 |
| **Twilio**: `PUBLIC_API_URL` exactly matches the URL Twilio calls               | it signs the URL; a mismatch looks identical to an attack                     |
| **Meta**: the `messages` field is still subscribed                              | the `WHATSAPP_VERIFY_TOKEN` challenge must have passed for it to exist at all |
| **MSG91**: the DLR URL is registered, with the current secret                   | rotating the secret without updating the dashboard silently ends callbacks    |
| **Push**                                                                        | expected — push has no delivery callback anywhere. `ACCEPTED` is terminal.    |

### "One provider is failing"

`GET /api/admin/notifications/health?hours=1` reports per provider, so this is visible without
guessing. `outcomeClass` says what kind of failure:

| `outcomeClass`         | Means                                 | Do                                                                |
| ---------------------- | ------------------------------------- | ----------------------------------------------------------------- |
| `PROVIDER_UNAVAILABLE` | we couldn't reach them, or they 5xx'd | their status page; resend after                                   |
| `PROVIDER_REJECTED`    | they answered, and said no            | read `failureReason` — usually credentials, template or geography |
| `RECIPIENT_INVALID`    | the destination is wrong              | not an incident; nothing to retry                                 |
| `SUPPRESSED`           | we blocked it ourselves               | see below                                                         |
| `PROVIDER_ACCEPTED`    | fine                                  | —                                                                 |

A single degraded provider does **not** degrade the others. Nothing routes around it
automatically: SMS in India is MSG91 and stays MSG91. Changing market routing is a config
change and a deploy, not a runbook step, and it should be a deliberate decision.

### "High bounce rate"

Two very different things wearing the same word:

- **Permanent** (`HARD_BOUNCE`) — the address does not exist. Suppressed automatically and
  correctly. A _spike_ means something upstream is generating bad addresses; look at signup,
  not at email.
- **Transient** — full mailbox, greylisting. Creates no suppression, by design.

**A complaint spike is more serious than a bounce spike.** Complaints are people marking us as
spam; enough of them and SES throttles or suspends the account, at which point nobody gets
their tickets. If complaints climb, find out what was sent and to whom before touching
anything else.

### "A customer says they get nothing"

```
GET /api/admin/notifications?reference=<booking ref>
```

Walk it down, in this order:

1. **Is there a notification row at all?** If not, the producer never ran — that is a booking
   or show problem, not a delivery one.
2. **Is the destination suppressed?** `GET /api/admin/notifications/suppressions` — addresses
   are masked. A hard bounce months ago silently blocks everything since.
3. **Did the policy select that channel?** Not every type goes everywhere. SMS is
   `SHOW_CANCELLED` only, and only as a fallback.
4. **Did they turn it off?** Preferences never suppress a critical type, but they do suppress
   the rest.
5. **Read the attempts** — `GET /api/admin/notifications/<id>` shows every attempt with its
   provider, reference and failure reason.

---

## Actions

### Resend one notification

```
POST /api/admin/notifications/<id>/resend        (PLATFORM_CONFIG, audited)
{ "force": false }
```

The **same** notification is requeued — the dedupe key is untouched, so this is not a route
around the once-per-intent guarantee; it opens a new _attempt_ on the same intent. It is
recorded as `MANUAL_RESEND` so the cost is attributable to support rather than buried in
ordinary traffic.

It refuses, deliberately, when the destination is **suppressed** (lift it first, on purpose),
and when the last attempt was `DELIVERED` or otherwise terminal — `force: true` overrides the
second, never the first.

**`attempts` is not reset.** A notification that already burned its three attempts gets one
attempt per resend. That is usually what you want; it also means resending into a still-broken
provider fails immediately rather than churning.

### Recovering a batch after an outage

There is **no bulk resend endpoint.** Recovery today is per-notification: search
`status=FAILED` over the outage window, then one resend each. For a handful, fine. For
thousands this is a real gap, and it is written down as one rather than papered over — see the
P6 backlog.

Before resending in bulk, ask whether the message is still true. A 24-hour reminder resent 26
hours later is worse than not sending it.

### Lift a suppression

```
GET  /api/admin/notifications/suppressions?channel=email&reason=HARD_BOUNCE
POST /api/admin/notifications/suppressions/<id>/lift    (PLATFORM_CONFIG, audited)
```

The record is **kept, not deleted** — the history of why a destination was blocked survives
the unblocking. Lift a `HARD_BOUNCE` only when you have reason to believe the address now
exists (the customer corrected it). Lifting a `COMPLAINT` means sending to somebody who marked
us as spam; that needs a better reason than a support ticket.

### Update a rate

```
GET  /api/admin/notifications/analytics/rates
POST /api/admin/notifications/analytics/rates/<id>/supersede    (PLATFORM_CONFIG)
```

Rates are **superseded, never edited.** Historical cost stays priced at the rate that was
actually in force, so last month's report does not silently change when a contract does.

`unitPriceMicro` is millionths of a currency unit, integer. A missing rate records
`costSource: UNKNOWN` — visible as unknown, never as zero. Zero is a claim, and it should only
be made where it is true (`CONFIGURED_FREE`).

---

## Escalation

| Situation                                                       | Severity                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------ |
| One channel degraded, others fine                               | low — visible, self-describing, resend later                       |
| All channels down (worker)                                      | medium — nothing lost, everything delayed; money path unaffected   |
| SES complaint rate climbing                                     | **high** — a suspended sending domain stops every ticket email     |
| Cancellation fan-out not running                                | **high** — people turn up to a cancelled show                      |
| Anything in the payment path failing "because of notifications" | **treat as a bug in the claim.** Nothing sends inline. Look again. |

---

## What not to do

- **Do not edit the database to make readiness green.** Certification reads delivery evidence
  precisely so that it cannot be talked into a pass.
- **Do not disable signature verification to get a webhook working.** An unverified webhook
  endpoint can suppress a destination, which is a way to stop somebody receiving their tickets.
- **Do not auto-confirm SNS subscriptions.** The endpoint verifies and deliberately does not
  confirm; an endpoint that confirms whatever it is offered attaches itself to any topic
  anyone points at it.
- **Do not resend into a provider you have not confirmed is healthy.** Attempts are not free,
  and they are not reset.
