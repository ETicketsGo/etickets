# Go-live register

Everything still standing between the platform and taking real money in **India**, the
**United States** and **Canada**.

The organising idea: each row says who owns it, and whether the engineering is done. Where
engineering is done, the row names the **exact variable** to set, so buying a licence and
turning the thing on is a dashboard change and not a development cycle. Where a decision is
yours, the platform is deliberately inert until you make it — no default guesses at tax,
pricing display, or consent.

> **What this document does not do.** It does not tell you what tax you owe, what your
> privacy notice must say, or which provinces need a separate registration. Those belong to
> your advisor and your counsel. It tells you what the platform will do once you have their
> answer, and what it refuses to do without one.

---

## 1. Blocking — production cannot serve customers until these are done

| #   | Item                                      | Owner     | State                             |
| --- | ----------------------------------------- | --------- | --------------------------------- |
| 1   | Managed secret store provisioned          | You + Eng | **Code done, needs provisioning** |
| 2   | Email provider live and domain verified   | You       | **Code done, needs an account**   |
| 3   | Payment credentials and webhook endpoints | You       | Code done, needs live keys        |
| 4   | Sentry project                            | You       | Code done, needs a DSN            |

### 1.1 Managed secret store

The API **refuses to boot** in staging or production with the environment-variable secret
backend. This is deliberate and it is the same wall UAT hit: live credentials come from a
managed store, never from a dashboard variable that anyone with project access can read.

Adapters for all three clouds already exist. Pick one, provision it, set:

```
SECRET_MANAGER_PROVIDER=azure          # azure | aws | gcp — `env` is refused
AZURE_KEY_VAULT_URL=https://….vault.azure.net/     # if azure
# AWS_SECRETS_REGION=ap-south-1                    # if aws
# GCP_PROJECT_ID=…                                 # if gcp
```

The rule follows **whether a live credential could exist**, not the environment's name — so
UAT, which is forbidden from holding live keys, is not required to guard them.

### 1.2 Email — the failure that looks like nothing is wrong

`EMAIL_PROVIDER` defaults to `log`, which writes to the service log and **sends nothing**.
Left on in production, the platform boots clean, reports healthy, takes the money, and the
customer never receives their ticket — while the log records a line that reads like success.
It is invisible to every health check and every test. The only party who finds out is the
person who paid.

So the API now **refuses to boot** in staging or production on the log transport.

```
EMAIL_PROVIDER=ses                     # sendgrid | ses — `log` is refused
EMAIL_FROM=noreply@eticketsgo.com      # on a verified, SPF/DKIM-signed domain
AWS_REGION=…                           # if ses
# SENDGRID_API_KEY=…                   # if sendgrid
# ALLOW_UNDELIVERABLE_NOTIFICATIONS=true   # migrations/smoke checks ONLY
```

**Your checklist, because the process cannot verify it:**

- The sending domain is verified with SPF and DKIM, and DMARC exists.
- **If SES: the account is out of the sandbox.** In the sandbox SES only delivers to
  verified addresses, and the failure looks _exactly_ like "the customer never got their
  ticket". Request production access early — approval is not instant.
- Bounce and complaint destinations are monitored by a person.

QA and UAT stay on `log` on purpose. Their bookings are test bookings, and mailing real
inboxes is the failure there, not the fix. (The guard keys on `APP_ENV`, not `NODE_ENV` —
both those environments run production builds.)

### 1.3 Push

`PUSH_PROVIDER` costs nothing to switch on. The Expo transport ships in **PR #51**, which is
open and blocked on GitHub Actions billing — nothing to do here until that merges.

---

## 2. Tax — buy it, do not build it

**Nothing in this codebase asserts a tax rate, a threshold, or a jurisdiction rule.** Tax
rules default to inactive, so an unconfigured platform charges no tax and every total is
what it was before tax existed. That is the only safe default when the alternative is
silently over- or under-charging a real customer.

Two sources, one seam:

| Mode       | Use when                                                                                                | Set                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `manual`   | One jurisdiction, one stable rate your advisor can state. **This is the India pilot.**                  | `TAX_PROVIDER=manual`, then activate a `TaxRule` row          |
| `external` | The rate depends on the buyer's city, or whether you owe anything depends on nexus. **This is the US.** | `TAX_PROVIDER=external` + the four `TAX_EXTERNAL_*` variables |

```
TAX_PROVIDER=manual                    # manual | external
# TAX_EXTERNAL_VENDOR=stripe-tax       # label for the audit trail
# TAX_EXTERNAL_ENDPOINT=https://…/quote
# TAX_EXTERNAL_API_KEY=…               # boot FAILS without it
# TAX_EXTERNAL_TIMEOUT_MS=4000         # bounded: this call sits in checkout
# TAX_EXTERNAL_FAIL_OPEN=false         # see below
```

The external provider is a working, vendor-neutral HTTP adapter and a deliberate
**placeholder**: it speaks one small JSON contract and expects a thin translation layer in
front of Stripe Tax, Avalara or TaxJar. Writing one of those clients before you have chosen
would mean guessing at three APIs and shipping two dead. What it already gives you is
everything that must be right regardless of vendor — the bounded timeout, the refusal to
guess at a malformed response, and the fail-closed behaviour.

**Fail-closed by default.** If the tax service is unreachable the sale is refused, because
charging no tax under-collects on every order for the duration of the outage and the
platform — not the customer — owes the difference. `TAX_EXTERNAL_FAIL_OPEN=true` trades that
for a working checkout with zero tax and a reconciliation job afterwards. Your call.

**Owner decisions**, per market:

- **India** — what is charged on the ticket, and on the convenience fee, and how it must be
  shown. Then activate a `TaxRule`.
- **US** — choose a tax service; register where you have economic nexus.
- **Canada** — GST/HST federally, provincial taxes in several provinces, and a distinct
  Quebec regime that can require its own registration.

---

## 3. All-in pricing — one setting, applied everywhere

Several US states, and federal rules, now require the total including mandatory fees to be
shown **upfront**: the number a buyer sees while _deciding_, not the breakdown after they
have decided. Itemising correctly at checkout while advertising a bare ticket price on the
browse page complies with nothing.

```
PRICE_DISPLAY_MODE=itemised            # itemised | all_in
```

`all_in` applies to **every** listing surface at once — browse, organizer page, movie
showtimes, recommendation carousels — so two surfaces can never quote different prices for
the same ticket. Fees the organizer absorbs are excluded, because they are not charges to
the buyer. Tax is never included: it depends on the buyer's location, which is unknown while
they browse.

**Owner decision:** confirm what your markets require. Getting this wrong changes the price
a listing must advertise, not just a checkout screen.

---

## 4. Consent and privacy

The transactional/commercial distinction is now **real in the product**, not just in intent:

- A **transactional** message — a ticket, a refund confirmation, a cancellation — is sent
  regardless of marketing preferences, and never consults the consent store at all.
  Suppressing a ticket because somebody unticked a marketing box is a product failure
  wearing a legal precaution as a disguise.
- A **commercial** message requires an affirmative, per-channel consent record. **No record
  means no.** Read the other way, the first promotional message ever added would mail
  everyone who ever bought a ticket.

Consent is an append-only log with a source, a timestamp, and the request's IP and user
agent. A withdrawal is a new row, never an edit — a boolean answers "subscribed now" and
destroys the evidence that consent was ever given, which is the one thing a regulator asks
to see. It is keyed on email as well as account, so a guest who withdrew is not
re-subscribed by registering.

Reachable at `GET`/`PUT /api/me/marketing-consent`. The `GET` returns the full history,
which is most of what a data-subject access request asks for.

Every message type the platform sends today is transactional, so this guards a door nobody
is walking through yet. It exists now because the alternative is adding the first marketing
message and the consent system in the same change, under launch pressure.

**Owner decisions:**

- **India — DPDP.** Consent, notice, and possibly where personal data may be stored. Settle
  this _before_ choosing a production region: it can constrain the choice.
- **Canada — CASL and Quebec.** Stricter than most about commercial email specifically. The
  product distinction above is the mechanism; the notice wording is your counsel's.
- **Payout reporting.** Paying organizers brings information-reporting obligations. Stripe
  Connect can carry much of it depending on how accounts are structured — a decision to make
  deliberately with your accountant, not to inherit from a default.

---

## 5. Canada — the two remaining gaps

| Item                       | Owner     | State                                     |
| -------------------------- | --------- | ----------------------------------------- |
| Explicit CAD payment route | Eng       | **Done**                                  |
| French (Quebec)            | Eng + You | **Not started — the largest single item** |

**CAD routing is done.** USD and CAD now have explicit routes rather than reaching Stripe
through the catch-all. That previously worked by accident: nothing recorded that we meant to
sell in those currencies, and nothing would have failed if the fallback provider had stopped
serving one. A test proves each launch currency resolves on its own row, with the wildcard
rows removed.

**French is not started, and it is why Canada is further away than the other two markets.**
Quebec's language law requires French for consumer-facing commerce: the storefront, checkout,
receipts, tickets and transactional email. The notification template registry has exactly one
locale (`en`) and there is no internationalisation layer in any of the three web apps.

This is an i18n layer plus translation — a project, not a setting. It is **deliberately not
half-built here**: a partial i18n layer that covers the storefront but not the receipt is not
a step toward compliance, and it makes the remaining work harder to scope. Sequence it
explicitly after the India pilot.

---

## 6. Known gaps, stated plainly

These are **not done**, and none of them is disguised as done.

### Accessibility

There is real groundwork: axe scans in the e2e suite, keyboard-reachable seat maps, status
conveyed by word and not colour alone. There is **no formal audit and no VPAT**, and the axe
coverage is spot rather than site-wide. A public ticketing site is a place of public
accommodation and a frequent target of claims. This needs a third-party audit; the existing
scans reduce the number of findings it will return, they do not substitute for it.

### Mobile — Expo SDK 57

A Hermes memory regression affects the current SDK and the only remedy is a major Expo and
React Native upgrade. **This has not been attempted, on purpose.** It must be verified on a
physical Android device, and both mobile defects found last week were invisible to the web
export and to every unit test. Shipping an unverified major upgrade of the runtime would be
the same mistake with a bigger blast radius.

### What the platform will not verify for you

Domain verification, SES sandbox status, and merchant-account approval cannot be read from
inside the process. A check that guessed at them would be worse than none, because a green
check is trusted. They are on your checklist above instead.

---

## 7. Variable summary

New in this change:

| Variable                            | Default    | Effect                                                              |
| ----------------------------------- | ---------- | ------------------------------------------------------------------- |
| `ALLOW_UNDELIVERABLE_NOTIFICATIONS` | `false`    | Disarms the mail guard. Migrations and smoke checks only.           |
| `TAX_PROVIDER`                      | `manual`   | `manual` \| `external`. An unknown value is refused, not defaulted. |
| `TAX_EXTERNAL_VENDOR`               | —          | Label recorded on the booking's audit trail.                        |
| `TAX_EXTERNAL_ENDPOINT`             | —          | Required when `external`. Boot fails without it.                    |
| `TAX_EXTERNAL_API_KEY`              | —          | Required when `external`. Boot fails without it.                    |
| `TAX_EXTERNAL_TIMEOUT_MS`           | `4000`     | Bounded — this call is in the checkout path.                        |
| `TAX_EXTERNAL_FAIL_OPEN`            | `false`    | `true` = proceed with zero tax during an outage.                    |
| `PRICE_DISPLAY_MODE`                | `itemised` | `all_in` includes mandatory fees in advertised prices.              |

Already present, listed because they are go-live gates:

| Variable                  | Gate                                                    |
| ------------------------- | ------------------------------------------------------- |
| `SECRET_MANAGER_PROVIDER` | Must not be `env` in staging or production. Boot fails. |
| `EMAIL_PROVIDER`          | Must not be `log` in staging or production. Boot fails. |
| `EMAIL_FROM`              | Required with a real provider. Boot fails.              |
| `PAYMENT_LIVE_ENABLED`    | Ships `false`. Flip at go-live, deliberately.           |
| `PUSH_PROVIDER`           | Costs nothing; needs PR #51.                            |
| `SENTRY_DSN`              | Required at go-live.                                    |

---

## 8. Ordering

1. **Now** — provision the secret store and the mail provider. Both are boot gates; nothing
   else can be tested end to end until they exist.
2. **Now** — get your advisor's answer for India, activate one `TaxRule`, and confirm the
   pricing-display requirement.
3. **Before the US** — choose a tax service, register where you have nexus, point
   `TAX_PROVIDER=external` at your adapter.
4. **Before Canada** — scope the i18n project. Everything else Canadian is either done
   (CAD routing) or the same shape as the other markets (tax).
5. **Before either store submission** — the Expo SDK upgrade, verified on a physical device.
6. **In parallel, on its own clock** — the accessibility audit. It has a lead time and it
   will produce work.
