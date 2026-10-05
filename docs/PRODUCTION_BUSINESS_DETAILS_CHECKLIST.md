# Production business details checklist

Everything the storefront needs from the business before it can honestly take money, and what
can wait. Nothing here is invented — every unset field is shown as unset.

Audited at `main = c77a9cd` against `packages/web-kit/src/business-details.ts`, the four legal
pages and the pricing surfaces.

---

## How this is wired

Every contact fact lives in one file, `packages/web-kit/src/business-details.ts`, with every
field `null` until published. Two behaviours follow from that and are worth knowing before you
fill anything in:

- **A surface renders only what is set.** An unset support address means the card is not shown,
  not that a placeholder appears.
- **`publishedDetail()` refuses a value that cannot work.** Anything matching a reserved domain
  (`.example`, `.test`, `.invalid`, `localhost`), a placeholder phone shape, or the word
  "placeholder" is treated as unset **even if it is committed**. The guard is in the render
  path, not only in a test.

So putting a plausible-but-wrong value in is worse than leaving it null, and putting a
deliberately fake one in will not display at all.

The "not published yet" notice is derived from these fields. It disappears on its own once they
are filled — and, more importantly, cannot be deleted while they are empty.

---

## MUST HAVE BEFORE FIRST SALE

| Field                                  | Where it shows                                                                               | Status                                                                                                               | Who decides                                      |
| -------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `legalName`                            | receipts, `/terms` operator clause, who the customer paid                                    | **null**                                                                                                             | You — the registered entity that takes the money |
| `supportEmail`                         | `/contact` cards and facts, `/terms` contact clause, the error path on a failed contact form | **null**                                                                                                             | You                                              |
| **Operating legal entity on `/terms`** | `/terms`                                                                                     | **unpublished** — reads "the operating legal entity is not published here yet"                                       | You + counsel                                    |
| **Terms of service**                   | `/terms`                                                                                     | **draft** — the page says it "is not yet legally binding… must be reviewed and finalized by qualified legal counsel" | Counsel                                          |
| **Privacy policy**                     | `/privacy`                                                                                   | **draft** — "Retention periods and data-subject rights mechanics require privacy/legal counsel"                      | Counsel                                          |
| **Refund / cancellation policy**       | `/refunds`                                                                                   | **draft** — "We have not decided whether fees are refundable, or how cancellations work"                             | You + counsel                                    |
| **Pricing figures**                    | `/pricing`, the landing preview, the FAQ                                                     | **declared placeholders** — "The figures below are placeholders"                                                     | You                                              |

Why each is a _before first sale_ item:

- A customer must be able to tell **who they paid** and **how to reach them** when a payment
  goes wrong. Those are `legalName` and `supportEmail`, and no amount of good engineering
  substitutes for them.
- The storefront currently **tells visitors it is not finished**, and a Razorpay-facing site
  that describes itself that way is also a payment-provider review risk.
- The **refund policy is the one customers will quote back at you.** It is a promise, and ours
  currently says we have not decided. Taking money against an undecided refund policy is the
  item on this list I would least want to launch with.
- **Pricing** is quoted to organizers as a placeholder. An organizer who signs up on a
  placeholder fee has a reasonable complaint.

## CAN FOLLOW DURING PILOT

| Field                              | Where it shows                                      | Status                                                   | Who decides                                               |
| ---------------------------------- | --------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------- |
| `supportPhone`                     | `/contact` facts row                                | **null**                                                 | You                                                       |
| `postalAddress`                    | `/contact` facts row                                | **null**                                                 | You — a registered office; a city alone is not an address |
| `supportHours`                     | `/contact` facts row                                | **null**                                                 | You                                                       |
| `organizerEmail`                   | organizer console → Help → "Contact support" button | **null**                                                 | You                                                       |
| `salesEmail`                       | `/contact` Sales card                               | **null**                                                 | You                                                       |
| `partnershipsEmail`                | `/contact` Partnerships card                        | **null**                                                 | You                                                       |
| `mediaEmail`                       | `/contact` Media card                               | **null**                                                 | You                                                       |
| **Organizer agreement**            | `/organizer-agreement`                              | **draft** — "Payout schedule, tax…"                      | Counsel                                                   |
| **GST / tax identity on invoices** | receipts, tax invoices                              | **unset** — see `INDIA_GST_BUSINESS_DECISIONS.md` Q3, Q7 | Accountant                                                |

These can follow because a working channel already exists without them: **the contact form
posts to `POST /support`**, which is public, persisted and visible in the admin support inbox.
A buyer can reach you today even with every address above unset. A phone number and a postal
address are things a customer expects to see, not things that block the first sale.

`organizerEmail` is borderline. Organizers are the people whose money passes through us, and
their "Contact support" button is hidden while it is null — the Help page says so and points
them at Send feedback, which does reach the same inbox. Acceptable for a pilot with a handful
of known organizers; not acceptable at scale.

---

## What is deliberately NOT on this list

- A **cookie policy** page. There is none, and I have not assumed one is required.
- **Marketing copy and testimonials.** The fabricated testimonials were removed rather than
  rewritten; fake social proof has no honest replacement. If you want real quotes, they need
  real customers first.
- A **buyer GSTIN field.** Not collected anywhere. If corporate buyers need an input credit
  that is a schema change, not a value to fill in.

---

## Filling it in

One file, one edit per field:

```ts
// packages/web-kit/src/business-details.ts
export const BUSINESS_DETAILS: BusinessDetails = {
  legalName: 'DeepTrics Software Solutions …',   // <- the registered name, exactly
  supportEmail: 'help@eticketsgo.com',           // <- a mailbox somebody reads
  …
};
```

`apps/api/src/ops/…` does not need touching, and no environment variable is involved — these
are build-time facts in the web bundle, so **the web apps need rebuilding and redeploying** for
a change to show. The legal pages are React components under
`apps/customer-web/app/[locale]/{terms,privacy,refunds,organizer-agreement}` and are edited as
content, with their draft notices removed only when counsel has signed off.

A test asserts the shipped file contains no undeliverable value, so a `.example` address cannot
be committed by accident.
