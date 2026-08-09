# Theater operations — the organizer scheduling workspace

How a duty manager runs a cinema's day from `/organizer/cinemas/[id]/schedule`, and what
the screen will and will not let them do.

This is the operator-facing companion to [SHOW-SCHEDULING.md](./SHOW-SCHEDULING.md), which
documents the API and the rules the server enforces. Where the two disagree, the server is
right and this file is out of date.

---

## The shape of the screen

**Date → Screen → Timeline.** That ordering is deliberate: a duty manager's question is
"what is on Screen 2 today", not "show me all events". A generic card grid would display
the same rows and be useless for spotting a gap or a clash.

Two modes share one date anchor and one screen filter:

| Mode     | Answers                                   | Has controls?                       |
| -------- | ----------------------------------------- | ----------------------------------- |
| **Day**  | "What is on right now, and what do I do?" | Yes — pause, reopen, move, cancel   |
| **Week** | "How does the next seven days look?"      | No — selecting a show opens its day |

The week view deliberately carries no pause/cancel/move buttons. Those need the context the
day view gives you, and duplicating them would mean two places to keep correct.

### Navigation

`← Prev` / `Today` / `Next →` move by **one day** in day mode and **seven days** in week
mode; the buttons relabel themselves accordingly so a screen reader announces which one it
is. The week always starts on **Monday**, regardless of locale.

---

## Timezone: the cinema's, never yours

Every date and time on this screen is the **cinema's local wall clock**. A Hyderabad
multiplex operated from London shows Hyderabad days and Hyderabad times.

This matters more than it sounds. A 00:30 show in Hyderabad is 19:00 the _previous day_ in
UTC and 20:00 the previous day in London. Bucketing on the browser's zone puts that show on
the wrong date, and the operator plans a day that does not exist.

The zone is an IANA name (`Asia/Kolkata`), resolved per date — not a fixed offset — so
markets with daylight saving stay correct across a clock change.

> **Known limitation.** `Cinema` has no timezone column yet, so the workspace defaults to
> `Asia/Kolkata` for the India launch market. A chain operating across zones needs the
> column. It is defaulted in exactly one place — the `timezone` constant in
> `app/organizer/cinemas/[id]/schedule/page.tsx` — which is what will change when the column
> exists.

Times display in **24-hour** format. Cinema schedules are dense and `21:00` is unambiguous
in a way that `09:00 PM` is not.

---

## Show state: one badge, one answer

A show has a **lifecycle status** (scheduled / paused / cancelled / completed) and a
**booking window** (has selling opened, has it closed). These are different questions, and
a show can be perfectly scheduled and still unsellable.

The row shows **one** badge that folds both together, because an operator needs an answer,
not a taxonomy — and because showing both produced rows reading "On sale Booking closed",
two badges contradicting each other in the same breath.

| Badge              | Meaning                                           | Who undoes it            |
| ------------------ | ------------------------------------------------- | ------------------------ |
| **On sale**        | Customers can book right now                      | —                        |
| **Not open yet**   | Sales window has not started; the hint names when | The clock                |
| **Booking closed** | Sales window has ended                            | The clock                |
| **Sales paused**   | An operator stopped sales deliberately            | A person, via **Reopen** |
| **Cancelled**      | The show was cancelled                            | Nobody — it is terminal  |
| **Finished**       | The show has played                               | —                        |

"Sales paused" and "Booking closed" are kept in different words on purpose. One is somebody's
decision and is undone by a person; the other is the clock. Telling an operator "closed" when
a colleague paused it sends them looking for a scheduling fault that does not exist.

An unrecognised status from a newer API renders **as itself** rather than defaulting to "On
sale". An out-of-date screen should say something honest and unfamiliar, not something
confident and wrong.

### The window boundary is inclusive

A show is still sellable **at** its closing instant. Booking creation refuses on
`salesEndAt < now`, so the workspace uses the same rule. An exclusive close reads more
naturally and would mean the screen says "closed" on a show the server would happily sell —
turning customers away for nothing.

---

## What you can do to a show

All four actions go through the server. The workspace never decides eligibility itself; it
renders what the API said and turns rejection codes into sentences. A stale page cannot
perform something the server would refuse, because the server refuses it.

### Pause / Reopen sales

Stops new bookings. **Existing tickets stay valid** — pausing is not cancelling, and the
dialog says so. Reopen is refused if the screen is now in maintenance: selling seats in a
room that cannot open is worse than leaving the show paused.

### Move (reschedule)

Changes a future show's **start time**. The end time is derived server-side from the film's
runtime, so a slot can never disagree with the length of what is playing.

Refused, with the reason shown next to the field:

- the new slot **clashes** with another show on that screen, including the turnaround gap
- the show **already has paid bookings** — the dialog says to cancel it instead
- the show is **cancelled**

Nothing moves on screen until the server confirms it. An optimistic move would show the show
at a time it may well be refused for, and refusal is the _common_ case here — that is the
entire point of the guards.

> ### Screen-change editing is NOT implemented
>
> **You cannot move a show to a different screen.** There is no screen picker in the Move
> dialog, and this is not an oversight to be worked around.
>
> The backend endpoint is `POST /shows/:sessionId/reschedule` and it accepts a start time and
> a padding value — nothing else. The policy module in `show-operations.ts` describes an
> `EDIT_SCREEN` rule, but **no endpoint implements it**. Reading that constant as evidence the
> feature exists is exactly the mistake this note is here to prevent.
>
> A screen picker that always failed would be worse than its absence, and quietly cancelling
> and recreating the session behind the operator's back would be worse still — it would break
> booking references, seat assignments and the audit trail.
>
> **The supported workflow is:** cancel the show on the old screen, then schedule it on the
> new one. That is deliberately more effort, because moving a show between rooms invalidates
> every seat somebody has already chosen.

### Cancel

Terminal, and requires a **reason**. The show stays visible on the schedule afterwards —
disappearing would hide what happened from the person covering the next shift.

> **Cancelling does not refund anybody.** The workspace does not initiate refunds, and it
> does not tell the operator that customers have been refunded. Refund handling is a separate,
> money-touching path (see the payments documentation); implying otherwise on this screen
> would be a lie with financial consequences.

---

## Creating shows

**Create shows** opens a three-step flow: **Configure → Preview → Publish.**

Preview is **mandatory**. It is a real server call with `dryRun: true` that returns exactly
what would be created and exactly what would be rejected, per slot, with reasons. You cannot
skip to publish, because a bulk schedule is the one action here that can create dozens of
rows at once.

Configure takes a screen, one or more dates (or a date range), a list of start times, and an
optional padding. A recurring range reports conflicts **per slot** rather than failing the
whole batch — one clash on Thursday should not cost you the other six days.

Range requests are capped at **14 days**. Without a bound this becomes a way to pull an
entire season in a single query.

### Copy schedule

Copies a day's shows to another date, or to another compatible screen. Useful because a
cinema week is mostly the same day repeated.

- **Cancelled shows are not copied.** Copying one forward would resurrect something an
  operator deliberately stopped.
- **Padding is not re-applied.** The source shows already contain whatever gap was used when
  they were created; re-adding it stretches the day a little further every time it is copied.
- **Bookings are never moved.** A copy creates new, empty future shows.
- **Repeating a copy creates nothing.** Not because of an idempotency key — the overlap rules
  simply refuse to duplicate a day that is already there, which is exactly what a double-click
  needs to hit.

---

## Screens and maintenance

A screen is `ACTIVE`, `MAINTENANCE` or `INACTIVE`, changed from the cinema's screen list.
Both non-active states stop new scheduling; the difference is intent.

**Taking a screen out of service does not touch the shows already on it.** Cancelling a show
somebody has paid for is an explicit, audited, per-show act — never a side effect of a status
change. Instead the operator is given a **count of future shows needing a decision**, and the
confirmation dialog states plainly that nothing has been cancelled.

Maintenance screens are shown but **disabled** in the scheduling pickers, and the server
refuses them independently with a 409. Hiding the button is a courtesy; the server is the
control.

---

## Turnaround

Consecutive shows on one screen need a gap for the room to empty, be cleaned and refill.
Default **15 minutes**, configurable via `SHOW_TURNAROUND_MINUTES`.

The gap is part of the conflict rule, not a suggestion: two shows that do not literally
overlap but leave less than the turnaround between them are **rejected**, and the rejection
message says so rather than reporting a bare "conflict". An operator who is told only
"conflict" for two shows that visibly do not overlap will assume the software is broken.

---

## Accessibility

The workspace is scanned by **axe-core** against WCAG 2.1 A and AA on every CI run, in both
day and week modes, with rows and badges actually rendered
(`apps/e2e/tests/organizer-scheduling-a11y.spec.ts`). No rules are suppressed.

Guarantees the suite pins:

- **State is never carried by colour alone.** Every badge contains real text.
- **State is announced once.** A previous version rendered a visible badge plus a hidden copy,
  so assistive tech read "Sales paused Sales paused".
- Every week card is a real `<button>` — focusable, Enter-activatable, and named with its
  time, film, screen and state in one accessible label.
- The Day/Week toggle reports the active view via `aria-pressed`, not just colour.

Fixing the first scan required darkening several **shared design tokens** that were failing
AA — muted text, the primary blue, and the status colours. Those tokens are used by all three
web apps and mirrored by the mobile app, so the change is intentionally broader than this
workspace. Details in the token file's comments.

> **What the scan does not prove.** Automated tooling catches roughly a third of WCAG issues.
> It cannot judge whether a label is _meaningful_, whether reading order makes sense, or
> whether a colour pairing works for a specific person. This is a floor, not a certificate.
> No manual screen-reader pass or user testing has been done.

---

## Testing

| Layer               | Where                                                     | Covers                                                               |
| ------------------- | --------------------------------------------------------- | -------------------------------------------------------------------- |
| Pure rules (unit)   | `app/organizer/cinemas/[id]/schedule/show-status.test.ts` | Window boundaries, timezone bucketing, week arithmetic, badge choice |
| Workspace (e2e)     | `apps/e2e/tests/organizer-scheduling.spec.ts`             | Day, week, create, copy, pause, cancel, move, tenancy, windows       |
| Accessibility (e2e) | `apps/e2e/tests/organizer-scheduling-a11y.spec.ts`        | axe WCAG 2.1 AA, keyboard reachability, single announcement          |
| Server rules        | `apps/api/src/shows/*.spec.ts`                            | Policy, conflicts, copy semantics, real-PostgreSQL race proofs       |

The unit tests exist because the browser suite **cannot** reach the cases that matter most:
no Playwright test can put the clock exactly on `salesEndAt` to check an inclusive boundary,
and proving timezone bucketing across five zones costs five browser contexts in Playwright
and a few milliseconds in a unit test.

---

## Known gaps

Listed so nobody assumes otherwise:

- **Screen-change editing** — not implemented; see the boxed note above.
- **Per-cinema timezone** — `Cinema` has no timezone column; the workspace defaults to
  `Asia/Kolkata`.
- **Refunds on cancellation** — not initiated or reported from this screen.
- **Manual accessibility testing** — no screen-reader pass, no user testing.
- **Show-level seat overrides and layout versioning** — §9 and §10 of the audit, not started.
