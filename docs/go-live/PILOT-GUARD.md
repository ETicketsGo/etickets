# Pilot sales guard

The first paid India pilot is limited in code, not by a runbook. This page lists the variables,
the values to use for the pilot, how to check them on production without changing anything, and
how to turn the guard off.

Code: `apps/api/src/pilot/` (`pilot-config.ts` holds the rules, `pilot-guard.service.ts` the sale
checks, `pilot-auto-pause.service.ts` the automatic pause).

## What it does

When `PILOT_MODE=on`, every sale is checked three times: at the quote, at booking create (guest
and signed in) and at payment start. A sale outside the limits is refused with the same answer
the storefront already shows for a show that is not open for online booking:

- HTTP 409, the buyer message "Online booking is not open for this show yet...",
- `details.reason = SALE_NOT_OPEN`,
- `details.blockers` = one or more of the codes below.

| Code                          | Meaning                                                                  |
| ----------------------------- | ------------------------------------------------------------------------ |
| `PILOT_MISCONFIGURED`         | Pilot mode is on but a variable cannot be read. Nothing is sellable.     |
| `PILOT_ORGANIZER_NOT_ALLOWED` | The event's organizer is not in `PILOT_ALLOWED_ORGANIZATION_IDS`.        |
| `PILOT_RESERVED_SEATING`      | The session has a room or a seat map, or it is a cinema show.            |
| `PILOT_CURRENCY`              | The order's currency is not in `PILOT_ALLOWED_CURRENCIES`.               |
| `PILOT_PROVIDER`              | The payment would not go to an allowed provider, or it is cash at venue. |
| `PILOT_ORDER_LIMIT`           | The order total is above `PILOT_MAX_ORDER_MINOR`.                        |
| `PILOT_DAILY_LIMIT`           | The order would take today's sales above `PILOT_MAX_DAILY_SALES_MINOR`.  |
| `PILOT_BUYER_NOT_ALLOWED`     | `PILOT_ALLOWED_BUYER_EMAILS` is set and this buyer is not on it.         |
| `PILOT_EVENT_NOT_ON_SALE`     | Payment start only: the event was paused after the tickets were held.    |

The quote and the booking give the same answer for the same cart. One exception: a quote does
not say who is buying, so the buyer allowlist is checked at booking create and at payment start.

### The daily cap

- The day is the Asia/Kolkata calendar day (00:00 to 24:00 India time, 18:30 to 18:30 UTC).
- It counts the pilot organizers' bookings created today in that currency that are CONFIRMED,
  PARTIALLY_REFUNDED or DISPUTED, plus PENDING_PAYMENT bookings whose hold has not expired. A
  partly refunded booking counts in full.
- A hold that expires stops counting at once, before the expiry sweep marks it EXPIRED.
- Booking create takes a Postgres advisory lock (`pg_advisory_xact_lock`) inside its own
  transaction before it counts, so two buyers at the same moment cannot both fit under the cap.
  Proven in `pilot-daily-cap.integration-postgres.spec.ts`: without the lock, eight buyers at
  once were all sold; with it, exactly one.
- The cap applies per currency (a rupee cap is never added to a dollar amount).

### The automatic pause

With `PILOT_AUTO_PAUSE` on (the default in pilot mode), the guard listens to the money-path ops
alerts and pauses events:

| Alert                                             | What is paused                      |
| ------------------------------------------------- | ----------------------------------- |
| Money captured for a booking that cannot take it  | That booking's event                |
| Confirmation failed after a successful payment    | That booking's event                |
| Expiry sweep found a capture it could not recover | That booking's event                |
| A finance discrepancy opened on a pilot payment   | That payment's event                |
| Webhook signature rejected N times in 10 minutes  | Every pilot event currently on sale |

A pause is the same change an admin pause makes: status PAUSED and `pausedByAdminAt` set, so the
organizer cannot resume it. Each pause writes an audit row (action `EVENT_AUTO_PAUSED`, no actor
user, `metadata.actor = system`, `metadata.reason` names the trigger) and sends one ops alert
(`PILOT_AUTO_PAUSED`) that lists the paused events. Only pilot organizers' events are paused.

Pausing never throws into the payment path: the guard runs on its own promise, and every error
is logged and swallowed. Bookings and payments that already exist are not changed.

To resume: fix the cause first, then Admin console > Events > set the event back to Published.

**About the webhook threshold.** The webhook URL is public. Anybody who can reach it can send a
delivery with a bad signature. With `PILOT_WEBHOOK_REJECT_PAUSE_THRESHOLD=1`, one such request
stops every pilot sale. The default of 3 in 10 minutes still lets a determined person stop sales,
but it does not let one stray request do it. A real broken secret produces a rejection for every
delivery, so it reaches 3 quickly.

## Variables

Set the same values on the **api** and the **worker** service. The worker runs the webhook
processor and the reconciliation, so it raises some of the alerts that pause events.

| Variable                               | Default    | Notes                                                        |
| -------------------------------------- | ---------- | ------------------------------------------------------------ |
| `PILOT_MODE`                           | off        | `on` or `off`. Anything else counts as on and misconfigured. |
| `PILOT_ALLOWED_ORGANIZATION_IDS`       | (none)     | Comma list of Organization ids. Empty = misconfigured.       |
| `PILOT_ALLOWED_CURRENCIES`             | `INR`      | Comma list.                                                  |
| `PILOT_ALLOWED_PROVIDERS`              | `razorpay` | Comma list of payment provider names.                        |
| `PILOT_GA_ONLY`                        | `true`     | `true` refuses reserved seating and every cinema show.       |
| `PILOT_MAX_ORDER_MINOR`                | (none)     | Paise, digits only. Required.                                |
| `PILOT_MAX_DAILY_SALES_MINOR`          | (none)     | Paise, digits only. Required.                                |
| `PILOT_ALLOWED_BUYER_EMAILS`           | (none)     | Optional comma list. When set, only these buyers.            |
| `PILOT_AUTO_PAUSE`                     | `on`       | `on` or `off`.                                               |
| `PILOT_WEBHOOK_REJECT_PAUSE_THRESHOLD` | `3`        | Rejections inside 10 minutes. 1 or more.                     |

Values are read once when the process starts. Changing one needs a restart (a Railway variable
change redeploys the service).

The provider check uses the same rule as payment start: an INR order goes to Razorpay when a
Razorpay key is configured; otherwise to `PAYMENT_PROVIDER_NAME`. With the default
`PILOT_ALLOWED_PROVIDERS=razorpay`, an environment without a Razorpay key sells nothing.

### Recommended pilot values

```
PILOT_MODE=on
PILOT_ALLOWED_ORGANIZATION_IDS=<the approved organization's id>
PILOT_ALLOWED_CURRENCIES=INR
PILOT_ALLOWED_PROVIDERS=razorpay
PILOT_GA_ONLY=true
PILOT_MAX_ORDER_MINOR=200000          # Rs 2,000
PILOT_MAX_DAILY_SALES_MINOR=2500000   # Rs 25,000
PILOT_AUTO_PAUSE=on
PILOT_WEBHOOK_REJECT_PAUSE_THRESHOLD=3
```

For the owner's own live verification payment, add `PILOT_ALLOWED_BUYER_EMAILS=<owner address>`
before the event is put on sale, and remove it (restart) when the verification is done. When the
buyer is signed in, both the address typed at checkout and the account's address must be listed.

## How to verify on production (read-only)

None of these steps changes data.

1. **Boot log.** After the deploy, the api and worker logs show one line:
   `Pilot mode is ON: 1 organizer(s), INR via razorpay, order cap 200000, daily cap 2500000,
auto-pause on.` A misconfigured guard logs `Pilot mode is ON but misconfigured, so nothing
can be sold:` with the reason instead.
2. **Admin > Operations.** The "Controlled pilot" card shows the mode, the limits, today's
   counted sales against the cap and the last automatic pause. It shows how many buyer addresses
   are allowed, never the addresses.
3. **A quote over the order cap.** `POST /api/bookings/quote` is public and writes nothing. Quote
   a pilot session with enough tickets to pass Rs 2,000: the answer is 409 with
   `blockers: ["PILOT_ORDER_LIMIT"]`. Quote one ticket: the price comes back.
4. **A quote for another organizer's session** answers `PILOT_ORGANIZER_NOT_ALLOWED`.

Do not create a booking to test the guard on production. A hold counts against the daily cap
until it expires.

## How to turn it off

Remove `PILOT_MODE` (or set `PILOT_MODE=off`) on the api and the worker and let them redeploy.
Sales then follow the normal rules exactly as before the guard existed. The other `PILOT_*`
variables are ignored while pilot mode is off and can stay in place.

To keep the limits but stop the automatic pause, set `PILOT_AUTO_PAUSE=off`.

Events that were paused automatically stay paused when the guard is turned off. Resume them in
Admin console > Events.
