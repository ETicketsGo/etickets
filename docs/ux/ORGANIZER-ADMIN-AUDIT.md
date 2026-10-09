# Organizer and admin consoles - Phase 1 UX audit

Scope: `apps/organizer-web` (organizer console) and `apps/admin-web` (back office), plus the
shared kit they render with (`packages/web-kit/src/components.tsx`, `packages/web-kit/src/shell.tsx`)
and the colour tokens (`packages/design-tokens/src/tailwind-preset.ts`).

Method: read-only code review of every `page.tsx` and `layout.tsx` under both apps, plus grep
counts. Nothing here was checked in a browser. Where a finding depends on rendering (contrast,
overflow), it says so. Line numbers are from the tree this audit was written against.

Counts below cover `app/**` and `components/**` of each app unless stated otherwise.

---

## 0. Summary

- 50 organizer page files under `/organizer`, 28 admin page files under `/admin`, plus 6
  pages outside the shells (login, start, invite, root redirects).
- Admin is consistent: all 28 admin pages use `PageHeader`, and every top-level admin route
  is in the sidebar.
- Organizer is not: **about 14 organizer routes have no sidebar entry and no sidebar
  highlight** (the whole `/organizer/cinemas/**` and `/organizer/spaces/**` tree, and `/organizer/gate`
  for owners and managers). The cinema operations pages (schedule, live, readiness) are
  reached only by two clicks through a list that is itself not in the nav.
- The sidebar (`AppShell`) has a correct `aria-current`, but the nav landmark has no label,
  group headings are `<p>` elements, and the mobile drawer has no Escape key, focus trap or dialog role.
- No live non-existent colour classes were found (earlier ones were fixed). But 4 uses of
  `bg-status-*/8` emit **no CSS at all** (Tailwind 3.4 has no `8` opacity step), and
  28 `bg-status-*/N` + `text-status-*` pairs bypass the opaque `bg-tint-*` tokens that the
  `Badge` primitive was moved to for contrast reasons.
- 35 raw Tailwind palette colours (`text-slate-500`, `bg-amber-50`, `text-green-700` ...),
  all in the cinema schedule area, bypass tokens and will not follow dark mode.
- 4 different "small text" sizes in use (`text-xs` 62, `text-caption` 442, `text-sm` 308,
  `text-[0.9375rem]` 77). Section headings use at least 4 different sizes.
- Error states are uneven: the organizer **Events list has no error state** (a failed load
  reads "No events match your filters."), and 6 admin pages have no error branch at all.

---

## 1. Route inventory

Legend:

- Nav: `Y` = has its own sidebar item. `child` = no item, but a parent item prefix-matches
  so the parent is highlighted (`isActive` in `packages/web-kit/src/shell.tsx:32`).
  `NO` = no item and nothing in the sidebar is highlighted.
- Chrome: `PH` = web-kit `PageHeader`. `EvL` = the event layout's own `<h1>`
  (`apps/organizer-web/app/organizer/events/[id]/layout.tsx:253`) plus section tabs. `h1` =
  hand-rolled `<h1>`. `none` = no page heading.

### 1a. Organizer console (`apps/organizer-web/app`)

Sidebar source: `navFor()` in `apps/organizer-web/app/organizer/layout.tsx:52-137`.

| Route                                                                   | File (under `app/`)                     | Purpose                                                    | Nav                                                 | Chrome                            |
| ----------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------- | --------------------------------- |
| `/`                                                                     | `page.tsx`                              | Redirects to `/organizer` or `/login`                      | n/a                                                 | none (spinner)                    |
| `/login`                                                                | `login/page.tsx`                        | Organizer sign in (web-kit `LoginForm`)                    | n/a                                                 | LoginForm                         |
| `/start`                                                                | `start/page.tsx`                        | Create the first organization                              | n/a                                                 | h1 (`text-h2`)                    |
| `/invite/[token]`                                                       | `invite/[token]/page.tsx`               | Accept a team invite                                       | n/a                                                 | h1 (`text-title`)                 |
| `/organizer`                                                            | `organizer/page.tsx`                    | Dashboard: revenue per market, attendance, events, payouts | Y "Dashboard" (not for check-in staff)              | PH "Welcome, {org}"               |
| `/organizer/onboarding`                                                 | `organizer/onboarding/page.tsx`         | Setup checklist                                            | Y "Get started"                                     | PH "Welcome to ETicketsGo, {org}" |
| `/organizer/events`                                                     | `organizer/events/page.tsx`             | Events list                                                | Y "Events"                                          | PH "Events"                       |
| `/organizer/events/new`                                                 | `organizer/events/new/page.tsx`         | Create-event wizard (1808 lines)                           | child of Events                                     | PH "Create event"                 |
| `/organizer/events/[id]`                                                | `organizer/events/[id]/page.tsx`        | Event overview, status, delete                             | child of Events                                     | EvL                               |
| `/organizer/events/[id]/sessions`                                       | `.../sessions/page.tsx`                 | Sessions (dates, rooms, seating)                           | child                                               | EvL                               |
| `/organizer/events/[id]/tickets`                                        | `.../tickets/page.tsx`                  | Ticket types                                               | child                                               | EvL                               |
| `/organizer/events/[id]/commerce`                                       | `.../commerce/page.tsx`                 | Add-ons and bundles                                        | child                                               | EvL + h2 "Commerce"               |
| `/organizer/events/[id]/orders`                                         | `.../orders/page.tsx`                   | Orders list + drawer                                       | child                                               | EvL                               |
| `/organizer/events/[id]/attendees`                                      | `.../attendees/page.tsx`                | Attendee list                                              | child                                               | EvL                               |
| `/organizer/events/[id]/promote`                                        | `.../promote/page.tsx`                  | Event link, QR, poster                                     | child                                               | EvL + h2                          |
| `/organizer/events/[id]/checkin`                                        | `.../checkin/page.tsx`                  | Scan / find attendee                                       | child                                               | EvL                               |
| `/organizer/events/[id]/command-center`                                 | `.../command-center/page.tsx`           | Offline check-in live view (flag)                          | child                                               | EvL + h2 `text-lg`                |
| `/organizer/events/[id]/devices`                                        | `.../devices/page.tsx`                  | Offline devices (flag)                                     | child                                               | EvL + h2 `text-lg`                |
| `/organizer/events/[id]/preflight`                                      | `.../preflight/page.tsx`                | Offline preflight checks (flag)                            | child                                               | EvL + h2 `text-lg`                |
| `/organizer/events/[id]/reconciliation`                                 | `.../reconciliation/page.tsx`           | Offline scan reconciliation (flag)                         | child                                               | EvL + h2 `text-lg`                |
| `/organizer/events/[id]/reports`                                        | `.../reports/page.tsx`                  | Event report                                               | child                                               | EvL + h2 "Report"                 |
| `/organizer/events/[id]/assistant`                                      | `.../assistant/page.tsx`                | AI assistant for the event                                 | child                                               | EvL + h2                          |
| `/organizer/events/[id]/edit`                                           | `.../edit/page.tsx`                     | Event details form                                         | child                                               | EvL                               |
| `/organizer/venues`                                                     | `organizer/venues/page.tsx`             | Venues and the spaces inside them                          | Y "Venues & spaces"                                 | PH                                |
| `/organizer/cinemas`                                                    | `organizer/cinemas/page.tsx`            | A second "Spaces" list (cinema sites)                      | **NO**                                              | PH "Spaces"                       |
| `/organizer/cinemas/new`                                                | `organizer/cinemas/new/page.tsx`        | Create a space                                             | **NO**                                              | PH + breadcrumbs                  |
| `/organizer/cinemas/[id]`                                               | `organizer/cinemas/[id]/page.tsx`       | Cinema site detail, screens, ops links                     | **NO**                                              | PH + breadcrumbs                  |
| `/organizer/cinemas/[id]/onboarding`                                    | `.../onboarding/page.tsx`               | Cinema setup checklist                                     | **NO**                                              | PH + breadcrumbs                  |
| `/organizer/cinemas/[id]/readiness`                                     | `.../readiness/page.tsx`                | Cinema launch readiness                                    | **NO**                                              | PH + breadcrumbs                  |
| `/organizer/cinemas/[id]/schedule`                                      | `.../schedule/page.tsx`                 | Day/week show scheduling                                   | **NO**                                              | PH, no breadcrumbs                |
| `/organizer/cinemas/[id]/live`                                          | `.../live/page.tsx`                     | Live seat states and overrides                             | **NO**                                              | PH, no breadcrumbs                |
| `/organizer/cinemas/[id]/reports`                                       | `.../reports/page.tsx`                  | Seat override history                                      | **NO**                                              | PH, no breadcrumbs                |
| `/organizer/cinemas/[id]/screens/[screenId]/seatmap`                    | `.../seatmap/page.tsx`                  | Seat map editor                                            | **NO**                                              | PH + breadcrumbs                  |
| `/organizer/cinemas/[id]/screens/[screenId]/layouts`                    | `.../layouts/page.tsx`                  | Seat layout versions                                       | **NO**                                              | PH + "Back to screen"             |
| `/organizer/cinemas/[id]/screens/[screenId]/layouts/[layoutId]/preview` | `.../preview/page.tsx`                  | Preview as buyer                                           | **NO**                                              | PH + breadcrumbs                  |
| `/organizer/spaces/[screenId]/layouts`                                  | `organizer/spaces/.../layouts/page.tsx` | Re-export of the layouts page for non-cinema spaces        | **NO**                                              | (same as above)                   |
| `/organizer/spaces/[screenId]/layouts/[layoutId]/preview`               | `organizer/spaces/.../preview/page.tsx` | Re-export of preview                                       | **NO**                                              | (same as above)                   |
| `/organizer/bookings`                                                   | `organizer/bookings/page.tsx`           | Box office booking lookup                                  | Y "Find a booking"                                  | PH                                |
| `/organizer/bookings/[bookingId]/print`                                 | `.../print/page.tsx`                    | Printable tickets, no shell by design                      | n/a (print)                                         | none                              |
| `/organizer/counter`                                                    | `organizer/counter/page.tsx`            | Cash held for cash-at-venue                                | Y "Counter"                                         | PH                                |
| `/organizer/promotions`                                                 | `organizer/promotions/page.tsx`         | Discount codes                                             | Y "Promotions"                                      | PH                                |
| `/organizer/movies`                                                     | `organizer/movies/page.tsx`             | Films list                                                 | Y "Movies" **only if** the org has a film           | PH                                |
| `/organizer/movies/new`                                                 | `organizer/movies/new/page.tsx`         | Add a film                                                 | child (conditional)                                 | PH + breadcrumbs                  |
| `/organizer/movies/[id]`                                                | `organizer/movies/[id]/page.tsx`        | Film detail and showtimes                                  | child (conditional)                                 | PH + breadcrumbs                  |
| `/organizer/finance`                                                    | `organizer/finance/page.tsx`            | Earned / paid / to come                                    | Y "Finance"                                         | PH                                |
| `/organizer/payouts`                                                    | `organizer/payouts/page.tsx`            | Payout account and settlements                             | Y "Payouts"                                         | PH                                |
| `/organizer/receipts`                                                   | `organizer/receipts/page.tsx`           | Receipts, invoices, credit notes                           | Y "Receipts"                                        | PH "Receipts and invoices"        |
| `/organizer/refunds`                                                    | `organizer/refunds/page.tsx`            | Refund requests                                            | Y "Refunds"                                         | PH                                |
| `/organizer/notifications`                                              | `organizer/notifications/page.tsx`      | Alerts                                                     | Y "Notifications"                                   | PH                                |
| `/organizer/team`                                                       | `organizer/team/page.tsx`               | Members and invites                                        | Y "Team"                                            | PH                                |
| `/organizer/premium`                                                    | `organizer/premium/page.tsx`            | Premium features enquiry                                   | Y "Premium"                                         | PH "Premium & enterprise"         |
| `/organizer/help`                                                       | `organizer/help/page.tsx`               | Help centre                                                | Y "Help"                                            | PH "Help center"                  |
| `/organizer/settings`                                                   | `organizer/settings/page.tsx`           | Organization settings, theme                               | Y "Settings"                                        | PH                                |
| `/organizer/gate`                                                       | `organizer/gate/page.tsx`               | Door scanner (pick a show, scan)                           | Y **only for check-in staff**; NO for owner/manager | PH                                |

Entry points for the `NO` rows (verified with grep):

- `/organizer/cinemas`: `onboarding/page.tsx:223` ("Set up a space") and
  `events/[id]/sessions/page.tsx:29` (`ROOMS_HREF`, "set one up").
- `/organizer/cinemas/[id]`: only a row click on `/organizer/cinemas` (`cinemas/page.tsx:79`).
- `/organizer/cinemas/[id]/{onboarding,readiness,schedule,live,reports}`: only the button row
  on the cinema detail page (`cinemas/[id]/page.tsx:363-379`) and the readiness step links.
- `.../layouts` and `/organizer/spaces/...`: `spaceHref()` on the venues page
  (`organizer/venue-spaces.ts:91-95`).
- `/organizer/gate`: nothing links to it except the check-in-staff nav (`layout.tsx:72`).

### 1b. Admin console (`apps/admin-web/app`)

Sidebar source: `nav` in `apps/admin-web/app/admin/layout.tsx:39-85`. All admin pages use `PageHeader`.

| Route                           | Purpose (from its description)              | Nav label           | Page title                                                |
| ------------------------------- | ------------------------------------------- | ------------------- | --------------------------------------------------------- |
| `/`                             | Redirect (spinner)                          | n/a                 | none                                                      |
| `/login`                        | Admin sign in                               | n/a                 | LoginForm                                                 |
| `/invite/[token]`               | Join the back office                        | n/a                 | h1 `text-title`                                           |
| `/admin`                        | What needs you, marketplace health          | Dashboard           | Platform overview                                         |
| `/admin/organizers`             | Sellers and their standing                  | Organizers          | Organizers                                                |
| `/admin/organizers/[id]`        | One seller                                  | child               | {org name} + breadcrumbs                                  |
| `/admin/events`                 | Everything on sale / awaiting decision      | Events              | Events                                                    |
| `/admin/events/[id]`            | One event                                   | child               | {title} + breadcrumbs                                     |
| `/admin/movies`                 | Movies across the platform                  | Movies              | Movies                                                    |
| `/admin/bookings`               | Search all bookings                         | Bookings            | Bookings                                                  |
| `/admin/bookings/[id]`          | One booking                                 | child               | "Booking" + breadcrumbs                                   |
| `/admin/users`                  | Every login                                 | Accounts            | Accounts                                                  |
| `/admin/payments`               | Every charge                                | Payments            | Payments                                                  |
| `/admin/refunds`                | Refund requests                             | Refunds             | Refunds                                                   |
| `/admin/refunds/[id]`           | One refund                                  | child               | "Refund request" + breadcrumbs + "Back to refunds" button |
| `/admin/payouts`                | "Organizer settlements across the platform" | Payouts             | Payouts                                                   |
| `/admin/settlements`            | "Marketplace payout ledger"                 | Settlements         | Settlements                                               |
| `/admin/disputes`               | Chargebacks by deadline                     | Chargebacks         | Chargebacks                                               |
| `/admin/finance-reconciliation` | Discrepancy triage                          | Finance Recon       | Finance reconciliation                                    |
| `/admin/reports`                | Read-only business reports (10 tabs)        | Reports             | Business reports                                          |
| `/admin/settings`               | Booking fee bands per market                | Booking fees        | Booking fees                                              |
| `/admin/tax-rules`              | Tax rates                                   | Tax rules           | Tax rules                                                 |
| `/admin/cinema-pricing`         | Regulated ticket price policies             | Cinema pricing      | Cinema pricing policies                                   |
| `/admin/payment-config`         | Provider settings per environment           | Payment Config      | Payment configuration                                     |
| `/admin/merchant-onboarding`    | Provider merchant accounts                  | Merchant Onboarding | Merchant onboarding                                       |
| `/admin/payment-promotion`      | Promote provider config between envs        | Env Promotion       | Environment promotion                                     |
| `/admin/staff`                  | Back-office staff and duties                | Staff & duties      | Back-office staff                                         |
| `/admin/support`                | Complaints, contact, bugs, surveys          | Support             | Support and complaints                                    |
| `/admin/audit`                  | Audit log                                   | Audit               | Audit log                                                 |
| `/admin/ops`                    | System health, queues, flags                | Operations          | Operations                                                |
| `/admin/ai`                     | AI provider status                          | AI Console          | AI Console                                                |

Admin has no orphan routes: every top-level route is a nav item, and every detail route is a
prefix child of one.

---

## 2. Shared vs duplicated UI patterns

### 2a. Adoption of web-kit primitives (JSX use count / files)

| Primitive     | Organizer | Admin   |
| ------------- | --------- | ------- |
| `PageHeader`  | 33 / 32   | 28 / 28 |
| `Card`        | 141 / 56  | 81 / 29 |
| `MetricCard`  | 52 / 6    | 47 / 7  |
| `DataTable`   | 24 / 19   | 29 / 24 |
| `StatusBadge` | 28 / 19   | 25 / 18 |
| `Badge`       | 43 / 26   | 34 / 17 |
| `EmptyState`  | 20 / 18   | 22 / 17 |
| `ErrorState`  | 40 / 33   | 19 / 14 |
| `Skeleton`    | 59 / 37   | 30 / 19 |
| `Spinner`     | 6 / 6     | 5 / 3   |
| `Dialog`      | 38 / 25   | 28 / 17 |
| `Drawer`      | 1 / 1     | 0       |
| `Pagination`  | 6 / 6     | 11 / 11 |
| `SearchInput` | 5 / 5     | 10 / 10 |

Adoption is high. No hand-rolled modal overlays were found (`fixed inset-0` / `role="dialog"`
appear only in web-kit). The duplication is in the smaller patterns below.

### 2b. Hand-rolled equivalents

| Pattern                                                                              | Count                                             | Examples                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw `<table>` instead of `DataTable`                                                 | 3                                                 | `organizer/page.tsx:264` and `admin/page.tsx:225` (the same "By market" table written twice, once per app); `organizer/cinemas/[id]/reports/page.tsx:204`                                                                                                                                                                   |
| Tab / segmented controls (no web-kit primitive exists)                               | 2 tablists + 12 files with `aria-pressed` toggles | `organizer/page.tsx:210` (market tabs, tint style), `admin/reports/page.tsx:854` (report tabs, solid primary style); `aria-pressed` groups in `cinemas/[id]/schedule/page.tsx`, `cinemas/[id]/live/page.tsx`, `events/[id]/attendees/page.tsx`, `admin/audit/page.tsx`, `admin/users/page.tsx`, `admin/page.tsx` and others |
| Badges built from a class map with `bg-status-*/10` instead of `Badge` / `bg-tint-*` | 4 maps                                            | `admin/cinema-pricing/page.tsx:42-47` (`STATUS_TONE`), `organizer/needs-attention.tsx:27-39` (rendered as a pill at :94), `components/pricing-compliance-panel.tsx:48-54`, `admin-web/components/legal-identity-card.tsx:130-134`                                                                                           |
| Alert / notice boxes (no `Alert` / `Callout` primitive exists)                       | 28 wash+text pairs, see 4d                        | `events/[id]/checkin/page.tsx:162`, `events/[id]/edit/page.tsx:228`, `payouts/page.tsx:308,443`, `admin/payment-config/page.tsx:175,181`                                                                                                                                                                                    |
| Empty states not using `EmptyState`                                                  | 5 `empty=` props + 1 card                         | `events/page.tsx:200`, `events/[id]/reports/page.tsx:167,175,240,259`, `gate/page.tsx:136-143` (hand-built icon + title + hint card)                                                                                                                                                                                        |
| Error states not using `ErrorState`                                                  | at least 2                                        | `organizer/venues/page.tsx:262-275` (card + "Retry" button, no `role="alert"`), `organizer/bookings/page.tsx:79-84`                                                                                                                                                                                                         |
| Loading text instead of `Skeleton`                                                   | 6                                                 | `admin/settings/page.tsx:340` (`<Card>Loading...</Card>`), `admin/tax-rules/page.tsx:367`, `gate/page.tsx:134` ("Loading shows..."), `events/[id]/attendees/page.tsx:311`, `movies/[id]/page.tsx:587,610`                                                                                                                   |
| Sub-navigation                                                                       | 3 different patterns                              | Event area: tab bar + pill sub-nav in a layout (`events/[id]/layout.tsx`). Cinema area: a row of `secondary` buttons on the detail page only (`cinemas/[id]/page.tsx:363`), nothing on its sub-pages. Admin reports: grouped tab buttons inside the page.                                                                   |
| Breadcrumbs                                                                          | 2 implementations                                 | `PageHeader breadcrumbs` (13 pages) vs a hand-rolled `<nav aria-label="Breadcrumb">` with `text-sm` in `events/[id]/layout.tsx:242` (PageHeader uses `text-caption`)                                                                                                                                                        |

Note: the kit's own `ErrorState` uses the wash pattern it warns against elsewhere
(`components.tsx:460`, `border-status-error/30 bg-status-error/5` with `text-status-error`).

---

## 3. Navigation inconsistencies

### 3a. Organizer routes missing from the sidebar

1. **The cinema / spaces tree has no sidebar presence.** `/organizer/cinemas`, `/new`, `/[id]`
   and its 5 operations pages, the 3 screen pages, and the 2 `/organizer/spaces/...` re-exports
   match no nav `href`, so on all of them **no item is highlighted** and `aria-current` is
   absent everywhere. Breadcrumbs on some of them say "Venues & spaces", which is not the
   section the URL is in.
2. **Theatre operations (Schedule, Live operations, Launch readiness, Override history) are
   2-3 clicks deep** behind `/organizer/cinemas`, which is itself reached only from onboarding and
   the sessions page. A cinema operator's daily screen (Schedule) has no direct way in.
3. **`/organizer/gate` is unreachable for owners and managers.** It is in the nav only for
   check-in staff (`layout.tsx:70-75`), and no page links to it.
4. **Check-in staff land on a page that is not in their nav.** Login redirects everyone to
   `/organizer` (`login/page.tsx:10`), but the staff nav has only Gate and Help, so the landing
   page has no highlighted item.
5. **Movies is conditional** (`layout.tsx:117-119`); `/organizer/movies` is still linked from
   `venues/page.tsx:251`. This is intentional (explained in the comment), but the new grouped
   nav must keep the route reachable for an org with no films yet.
6. Manager and owner get the same nav: the code has only two cases (staff, everyone else).

### 3b. Two lists for the same thing

- `/organizer/venues` ("Venues & spaces") and `/organizer/cinemas` (title "Spaces", description
  "Venues & spaces shows both together", `cinemas/page.tsx:67-68`). Onboarding's "Set up a space"
  and the sessions page's "set one up" go to the second one; the sidebar goes to the first.

### 3c. Labels that differ between nav / tab and page title

| Where              | Nav or tab says                     | Page says                            |
| ------------------ | ----------------------------------- | ------------------------------------ |
| Organizer          | Dashboard                           | Welcome, {org}                       |
| Organizer          | Get started                         | Welcome to ETicketsGo, {org}         |
| Organizer          | Help                                | Help center                          |
| Organizer          | Premium                             | Premium & enterprise                 |
| Organizer          | Receipts                            | Receipts and invoices                |
| Organizer          | (no item)                           | Spaces (`/organizer/cinemas`)        |
| Organizer cinema   | Override history (button)           | Seat override history                |
| Organizer cinema   | Setup (button) / "Setup" breadcrumb | Set up {cinema}                      |
| Organizer seat map | breadcrumb "Layout"                 | {screen} - Seat map                  |
| Event tab          | Add-ons & bundles                   | Commerce                             |
| Event tab          | Command center                      | Live Event Command Center            |
| Event tab          | Reconciliation                      | Reconciliation console               |
| Event tab          | Report                              | Report (tab "Reports")               |
| Event tab          | Promote                             | Promote this event                   |
| Admin              | Dashboard                           | Platform overview                    |
| Admin              | Finance Recon                       | Finance reconciliation               |
| Admin              | Payment Config                      | Payment configuration                |
| Admin              | Env Promotion                       | Environment promotion                |
| Admin              | Staff & duties                      | Back-office staff                    |
| Admin              | Support                             | Support and complaints               |
| Admin              | Audit                               | Audit log                            |
| Admin              | Reports                             | Business reports                     |
| Admin              | Cinema pricing                      | Cinema pricing policies              |
| Admin              | Chargebacks                         | Chargebacks (URL `/admin/disputes`)  |
| Admin              | Booking fees                        | Booking fees (URL `/admin/settings`) |

### 3d. Group naming and casing

- Organizer groups: (none), Selling, Films, Money, Account. Admin groups: (none), Marketplace,
  Money, Pricing rules, Providers, Platform. "Money" is the only shared group name.
- Organizer "Selling" mixes venue setup (Venues & spaces), box office (Find a booking, Counter)
  and marketing (Promotions). "Account" mixes Help and Premium with Team and Settings.
- Admin labels mix Title Case ("Finance Recon", "Payment Config", "Merchant Onboarding",
  "Env Promotion", "AI Console") with sentence case ("Booking fees", "Tax rules", "Staff & duties").
- Admin uses the same `Percent` icon for all three Pricing rules items (`admin/layout.tsx:67-69`).
- Admin shell is `contained` width with no theme switch; organizer is `fluid` with
  `ColorSchemeSwitch` (`organizer/layout.tsx:171-174`, `admin/layout.tsx:90`).
- Admin "Payouts" is described as "Organizer settlements" and "Settlements" as "payout ledger"
  (`admin/payouts/page.tsx:182`, `admin/settlements/page.tsx:130`) - each page uses the other's word.

---

## 4. Accessibility and responsive defects visible in code

### 4a. Sidebar and shell (`packages/web-kit/src/shell.tsx`) - this workstream

- `aria-current="page"` is set correctly (`:117`), but only for routes that prefix-match an item
  (see 3a.1).
- The sidebar `<nav>` has no `aria-label` (`:103`). Pages also render `nav` landmarks for
  breadcrumbs, event sections and cinema operations, so screen readers get several unnamed or
  similar landmarks.
- Group headings are `<p>` (`:110`), and items are `<div><Link>` not `<ul><li>`. A screen reader
  gets no grouping and no item count.
- The mobile drawer (`:303-323`) is a `motion.div`: no `role="dialog"`, no `aria-modal`, no
  Escape handler, no focus move or trap. Focus stays on the hamburger behind the overlay.
- The hamburger has `aria-expanded` but no `aria-controls`.
- Link text uses an ad hoc `text-[0.9375rem]` (`:118`); avatar and name use `text-[0.8125rem]`
  (`:272,277,285`).

### 4b. Tabs

- Both hand-rolled tablists (`organizer/page.tsx:210`, `admin/reports/page.tsx:854`) set
  `role="tab"` and `aria-selected` but have no `aria-controls`, no `role="tabpanel"`, no
  arrow-key handling and no roving `tabIndex`. The ARIA tab pattern is claimed but not delivered.
- `admin/reports/page.tsx:852-881`: the `tablist` contains `div` and `p` group labels between
  the tabs, which is not a valid tablist child. The tab buttons there have no focus-visible ring.

### 4c. Icon-only buttons without an accessible name (2 found)

- `organizer/cinemas/[id]/screens/[screenId]/seatmap/page.tsx:555-560` - remove-section button, `<Trash2>` only.
- `admin/payment-config/page.tsx:336-338` - delete row button, `<Trash2>` only.

(Scanned every `button`, `Button`, `ButtonLink` and `Link` with no text, `aria-label`, `title` or `sr-only` child.)

### 4d. Alpha-wash colour pairs (contrast depends on what is behind them)

- 60 `bg-status-*/N` uses across 32 files; 28 lines pair the wash with `text-status-*` on the
  same element. Top files: `cinemas/[id]/screens/[screenId]/layouts/page.tsx` (6),
  `components/offline-checkin.tsx` (4), `components/pricing-compliance-panel.tsx` (3),
  `components/edit-show-dialog.tsx` (3), `movies/[id]/page.tsx` (3),
  `cinemas/[id]/schedule/show-pricing.tsx` (3), `admin/cinema-pricing/page.tsx` (3).
- The `Badge` comment (`components.tsx:337-346`) records that this pattern measured 4.12:1 on a
  tinted section. The same risk applies to all 28. Not measured here.
- **4 classes emit no CSS:** `bg-status-warning/8` (`payouts/page.tsx:308`, `:443`;
  `admin/payment-config/page.tsx:181`) and `bg-status-success/8` (`admin/payment-config/page.tsx:175`).
  Tailwind 3.4.19 resolves a bare alpha modifier only from `theme.opacity`, which has no `8`
  (`node_modules/tailwindcss/lib/util/pluginUtils.js:159`). These notices render with a border
  and coloured text but no background.

### 4e. Colours that bypass tokens

- 35 raw palette classes, all in the cinema schedule area:
  `cinemas/[id]/schedule/bulk-scheduler.tsx` (16), `copy-schedule.tsx` (10), `schedule/page.tsx` (9).
  Examples: `text-slate-500`, `divide-slate-200` (`page.tsx:355`), `bg-amber-50 text-amber-900`
  (`page.tsx:636`), `text-green-700` (`bulk-scheduler.tsx:286,315`), `text-red-600` (`:217`).
  They do not change in dark mode, which the organizer console offers (`ColorSchemeSwitch`).
- `text-white` / `bg-black/75` on image overlays (`components/event-image-picker.tsx`,
  `components/event-image-focus.tsx`, `admin/events/[id]/page.tsx`) are acceptable (over photos).
  `bg-white` in `events/[id]/promote/page.tsx` and `border-black/10` in `settings/page.tsx` are worth a look.
- **No non-existent token classes are live.** A scan of every colour utility against the
  preset found only names inside comments (`bg-action-primary-primary`, `bg-background`,
  `bg-accent`, `outline-accent` - all already fixed). No dynamically built colour classes
  (`bg-${x}`) exist in either app.

### 4f. Tables and overflow

- All 3 raw tables sit in `overflow-x-auto` wrappers, and `DataTable` has its own
  (`components.tsx:564`) with `min-w-[22rem]`. No table overflow defect found in code.
- Fixed `min-w-[8rem]`-`[14rem]` items (`cinemas/[id]/live/page.tsx:181`,
  `readiness/page.tsx:182`, `schedule/page.tsx:410`, `layouts/page.tsx:201`,
  `onboarding/page.tsx:118`) are inside `flex-wrap` rows; likely fine at 320px, not verified.
- `events/page.tsx:169` uses `sm:grid-cols-[1fr_200px]`, so it stacks below `sm`. OK.

### 4g. Loading announcements

- `Spinner` is `aria-hidden` (`components.tsx:415`), and full-page spinners have no text or
  `role="status"`: `organizer-web/app/page.tsx:16`, `components/org-context.tsx:112` (this one
  gates every organizer page while the org list loads), `events/[id]/command-center/page.tsx:165`,
  `events/[id]/preflight/page.tsx:151`, `admin-web/app/page.tsx:14`.
- `Skeleton` has no accessible text either. Neither primitive has a "loading" label.

### 4h. ASCII rule (house style)

User-visible strings still contain non-ASCII characters. Verified examples: page titles
`"{name} [em-dash] live operations"` (`cinemas/[id]/live/page.tsx:134`), `"[em-dash] launch readiness"`
(`readiness/page.tsx:69`), `"[em-dash] schedule"` (`schedule/page.tsx:142`), `"{screen} [middle dot] Seat map"`
(`seatmap/page.tsx:336`), `"No conflicts [em-dash] every slot is free."` (`bulk-scheduler.tsx:315`),
`"We couldn[curly apostrophe]t load this"` (`venues/page.tsx:264`), `"Search events[ellipsis]"` (`events/page.tsx:175`),
the event breadcrumb placeholder `'[ellipsis]'` (`events/[id]/layout.tsx:246`), descriptions with `[em-dash]`
and `[arrow]` (`onboarding/page.tsx:127`, `admin/payment-promotion/page.tsx:147`,
`admin/finance-reconciliation/page.tsx:175`, `admin/merchant-onboarding/page.tsx:85`).
Grep finds roughly 325 lines with an em-dash in these apps; many are comments, so the
number is an upper bound.

---

## 5. Typography, spacing and overflow

### 5a. Font sizes

| Class                              | Uses           | Notes                                                                                                                                                      |
| ---------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text-caption` (13px token)        | 442            | the intended small size                                                                                                                                    |
| `text-sm` (14px Tailwind default)  | 308            | not a token                                                                                                                                                |
| `text-[0.9375rem]` (15px, ad hoc)  | 77             | used as "body" in MetricCard, EmptyState, PageHeader description and pages                                                                                 |
| `text-xs` (12px default)           | 62 in 22 files | top: `admin/tax-rules` 7, `admin/payment-config` 7, `events/[id]/attendees` 6, `events/[id]/reconciliation` 5, `bulk-scheduler` 5, `admin/bookings/[id]` 5 |
| `text-[0.8125rem]`                 | 4              | same size as `text-caption`, written out                                                                                                                   |
| `text-[0.625rem]`, `text-[0.5rem]` | 3, 2           | 10px and 8px seat labels: `cinemas/[id]/live/seat-map.tsx:124,155`, `seatmap/page.tsx:455,798,805`                                                         |
| `text-body`                        | 2              | the body token is almost unused                                                                                                                            |

There are four near-identical small sizes (12, 13, 14, 15px) with no clear rule.

### 5b. Headings

- Page `<h1>`: `PageHeader` uses `text-h2` (23-32px clamp, `shell.tsx:368`). The event layout's
  `<h1>` uses `text-2xl` (fixed 24px, `events/[id]/layout.tsx:253`). Invite pages use `text-title`
  for `<h1>`. `/start` uses `text-h2`. That gives 3 different `<h1>` sizes.
- Section `<h2>`: `text-title` (8, also `Card`'s title), `text-lg` (4 - the four offline event
  pages), `text-caption` uppercase (3 - dashboard section labels), `text-sm` (1).
- `<h3>`: `text-sm` 7, `text-[0.9375rem]` 4, `text-caption` 2, `text-base` 2, `text-title` 1.
- Event sub-pages are inconsistent: 8 open with their own `<h2>` (Commerce, Promote, Report,
  Assistant, and the 4 offline pages at `text-lg`), the other 7 open straight into Cards.

### 5c. Spacing

- Page roots: `space-y-6` (36 pages), `space-y-4` (12), `mx-auto max-w-2xl space-y-6` (5),
  `max-w-4xl` (3), `space-y-8` / `space-y-5` (1 each). Organizer `events/page.tsx:164` is
  `space-y-4` while most list pages are `space-y-6`.
- `PageHeader` adds its own `mb-8` (`shell.tsx:346`) on top of the root `space-y-*`, so the
  header-to-content gap is uneven.
- `space-y-*` values in use: 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8 (10 steps).
- The organizer layout adds `mb-4` for the org switcher above every page (`layout.tsx:178`); on a
  single-org account it collapses (`empty:mb-0`).

### 5d. Dashboard specifics (`organizer/page.tsx`) - this workstream

- Loading skeleton is 6 boxes in a 3-column grid (`:180-184`), but the loaded content is
  rows of 4 `MetricCard`s, so the layout jumps when data arrives.
- "Create event" appears 3 times on one screen: header action (`:167`), "Quick actions" card (`:467`),
  and the "No events yet" empty state (`:413`).
- Two heading styles side by side: uppercase caption `<h2>` for metric groups (`:195`, `:342`,
  `:372`) and `text-title` `<h2>` from `Card`.
- The "By market" table duplicates `admin/page.tsx:225` almost line for line.

---

## 6. Confusing flows (evidence only)

1. **Setting up seating:** the sidebar says "Venues & spaces" (`/organizer/venues`); onboarding
   and the sessions page send you to a different list titled "Spaces" (`/organizer/cinemas`),
   whose own description points back to the first.
2. **Cinema operations:** Schedule / Live operations / Launch readiness are a row of buttons on a
   page that is only reachable from the second list (1.). Live, Schedule and Override history
   have no breadcrumbs back.
3. **Event tab names vs page names** (3c): "Add-ons & bundles" opens a page headed "Commerce".
4. **Events list:** with no events, or when the list fails to load, the table says "No events
   match your filters." (`events/page.tsx:200`) even with no filter set; there is no
   first-run "Create your first event" empty state on this page.
5. **Admin booking fees:** if the fee query fails, the page shows "No fee rules configured. The
   booking engine falls back to the built-in India defaults" (`admin/settings/page.tsx:395-401`),
   because the empty branch keys on `!isLoading` only.
6. **Admin refund detail:** shows both breadcrumbs (whose last item is the first 8 characters of
   the id) and a "Back to refunds" button (`admin/refunds/[id]/page.tsx:66,74`).

---

## 7. Loading, empty and error states

### 7a. Pages with no error branch for their main query

| Page                                                                    | What happens on failure                                                          |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `organizer/events/page.tsx`                                             | Table shows "No events match your filters." (no `isError`, no `error=`)          |
| `organizer/gate/page.tsx`                                               | Blank under the header (only `isLoading` and `length === 0` handled, `:133-143`) |
| `organizer/onboarding/page.tsx`                                         | `venuesQ` (`:53`) has no error branch                                            |
| `admin/settings/page.tsx`                                               | Misleading "No fee rules configured" (see 6.5)                                   |
| `admin/tax-rules/page.tsx`                                              | No `isError`                                                                     |
| `admin/finance-reconciliation/page.tsx`                                 | No `isError`; table passes `loading` only                                        |
| `admin/merchant-onboarding/page.tsx`                                    | No `isError`                                                                     |
| `admin/payment-promotion/page.tsx`                                      | No `isError`                                                                     |
| `admin/payouts/bank-accounts.tsx`, `admin/payouts/settlement-terms.tsx` | No `isError`                                                                     |

Also: `DataTable` accepts `error` / `onRetry`, but 18 files that render one do not pass
`error` (some handle the error elsewhere on the page, which is fine). Examples that rely only on
the table: the rows above, plus `events/[id]/reports/page.tsx` (4 tables, one page-level `ErrorState`).

### 7b. Error copy

The default message "We couldn't load this. Please try again." is used widely and says
nothing about what failed (`events/[id]/layout.tsx:237`, `organizer/page.tsx:174`, `venues/page.tsx:264`).

### 7c. Loading style mix

- Skeleton: 89 uses (most pages).
- Spinner: 11 uses (full-page redirects, `OrgProvider`, command center, preflight, invite, start).
- Plain "Loading..." text: 6 places (see 2b).
- No `loading.tsx` route files exist in either app; every loading state is in-page.

### 7d. Empty states

- `EmptyState` is used 42 times. Hand-rolled empties: 5 `empty=` props (2b) and the gate card.
- `DataTable` without an `empty` prop falls back to "Nothing to show" (`components.tsx:530`).

---

## 8. Prioritised recommendations

Ownership key: **[DS]** = this workstream (design system, organizer shell/nav, dashboard).
**[EV]** events pages owner, **[CAL]** calendar / cinema schedule owner, **[ADM]** admin pages owner.

### P1 - fix first

1. **[DS] Make every organizer route reachable and highlighted from the sidebar.** In the new
   grouped sidebar, give the venue/space/cinema tree a home: either an item whose `href` (or an
   extra `match` prefix list on `NavItem`) covers `/organizer/cinemas` and `/organizer/spaces`, or
   one item for "Venues & spaces" that also matches those prefixes. Add a way in to the cinema
   Schedule for orgs that have a cinema. Add `Gate` for owners and managers (e.g. under a
   "Door" or "Box office" group with Find a booking and Counter). Add Dashboard (or redirect to Gate)
   for check-in staff.
2. **[DS] Sidebar accessibility:** `aria-label` on the sidebar `nav`, real `<ul>/<li>` grouping with
   a heading or `aria-labelledby` per group, and a proper mobile drawer (dialog role, Escape,
   focus in and back, `aria-controls` on the hamburger).
3. **[DS] Remove the 4 `/8` classes or add `8` to the preset's opacity scale**, and add a
   primitive `Notice` / `Callout` (tone = success | warning | error | info) on `bg-tint-*` so the
   28 wash pairs have something to migrate to. Fix `ErrorState`'s own wash at the same time.
4. **[EV] Events list error and first-run states** (`events/page.tsx:195-201`): pass
   `error`/`onRetry`, and use `EmptyState` with "Create event" when there are no events at all.
5. **[ADM] Error branches** for settings, tax-rules, finance-reconciliation, merchant-onboarding,
   payment-promotion, and the two payouts sub-components; stop the fee page claiming "no rules"
   when the read failed.
6. **[DS][ADM] Name the 2 icon-only delete buttons** (`seatmap/page.tsx:555`,
   `admin/payment-config/page.tsx:336`).

### P2 - consistency

7. **[DS] Add a `Tabs` / `SegmentedControl` primitive** with the full ARIA pattern (or use
   `aria-pressed` buttons and drop the tab roles), then migrate the dashboard market switch.
   **[ADM]** migrates `admin/reports` tabs.
8. **[DS] Dashboard:** match the skeleton to the loaded layout (rows of 4), keep one "Create event"
   entry point, and share the "By market" table with admin via web-kit (`DataTable` or a
   `MarketTable` component).
9. **[DS] Type scale rule:** pick `text-caption` for small text and `text-body` (or a new 15px
   token) for body; replace `text-[0.9375rem]` / `text-[0.8125rem]` in web-kit first
   (`shell.tsx`, `MetricCard`, `EmptyState`, `PageHeader`), then let page owners follow. Decide one
   `<h2>` style for in-page sections.
10. **[EV] Event layout `<h1>`** should use `text-h2` like `PageHeader`, and its breadcrumb should be
    `PageHeader`'s breadcrumbs (same size, same separator). Align tab labels with page headings
    (Commerce vs "Add-ons & bundles"; the 4 offline pages' `text-lg` headings).
11. **[CAL] Replace the 35 raw palette colours** in `cinemas/[id]/schedule/*` with tokens
    (`text-text-muted`, `bg-tint-warning`, `text-status-success`, ...) so the schedule works in dark mode.
    Add breadcrumbs to Live, Schedule and Override history.
12. **[DS][ADM] Nav label hygiene:** sentence case everywhere; make nav labels and page titles
    match (3c); give the three Pricing rules items distinct icons.
13. **[DS] Loading accessibility:** give `Spinner` an optional label and `role="status"` for
    full-page use, starting with `OrgProvider`'s gate.

### P3 - polish

14. **[ADM]** Settle Payouts vs Settlements wording; drop the duplicate "Back to refunds" button.
15. **[CAL][EV]** Swap hand-rolled empties and "Loading..." text for `EmptyState` / `Skeleton`
    (gate, attendees, movies detail, admin settings, admin tax-rules).
16. **[all]** ASCII sweep of user-visible copy (em-dashes in titles, curly apostrophes, `[ellipsis]`, `[arrow]`, `[middle dot]`).
17. **[DS]** Consolidate the page root spacing (`space-y-6`) and decide whether `PageHeader` owns
    the gap below it (`mb-8`) or the page does.
18. **[CAL]** Merge or clearly separate `/organizer/cinemas` and `/organizer/venues` (two lists of spaces).

---

## Status after the ux-shell workstream (2026-10-09)

What the design-system / shell / dashboard PRs closed from section 8. Everything not listed
here is still open and belongs to the owner named in section 8.

| Item                                                     | Status                                                                                                                                                                                                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1.1 every organizer route reachable and marked          | Done. Grouped sidebar; `match` prefixes cover `/organizer/cinemas` and `/organizer/spaces`; Check-in (`/organizer/gate`) is now in the owner/manager nav. `components/organizer-nav.test.ts` walks `app/organizer` and fails if a page has no way in. |
| P1.2 sidebar accessibility                               | Done. Labelled nav, `<ul>` lists, labelled groups, one `aria-current` (longest href wins), drawer is a dialog with focus in, Tab trap, Escape and focus return.                                                                                       |
| P2.7 segmented control                                   | Done for the dashboard: `SegmentedControl` in web-kit is a radiogroup; the market switch uses it. Admin reports tabs are still [ADM].                                                                                                                 |
| P2.8 dashboard                                           | Done. Skeleton matches the loaded layout; one "Create event" in the header plus the empty state; the by-market table is a focusable scroll region (axe `scrollable-region-focusable` was failing at 390px). Not yet shared with admin.                |
| Dashboard wash badges                                    | Done. `needs-attention.tsx` uses `bg-tint-*`.                                                                                                                                                                                                         |
| P1.3 `/8` classes, `Notice` primitive, `ErrorState` wash | Open. `ErrorState` lives in `components.tsx`, outside this workstream's files.                                                                                                                                                                        |
| Check-in staff landing page                              | Open. Staff still land on `/organizer`, which is not in their two-item nav.                                                                                                                                                                           |
| Page titles vs the new nav labels                        | Open. The sidebar says "Venues & seating" (owner's label); the venues page title and breadcrumbs still say "Venues & spaces".                                                                                                                         |

---

## Appendix - organizer route checklist for the new sidebar

Every path the organizer app serves under `/organizer` (50 page files; dynamic segments in brackets):

```
/organizer
/organizer/onboarding
/organizer/events
/organizer/events/new
/organizer/events/[id]
/organizer/events/[id]/{sessions,tickets,commerce,orders,attendees,promote,checkin,
                        command-center,devices,preflight,reconciliation,reports,assistant,edit}
/organizer/venues
/organizer/cinemas
/organizer/cinemas/new
/organizer/cinemas/[id]
/organizer/cinemas/[id]/{onboarding,readiness,schedule,live,reports}
/organizer/cinemas/[id]/screens/[screenId]/seatmap
/organizer/cinemas/[id]/screens/[screenId]/layouts
/organizer/cinemas/[id]/screens/[screenId]/layouts/[layoutId]/preview
/organizer/spaces/[screenId]/layouts
/organizer/spaces/[screenId]/layouts/[layoutId]/preview
/organizer/bookings
/organizer/bookings/[bookingId]/print      (no shell, by design)
/organizer/counter
/organizer/promotions
/organizer/movies                          (nav item only when the org has a film)
/organizer/movies/new
/organizer/movies/[id]
/organizer/finance
/organizer/payouts
/organizer/receipts
/organizer/refunds
/organizer/notifications
/organizer/team
/organizer/premium
/organizer/help
/organizer/settings
/organizer/gate                            (nav item only for check-in staff today)
```

Outside the shell: `/`, `/login`, `/start`, `/invite/[token]`.
