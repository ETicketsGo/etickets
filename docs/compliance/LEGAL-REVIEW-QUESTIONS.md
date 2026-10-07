# Questions for legal counsel before broad launch

Specific questions the engineering work could not answer, with what the platform does today
while they are open. Each one is a place where a wrong guess would put a false statement on a
public legal page, so the code states the narrower, defensible thing instead.

---

## 1. Which entity contracts with a buyer, and in which markets?

**The question.** Two entities exist: **DeepTrics LLC** (United States) and **Deeptrics
Software Solution Pvt Ltd** (India). When a customer in India buys a ticket for an event in
India, which entity is the counterparty to that sale? And does the answer depend on the
buyer's country, the event's country, the organizer's country, or the entity that receives the
money?

**Why it matters.** The Terms name who the customer is contracting with. The Privacy Policy
names the data controller. GST registration, invoicing and refunds all follow the entity that
took the money. These are not necessarily the same answer, and "the buyer is in India, so it
must be the Indian company" is an assumption, not a fact.

**What the pages say today.** Only what is established: _"ETicketsGo is operated by DeepTrics
LLC."_ No page claims a per-country contracting entity.

**History, so this is not re-litigated.** An earlier version DID resolve an operating entity
from the reader's market, so an Indian reader was told their contract was with the Indian
company. Nothing in this project established that. It was removed rather than kept "pending
review", because an unreviewed legal assertion on a live page is worse than a narrower true
one.

**Still available for the answer.** `legalEntityFor(country)` and `LEGAL_ENTITIES` in
`packages/shared-types/src/legal.ts` already hold both entities and resolve by market. Nothing
public calls `legalEntityFor` any more. If counsel confirms a per-market counterparty, wiring
it back is a small change to one component.

**Needed from counsel:** the contracting entity per market, and the determining factor (buyer
country / event country / receiving entity).

---

## 2. Is the India market's GST position stated correctly?

**The question.** The India supplement says prices are shown inclusive of GST, that receipts
itemise tax on the ticket and on each fee, and that state ticket-price ceilings are applied
where they exist. Is that an accurate and sufficient statement of the platform's obligations?

**What the platform does.** Exactly that, and the tax engine holds no rates of its own — rate
bands are configuration. Whether the DISCLOSURE is adequate is the legal question, not whether
the behaviour matches it.

---

## 3. Is the Canada supplement's consent statement sufficient for CASL?

**The question.** The Canada supplement says commercial messages are sent only with agreement,
and that a record of when and how consent was given is kept and can be withdrawn.

**What the platform does.** `MarketingConsent` is append-only and records subject, channel,
decision, source, market, the exact disclosure version, the verified number for messaging
channels, and timestamp. Withdrawal is a new row, never an edit.

**Needed from counsel:** whether the retention and the express/implied distinction are
adequately described.

---

## 4. Do the documents need a governing-law and dispute-resolution clause?

**The question.** The Terms do not state a governing law or a dispute forum. Deliberate: it
depends on answer 1, and choosing one without counsel would be the same mistake.

---

## 5. Refund policy against the implemented behaviour

The public Refund Policy describes behaviour the platform actually implements — the organizer
sets the window, a cancelled show refunds in full including fees, and the buyer's own
cancellation returns the ticket and its tax but not the fees. Confirm the _policy_ is
acceptable; the implementation matches what is written.

---

## Documents to review

`/terms`, `/privacy`, `/sms`, `/cookies`, `/refunds`, `/organizer-agreement` on
`https://www.eticketsgo.com` — each in its US, India, Canada and all-other-countries version
(`?country=US|IN|CA|GLOBAL`).
