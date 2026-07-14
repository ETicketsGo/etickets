# ETicketsGo — UX & Accessibility Review

_Scope: UX/a11y only. No backend, API, data-flow, routing, or architecture changes.
All fixes reuse existing `@eticketsgo/web-kit` primitives and `@eticketsgo/design-tokens`.
No new dependencies and no new design-system components were added._

This sprint targeted the concrete gaps the prior review flagged on the **newer** surfaces
(tech-debt register **D16** seat map, **D17** movie trailer) plus two named consistency
touch-ups. An earlier polish pass already gave the older surfaces skeletons, empty/error
states, toasts, and focus rings, and gave the shared `Dialog` a focus trap + overflow
scroll — this review credits that work rather than re-claiming it.

## Legend

- **OK** — already meets the bar; no change made.
- **Fixed-this-sprint** — a gap the prior review flagged, addressed here.
- **Deferred-with-reason** — real but out of scope for a reuse-only UX/a11y sprint.

The bars assessed per surface: loading / empty / error / success feedback, responsive
layout, keyboard operability, focus visibility, animation restraint, typography &
spacing consistency, and **colour-not-alone**.

---

## Changes made this sprint

| #   | Surface                 | File                                               | Change                                                                                                                                                                                                                                                                                           |
| --- | ----------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Seat selection (D16)    | `apps/customer-web/app/shows/[sessionId]/page.tsx` | Non-colour affordances for SOLD (`×`) and HELD (clock) seats; luminance-aware readable text on selected swatch + persistent token-coloured selected ring; larger mobile touch targets (`h-9 w-9 sm:h-7 sm:w-7`); legend split into Available / Selected / Sold / Held with matching affordances. |
| 2   | Movie detail (D17)      | `apps/customer-web/app/movies/[slug]/page.tsx`     | "Watch trailer" affordance (reuses `Button`, opens `trailerUrl` in a new tab) shown only when present; poster fallback now reuses `gradientFor(movie.id)` instead of a bare icon on an empty box.                                                                                                |
| 3   | Movies list             | `apps/customer-web/app/movies/page.tsx`            | Replaced ad-hoc `N movie(s)` with proper singular/plural (`1 movie` / `N movies`).                                                                                                                                                                                                               |
| 4   | Following (empty state) | `apps/customer-web/app/account/following/page.tsx` | Replaced two raw underlined text links with the `ButtonLink` primitive, matching the empty-state CTA pattern used on Explore / Saved.                                                                                                                                                            |

### Seat e2e selector — preserved

The e2e selects seats via `button[aria-label^="Seat"][aria-label*="available" i]`. All of
the following are unchanged:

- Each seat is still a real `<button type="button">`.
- The `aria-label` format is byte-for-byte the same:
  `` `Seat ${seat.label}${priceLabel ? `, ${priceLabel}` : ''}, ${seat.status.toLowerCase()}` ``
  → e.g. `Seat A12, ₹300, available`. SOLD/HELD lowercase to `sold`/`held`, neither of
  which contains the substring `available`, so only bookable seats match the selector.
- `aria-pressed={isSelected}` is retained.
- Unavailable seats keep the native `disabled` attribute (still present in the a11y tree,
  announced as unavailable). Only the available seats the test clicks are enabled, so the
  selector still resolves to clickable elements. The new SOLD/HELD glyphs are icon-only
  children (`aria-hidden`) and do not alter the label.

`npm run typecheck` and `npm run build` for `@eticketsgo/customer-web` both pass. Only
customer-web files were touched, so organizer/admin were not rebuilt.

---

## Customer surfaces

### Movies list (`/movies`)

- Loading: OK — 8-tile aspect-ratio skeleton grid.
- Empty: OK — `EmptyState` with "clear filters" hint.
- Error: OK — `ErrorState` with retry.
- Success/count: **Fixed-this-sprint** — result count now pluralizes correctly.
- Responsive: OK — 2/3/4-col grid; search form collapses to one column.
- Keyboard/focus: OK — cards are `Link`s with visible focus rings; form controls from web-kit.
- Colour-not-alone: OK.

### Movie detail (`/movies/[slug]`)

- Loading/empty/error: OK — pulse skeleton; not-found `EmptyState`; `ErrorState` with retry.
- Trailer: **Fixed-this-sprint** (D17) — `trailerUrl` was captured but never surfaced; a
  "Watch trailer" `Button` now opens it in a new tab when present.
- Poster fallback: **Fixed-this-sprint** — empty hero now uses the deterministic
  `gradientFor` wash (consistent with `movie-card.tsx`) behind the film icon.
- Showtime chips: OK — real `Link`s, descriptive `aria-label`, focus rings.
- Responsive/typography: OK — `220px` poster column collapses on mobile; `h1`/`h2` scale.

### Seat selection (`/shows/[sessionId]`) — D16

- Loading/empty/error: OK — pulse skeleton; `EmptyState` for no-map; `ErrorState` with retry.
- Colour-not-alone: **Fixed-this-sprint** — SOLD seats now carry an `×`, HELD seats a clock
  glyph (distinct shapes, not just grey). Legend split into **Available** (price tiers) /
  **Selected** (ring) / **Sold** (`×`) / **Held** (clock), each with the same affordance the
  seat uses. Sold/Held legend rows render only when those statuses exist.
- Selected-seat contrast: **Fixed-this-sprint** — the old forced `text-white` over an
  arbitrary category swatch could be unreadable on a light swatch. Foreground is now computed
  from swatch luminance (dark `--text-primary` on light swatches, white on dark), and a
  persistent `ring-2 ring-action-primary` ring means selection is never conveyed by fill alone.
- Touch targets: **Fixed-this-sprint** — seats are `h-9 w-9` on mobile, `sm:h-7 sm:w-7` on
  larger screens; the `overflow-x-auto` section container still scrolls horizontally.
- Keyboard/focus: OK — real `<button>`s, `aria-pressed`, `focus-visible` ring retained;
  disabled seats stay perceivable to screen readers.
- Summary panel: OK — sticky on desktop, live total with correct pluralization.

### Explore (`/explore`)

- Loading/empty/error: OK — per-section skeletons; `EmptyState` with `ButtonLink` CTAs;
  `ErrorState` with retry. Client-only sections (recently viewed, continue exploring) hide
  when empty to avoid hydration mismatch.
- Consistency: OK — already uses `ButtonLink` for hero/section CTAs and correct pluralization
  in spotlight tiles.
- Responsive/keyboard/focus: OK — responsive grids; category chips are focusable links.

### Following (`/account/following`)

- Loading/empty/error: OK — count-aware skeletons; `EmptyState`; `ErrorState` retries all.
- Empty-state CTA: **Fixed-this-sprint** — raw underlined links replaced with `ButtonLink`.
- Colour-not-alone: OK — verified badge pairs the icon with an `aria-label`.

### Booking / Payment (`/booking/[id]/payment`)

- Loading/error/feedback: OK — skeleton, `ErrorState`, toasts; `Stepper` shows progress.
- Keyboard/focus/responsive: OK — web-kit form primitives and focus rings.

### Confirmation (`/booking/[id]/confirmation`)

- States: OK — pulse skeleton, `ErrorState` retry, success/pending branch with `StatusBadge`.
- Colour-not-alone: OK — status carries `StatusBadge` text; success uses a check glyph.
- Success animation: `animate-scale-in` on the confirmation checkmark — see Deferred note on
  reduced-motion.
- Minor: the "`N ticket(s)`" string uses ad-hoc pluralization. **Deferred** — outside the
  named newer-surface consistency scope for this sprint; low impact.

### Ticket / QR / Wallet (`/account/tickets`, `/account/tickets/[ticketId]`)

- Loading/error: OK — `Skeleton`, `ErrorState` retry, auth redirect guard.
- QR robustness: OK — `alt` text on the QR image plus an inline SVG `onError` fallback.
- Colour-not-alone: OK — status `Timeline` marks done steps with a `✓` and numbers, not just
  colour; wishlist heart uses `aria-pressed` + `aria-label`.
- Actions: OK — calendar/directions/venue are real links with focus rings; external links use
  `target="_blank" rel="noreferrer"`.
- Countdown: OK — `tabular-nums`, `aria`-safe.
- QR "pulse" glow: decorative `animate-pulse` — see Deferred reduced-motion note.

### Reviews / Wishlist

- Wishlist (`/account/saved`): OK — skeleton, `EmptyState` with `ButtonLink`, heart toggle
  with `aria-pressed`/`aria-label` and toast feedback.
- Reviews: the only rating affordance is `RatingStars` on the confirmation screen (labelled,
  keyboard-operable). There is no standalone reviews surface in the customer app; nothing to
  fix. **OK / N-A**.

---

## Organizer surfaces

### Movies (`/organizer/movies`, `/movies/new`, `/movies/[id]`)

- States/feedback: OK — list/detail use `Skeleton`/`ErrorState`/`EmptyState` and toasts;
  create/edit forms validate with inline `role="alert"` messages.
- Keyboard/focus/responsive: OK — web-kit `Input`/`Button`/`Card`.

### Cinemas (`/organizer/cinemas`, `/cinemas/[id]`, `/cinemas/new`)

- States/feedback: OK — consistent skeleton/error/empty and toasts.

### Seat-map authoring (`/organizer/cinemas/[id]/screens/[screenId]/seatmap`)

- States: OK — `Skeleton`, `ErrorState` retry; empty state is the generator form.
- Validation: OK — section-by-section inline validation via `role="alert"`.
- Colour-not-alone: **Deferred-with-reason** — the authoring preview swatches are decorative
  and non-interactive (they only echo the categories the organizer just defined, which are
  also labelled with name + price in the legend), so the customer-facing D16 fix was not
  mirrored here. The preview conveys nothing by colour that isn't also in text. Revisit only
  if this preview gains SOLD/HELD status rendering.

### Shows / sessions (`/organizer/events/[id]/sessions`, `/tickets`, `/checkin`)

- States/feedback: OK — skeleton/error/empty, toasts; check-in has scan feedback.

---

## Admin surfaces

### Movies (`/admin/movies`)

- States: OK — `Skeleton`/`ErrorState`/`EmptyState`; table via shared `DataTable`.
- Keyboard/focus/responsive: OK.

### Analytics / dashboard (`/admin`)

- Loading: OK — 8 `Skeleton` metric placeholders.
- Error/empty: OK — `ErrorState` retry; `EmptyState` for empty audit feed.
- Metric tiles: OK — `MetricCard` `tone` is a decorative accent; every tile still carries a
  text label and value, so meaning is never colour-only.
- Tables: OK — sortable `DataTable` headers; values are text, `StatusBadge` pairs colour with
  a label.
- Responsive: OK — `sm:grid-cols-2 lg:grid-cols-4` tile grid.

---

## Deferred items (with reasons)

1. **`prefers-reduced-motion` support** — several decorative animations exist
   (`animate-scale-in` on the confirmation check, the `animate-pulse` glow behind the ticket
   QR, movie-card hover lift). Honouring reduced-motion cleanly belongs in a shared token /
   global-CSS layer (a `@media (prefers-reduced-motion: reduce)` rule or a web-kit utility),
   which is a design-system change beyond this reuse-only sprint. Low harm today (animations
   are brief and non-blocking); recommended as a small follow-up in `design-tokens`/globals.
2. **Confirmation "`N ticket(s)`" pluralization** — same class as the movies-list fix but on
   an older, already-polished surface outside the named newer-surface scope. Trivial when
   picked up.
3. **Seat-map authoring preview colour affordances** — intentionally not changed; the preview
   is non-interactive and fully labelled in text (see Organizer › Seat-map authoring).

## Verification

- `npm run typecheck --workspace @eticketsgo/customer-web` — passes.
- `npm run build --workspace @eticketsgo/customer-web` — passes (all 15 routes compile).
- Only `apps/customer-web` files changed; the seat `aria-label`/`aria-pressed`/`<button>`
  contract the e2e depends on is preserved (see "Seat e2e selector — preserved" above).
