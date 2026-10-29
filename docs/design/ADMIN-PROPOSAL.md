# Admin console proposal (PROPOSAL - do not merge)

Status: a proposal for the owner, October 2026. Built in the approved "desk" system
([DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md)); answers the admin findings A1-A5 in
[EXPERIENCE-AUDIT.md](./EXPERIENCE-AUDIT.md). The prototype runs beside the live console at
`/proposal` (admin-web), on live data and existing endpoints only: no API, payment, finance,
schema or permission change. The live console at `/admin` is untouched.

## Principles

Admin is the desk at its most precise: calm, trustworthy, operations first.

1. **Work before measurements.** The first screen answers "what is waiting on a person, and for
   how long". Figures are for information, below, and say so.
2. **Every number says what it counts, its window and its currency.** "Failed payments, last 7
   UTC days, all markets", never "Payment failures".
3. **Never sum currencies.** Money is grouped per currency everywhere; a row with no currency is
   its own group, never folded into the biggest market.
4. **Freshness is shown.** Every screen says "As of 11:28, your time" with a refresh. A count that
   could not be read says so; it is never shown as zero.
5. **Colour is state only.** Ink and paper; status colour only for critical / caution / positive /
   info, always with words; marigold only for "you are here".
6. **One decision per row, reasons in writing.** A rejection, a resolution or an ignore needs a
   reason the API already stores.

## Information architecture

Nine groups (four of them one page each) become six, named by the question:

| Group     | Pages (queue first)                                                   |
| --------- | --------------------------------------------------------------------- |
| Today     | Overview                                                              |
| Review    | Event approvals, Organizer approvals, Calendar, Movies                |
| Customers | Support inbox, Booking lookup, Refund desk, Chargebacks, Accounts     |
| Money     | Reconciliation, Payments, Payouts, Settlements, Reports               |
| Platform  | Health and jobs, Fees tax and pricing (one page, tabs), Payment setup |
| Access    | Staff and security, Audit log, My sign-in                             |

Capabilities per link are unchanged (`lib/proposal-nav.ts` reuses `admin-nav.ts`'s), so nobody is
offered a page their duties cannot open. Staff permissions move out of "Platform configuration"
into Access, next to the audit log and MFA.

## Screens (prototype)

- **Overview** (`/proposal`): "Waiting on a decision" is one ruled list, not tiles: count, queue,
  what delay costs, age of the oldest item (red from 3 days), state in words. Empty queues fold to
  one "Clear" line. "Does the money agree?" shows unresolved reconciliation exceptions per currency
  (count, amount in question, oldest) and open chargebacks at risk per currency. "Where we sell"
  is per market, since launch, labelled information. The greeting card, the eight-colour "Go to"
  panel and the ten stat tiles are gone.
- **Reconciliation** (`/proposal/reconciliation`): opens on Unresolved (open + being looked at),
  not on all history. Head: one card per currency. Rows oldest first: kind in words, a sentence
  with formatted money, amount, age, state. A row opens to its evidence (provider, reference,
  environment, filed time, stored amount, the detector's sentence word for word, link to the
  payment). Resolve / ignore need a written note. The list says how many distinct provider
  references the rows cover (141 rows were 47 payments locally).
- **Event approvals** (`/proposal/approvals`): longest waiting first; each row shows the image (or
  the brand fallback), title, organizer, venue and country, first date in the venue's own zone,
  prices per currency, and facts to check (past date, no date, no tickets, zero prices on a paid
  event, several currencies, no image, no description, sent back before, open complaints against
  the organizer). One decision: Approve, or Send back with a reason the organizer reads.
- **Staff and security** (`/proposal/security`): seven-day signals from the audit log (sign-in
  token reuse, failed sign-ins, duty changes, authenticator replaced); staff with duties named as
  the preset they match ("Finance + 1" lists the extra); your own MFA and recovery codes; latest
  access events; open sessions stated as a gap.

Not prototyped (live pages linked from the new menu): organizer approvals, support inbox,
booking lookup, refund desk. They follow the same row pattern: support inbox = oldest first with
the booking reference resolved inline; booking lookup = one search field for reference, email or
phone with the booking, payment, tickets and refunds on one page; refund desk = request, amount in
its currency, policy check, then decide with a reason (maker-checker unchanged).

## Gaps the prototype cannot close without the API (owner decisions)

1. Staff list has no per-person MFA status; the prototype shows "Not reported" rather than guess.
2. No endpoint lists or ends signed-in sessions.
3. The event review list has no image, price or "submitted at"; the prototype fetches each event
   (12 requests) and ages by last change. A list field would make this one request.
4. Queue age is read from each list's last page (newest-first ordering); a `oldestAt` on the
   count would be cheaper and exact.
5. Reconciliation rows for one payment are separate rows; grouping by provider reference needs a
   decision on whether resolving one closes the others.
6. Organizer approvals need registration facts (legal name, entity type, country) on the queue row.

## Evidence

Before (live `/admin`) and after (`/proposal`) at 1440, 1024 and 390, on the local stack:
`C:\etg-wt\q4-shots\before\` and `C:\etg-wt\q4-shots\after\` (plus `reconciliation-evidence-*`
and `approvals-reason-*` for the interaction states). Rules that are logic are unit tested in
`apps/admin-web/lib/proposal-model.test.ts`.
