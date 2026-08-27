# Languages

ETicketsGo serves **English** and **Quebec French (`fr-CA`)**.

The obligation is Quebec's Charter of the French Language, which covers consumer commerce as
a whole — the storefront, the checkout, the invoice and the transactional email. A French
storefront with an English receipt is not partial compliance; it is the same exposure as no
French, plus the cost of having built half of it.

## Where the words live

One catalogue, in `packages/i18n/src/messages/<locale>/`:

| Namespace    | Read by | Covers                                             |
| ------------ | ------- | -------------------------------------------------- |
| `common`     | web     | Buttons, states, navigation, accessible names      |
| `storefront` | web     | Event page, seats, checkout, confirmation, account |
| `emails`     | **API** | Every transactional email and in-app notification  |
| `documents`  | **API** | Receipts, invoices, credit notes, ticket faces     |

Shared on purpose. The storefront and the receipt have to say the same thing, and two
catalogues diverge the first time somebody fixes a wording in one of them.

## What is done

| Surface                                                                          | Status                                          |
| -------------------------------------------------------------------------------- | ----------------------------------------------- |
| Site chrome — header, marketing nav, footer, bottom bar, city picker, switcher   | **French**                                      |
| Event page, ticket selection, free-event copy                                    | **French**                                      |
| Sign in and create account                                                       | **French**                                      |
| Checkout — review, discount code, payment states                                 | **French**                                      |
| Booking confirmation                                                             | **French**                                      |
| Ticket wallet and ticket detail                                                  | **French**                                      |
| Transactional email — all 19 notification types                                  | **French**                                      |
| Receipts, invoices, credit notes, incl. `<html lang>`                            | **French**                                      |
| Money, dates, plurals                                                            | **`fr-CA` conventions** — `123,45 $`, `25 août` |
| URLs, `hreflang`, sitemap alternates                                             | **Both locales**                                |
| Marketing body copy — About, Pricing, Features, Solutions, Customers, Docs, Blog | **English only**                                |
| Legal pages — Terms, Privacy, Refunds, Organizer Agreement                       | **English only**                                |
| Organizer and admin consoles                                                     | **English only, by design**                     |

### Why the consoles are out of scope

The Charter is about consumer commerce. The organizer console is a business tool sold to
businesses and the admin console is staff-only. Both are swept for accessibility; neither is
a consumer-facing commercial surface. If ETicketsGo later sells to Quebec organizers who
require a French console, that is a decision to make explicitly rather than a gap to fill by
default.

### The legal pages need a lawyer, not a translator

Terms, Privacy, the Refund Policy and the Organizer Agreement are contracts. Translating a
contract changes what it means, and under the Charter the French version of a consumer
contract is generally the one that governs. These are deliberately left in English until
somebody qualified produces the French — a machine translation of a refund policy is a worse
outcome than no French refund policy.

## Adding or changing a message

1. Add the key to `packages/i18n/src/messages/en/<namespace>.json`.
2. Add it to `fr-CA/` as well. **The build fails otherwise** — `catalogue.test.ts` checks that
   both locales carry the same keys with the same `{placeholders}`.
3. Read it with `useTranslations('namespace.path')` on the web, or `t(locale, 'path')` in the
   API.

A missing key is invisible in review: the runtime falls back to English and the page looks
finished. That is why it is a build failure rather than a lint warning.

## Rules that are easy to get wrong

**Every internal link must come from `@/i18n/navigation`.** `<Link href="/help">` from
`next/link` renders exactly that path, so on a French page it navigates to the English help
centre and silently puts the reader back into English. One such link in the shared chrome
undoes the feature.

**The middleware matcher's `\\.` is load-bearing.** Written as `\.` in the string it becomes
"any character", the exclusion swallows every path longer than one character, and every route
404s while looking exactly like a routing problem.

**`lang` follows the content, not the app.** It lives in `app/[locale]/layout.tsx` because the
language is only known once the locale segment resolves. French text under `lang="en"` is read
aloud by an English synthesiser and is genuinely unintelligible (WCAG 3.1.1).

**Language and clock are different questions.** A French reader wants "25 août"; a show in
Toronto still starts when it starts in Toronto. Conflating them is what once had a ticket and
its confirmation eleven and a half hours apart.

## Known divergence

`formatMinor` on receipts uses plain-`en` digit grouping; the email templates use `en-IN`.
They disagree, and they disagreed before French was added. Unifying them changes how money
reads on financial documents for every existing Indian customer, which is a product decision
rather than a side effect of this work. Both are commented with the reason.

## How this is kept honest

Two tests, and they catch different things.

`catalogue.test.ts` proves no message is **missing** from a locale. It cannot prove a page
actually reaches for one — a component with a hardcoded string passes it.

`french-no-english-left.spec.ts` reads each page on the transactional path and fails on any
line that is a known English string. That is what found the checkout, the wallet, the login
form and the whole mobile bottom bar still in English after the first round shipped.

Whole **lines**, never substrings: "Explorer" contains "Explore", and a substring check
reports correct French as untranslated. Add new strings to the word list as they appear.

## The French is a first draft

It was written to be correct and idiomatic Quebec French, and it is not a substitute for
review by a qualified translator — particularly for anything the OQLF would look at. The
strings are in JSON with no code around them precisely so a translator can work on them
directly.
