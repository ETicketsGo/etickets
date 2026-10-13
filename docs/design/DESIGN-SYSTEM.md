# ETicketsGo design system: a stage and a desk

Status: the direction for the experience reset (October 2026). It supersedes
`DESIGN-DIRECTION.md` (navy sidebar, teal accent, pastel tiles), which the owner rejected.
Evidence for why is in [EXPERIENCE-AUDIT.md](./EXPERIENCE-AUDIT.md). See it before reading:
[specimen at 1440](./specimen/specimen-1440.png), [specimen at 390](./specimen/specimen-390.png),
source [specimen/index.html](./specimen/index.html) (open with `?img=` pointing at the showcase
images; see the comment in its head).

## The idea in one paragraph

One brand, two temperaments. The **customer storefront is a stage**: warm paper, ink type, one
marigold light, and photography doing the shouting. Energy comes from scale, imagery and rhythm,
not from colour or effects. The **organizer and admin consoles are a desk**: the same paper and
ink, denser and quieter, with numbers as the loudest thing on the page and marigold reduced to a
signal (where you are, what is happening today). No gradients, no glows, no tinted cards, no
pastel icon tiles, no navy sidebar. Quality comes from hierarchy, type, composition, imagery and
restraint.

What we learned from others, without copying: BookMyShow and District lead with the poster and
the date strip; Ticketmaster makes "which date, which seats, how much" one decision; Eventbrite
keeps the organizer's money screens plain; premium SaaS (Linear, Stripe) makes the number the
hero and the chrome disappear.

## 1. Colour

Tokens live in `packages/design-tokens/src/brand.css` and resolve only inside `data-brand`.
Tailwind names are `brand-*` (for example `bg-brand-canvas`, `text-brand-ink-2`).

| Token                                            | Light value             | Job                                                  | May NOT be used for                                                    |
| ------------------------------------------------ | ----------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `canvas`                                         | #FBFAF7 warm paper      | the page                                             | cards (cards are `surface`)                                            |
| `surface`                                        | #FFFFFF                 | cards, panels, fields, table bodies                  | the page background                                                    |
| `sunken`                                         | #F2F0EB                 | filter bars, inset panels, image placeholders        | a third card level or a "highlight" card                               |
| `ink`                                            | #171412                 | titles, body text                                    | anything decorative                                                    |
| `ink-2`                                          | #544F4A                 | supporting text, descriptions                        | headings                                                               |
| `ink-3`                                          | #68635E                 | metadata, captions, eyebrows                         | anything a person must read to act                                     |
| `line` / `line-strong`                           | #E5E1DC / #CDC8C1       | hairlines, card edges, chip borders                  | the outline of a field (use `field`)                                   |
| `field`                                          | #878078                 | text field and select outlines (3:1 on all surfaces) | decoration                                                             |
| `action` / `on-action`                           | ink / paper             | the ONE primary button per view                      | links, secondary buttons                                               |
| `marigold` / `on-marigold`                       | #FFBA1A / ink           | the light: action on a stage, "Today", selected seat | text on paper, warnings, large fills, more than one element per region |
| `positive`/`caution`/`critical`/`info` + `-tint` | see brand.css           | a state that happened or needs doing                 | decoration, category colours, chart series                             |
| `focus`                                          | ink (marigold on stage) | the 2px focus ring, 2px offset                       | anything else                                                          |
| `scrim`                                          | near-black              | gradient behind text over a photo, at alpha          | flat backgrounds                                                       |

Rules:

- **Ink is the action on paper; marigold is the action on a stage.** `bg-brand-action` swaps by
  itself, so a slice writes one class.
- **Marigold is never text on paper** (1.6:1) and never a warning. On paper it is a fill that
  always carries ink text (10.7:1) or an ink outline. Caution is burnt orange (22 degrees) and the
  test keeps it at least 15 degrees from marigold (42).
- **No category colours.** Music is not purple and comedy is not orange; the photo is the colour.
- **Charts** (console): ink for the series that matters, `line-strong` for comparison, marigold
  only for "today" or "now". Never a rainbow.

Contrast (measured, enforced by `token-contrast.test.ts` for all four blocks): ink on canvas
17.5:1, ink-2 7.7:1, ink-3 5.2:1 at worst (on sunken), status pills 5.5-6.6:1, field outline
3.4:1 at worst, stage ink-3 6.7:1. Every pair in every block clears WCAG AA.

**Light and dark.** The storefront is **light only**, with a **stage tone** (`data-brand-tone="stage"`)
for dark bands: the hero, a film header, the seat map, "Now showing", the footer. Reasons: the
storefront has no dark mode today (only the consoles ship the toggle); buying is a retail act
where paper reads as trustworthy and receipts, prices and forms are calmer on light; and image-led
bands on stage give the cinematic energy a full dark mode would have given, at a fraction of the QA
surface. The consoles keep light and dark (people work in them all day), driven by the existing
`.dark` class: warm charcoal, never navy, and the primary button inverts to paper-on-charcoal.

## 2. Typography

| Face                                                          | Role                                                                               | Why                                                                                                                                                                                                              |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bricolage Grotesque** (`font-brand-display`), OFL, variable | headlines, event and film titles, card titles, a console page title. Nothing else. | Distinctive without being a costume. Its optical-size axis (12-96) makes it loud at 80px in a hero and calm at 24px on a console, so one family serves both temperaments. Has the rupee sign and French accents. |
| **Inter** (`font-brand-text`), OFL, variable                  | everything a person reads, every label, **every number**                           | Already self-hosted and proven; superb at 13-16px; true tabular figures. Money is always `tabular-nums`.                                                                                                         |

Both are self-hosted from `packages/web-kit/fonts` (no Google request at build or run time), with
latin-ext for the rupee sign and accents. Bricolage is cut by `make-brand-fonts.py`
(width pinned, weight 500-800, latin about 72 KB preloaded + latin-ext about 29 KB on demand).

Type scale (`text-brand-*`, defined in `tokens.ts`; headlines fluid from 390px to 1280px, reading
sizes fixed, weight included in each size):

| Class                  | Size        | Face, weight      | Use                                                                          |
| ---------------------- | ----------- | ----------------- | ---------------------------------------------------------------------------- |
| `text-brand-hero`      | 40 -> 80px  | display 800       | one hero line per page                                                       |
| `text-brand-d1`        | 32 -> 56px  | display 700       | event or film title on its own page                                          |
| `text-brand-d2`        | 24 -> 36px  | display 700       | storefront section heading                                                   |
| `text-brand-d3`        | 20 -> 24px  | display 700       | featured card title, dialog title                                            |
| `text-brand-card`      | 17px        | display 650       | ordinary card title                                                          |
| `text-brand-page`      | 24 -> 28px  | display 650       | console page title (the only display text in a console besides empty states) |
| `text-brand-lead`      | 18px / 1.55 | text 400          | intro paragraph                                                              |
| `text-brand-body`      | 16px / 1.6  | text 400          | reading text (never smaller on a phone)                                      |
| `text-brand-ui`        | 14px / 1.45 | text 400-600      | buttons, nav, table cells, field text                                        |
| `text-brand-meta`      | 13px / 1.4  | text 400          | dates, venues, captions                                                      |
| `text-brand-eyebrow`   | 12px caps   | text 600, +0.08em | section labels, table headers, categories                                    |
| `text-brand-figure`    | 28 -> 36px  | text 600, tabular | the number that IS the content                                               |
| `text-brand-figure-sm` | 20px        | text 600, tabular | totals in a booking bar, table summaries                                     |

Line length 45-70 characters (`max-w-prose`). Titles wrap balanced (`text-balance`) and clamp at
two lines on cards (three for featured). Never set running text in the display face, never set a
headline in Inter bold "because it fits".

## 3. Space, grid, shape, elevation

- **Spacing scale (px):** 4, 8, 12, 16, 24, 32, 48, 64, 96. Nothing in between. Related items 8-12,
  groups 24-32, sections 64 (desktop) / 48 (phone).
- **Customer grid:** 12 columns, `max-w-shell` (1440px), gutters 16 (phone) / 24 (tablet) / 40
  (desktop), column gap 24-32. Sections alternate rhythm (feature + list, rail, poster row); a
  page never shows more than one uniform card grid in a row.
- **Console grid:** 232px sidebar + content up to `max-w-brand-console` (1280px), page gutter 32
  (desktop) / 16 (phone). Forms keep `max-w-form`.
- **Shape:** controls `rounded-brand-control` (10px storefront, 8px console); cards and images
  `rounded-brand-card` (16 / 12); chips and pills `rounded-full`. Nothing else.
- **Elevation: two levels.** Flat (surface + hairline) for everything on the page; one
  `shadow-brand-overlay` for things that float above it (menus, dialogs, the sticky booking bar,
  a toast). Cards do not have shadows and do not lift on hover; images may scale 1.02 on hover.

## 4. Components

Shared pieces live in `packages/web-kit/src/brand.tsx`; everything else is composed from tokens.

- **Buttons** (`BrandButton`, `brandButtonClasses(variant, size)`): `primary` (ink on paper,
  marigold on stage), `secondary` (hairline), `quiet` (text), `marigold` (the single "Book tickets"
  moment on paper). Sizes `sm` 36px (dense console rows only), `md` 44px (default touch target),
  `lg` 48px. Sentence case, a verb ("Book tickets", "Continue to payment"). One primary per view.
- **Inputs:** 44px, `border-brand-field`, label above (14px semibold), hint below in meta, error
  below in `text-brand-critical` with a 2px critical outline and words saying what to do.
- **Chips** (`brandChipClasses(selected)`): 36px pills for filters, dates and cities; selected =
  ink fill + `aria-pressed`. Horizontal scroll on phones, never wrapping into three rows.
- **Status pills** (`BrandStatusPill`): 24px, words always. `live` (marigold) only for Today / On
  sale now / Doors open.
- **Cards:** image (4:3) on top, then eyebrow (category / city), title (`text-brand-card`), one
  meta line (date, venue), and price right-aligned ("From" + amount, tabular). No border on the
  storefront (the photo is the edge); a hairline in the console.
- **Tables (console):** eyebrow headers, 12px cell padding, hairline rows, numbers right-aligned
  and tabular, status as a pill in the last column, row click opens the item. On phones a table
  becomes a list of rows with the two most important facts.
- **Event artwork** (`EventArtwork`): the picture in a fixed-shape box with the focal point, or
  the no-image fallback (below).

## 5. Navigation

- **Customer, desktop:** a 68px paper top bar: wordmark, city button (always visible, opens a
  sheet with search and nearby cities), a wide search field, three links (Explore, Movies,
  Tickets), sign in / account. No mega menu.
- **Customer, phone:** top bar with wordmark + city; the search field on its own row below;
  a **bottom navigation** of four items (Home, Explore, Tickets, Account), 56px plus safe area,
  ink icons with labels, the current item marked by ink weight and a marigold dot. The booking
  flow hides the bottom nav and shows a sticky booking bar instead.
- **Console:** a light sidebar on the canvas (no navy): organization switcher at the top, groups
  as eyebrows (Money, Workspace), items 36px, the current item a white surface pill with a
  hairline and a 3px marigold bar at the edge. The top bar holds the page title, its one primary
  action and the account. On phones the sidebar becomes a sheet behind a menu button; the page
  title and primary action stay visible.

## 6. Event imagery

- **Shapes** (the box decides, never the upload): 16:9 banner (hero, event header), 4:3 card
  (lists, rails), 1:1 thumbnail (console rows, tickets), 2:3 poster (films only). These match
  the API's variants (`card`, `banner`, `thumb`; posters from the movie API).
- **Minimum upload:** 2400px on the long edge for events (the API's `full` copy), 1200x1800 for
  posters. Smaller uploads are accepted but the console should say "may look soft on large
  screens".
- **Focal point:** every crop uses the organizer's focal point (`focalObjectPosition`); a face or
  a stage must survive the 16:9 and the 4:3 crop of the same file.
- **Text on photos:** only on stage bands, only over a `scrim` gradient from the text side, never
  over the focal point. Card titles sit below the photo, not on it.
- **No-image fallback:** the event's own title set in the display face on the stage tone, with
  the category as an eyebrow and a short marigold rule (`EventArtwork`). Never a letter on a
  colour square, never a generic icon tile, never a stock photo standing in for the organizer's.
- **Content:** no demo names, timestamp titles or unexplained placeholders on public pages. The
  showcase catalogue (`scripts/showcase/`) exists so screenshots use believable content.

## 7. Responsive rules

- Design at 390 first, then 768, 1024, 1440. Check 320 for overflow.
- No horizontal page scroll at any width; rails scroll inside themselves with the next card
  peeking (a 42% card width on phones says "there is more").
- Touch targets 44px; spacing between adjacent targets 8px.
- The hero is 520px tall on phones with text at the bottom; 560-640px on desktop with text on
  the left third.
- Prices and dates never truncate; titles clamp.

## 8. Motion

Purposeful only: 120ms for hover/press, 200ms for chips and tabs, 320ms for sheets and dialogs,
easing `cubic-bezier(0.16, 1, 0.3, 1)`. Hero carousels advance only on user action (no
auto-rotate). Seat selection animates the seat fill, nothing else. `prefers-reduced-motion`
removes transforms and keeps opacity changes under 120ms.

## 9. Internationalization

- Dates and times in the **venue's** zone, with the zone shown when it differs from the
  viewer's ("7:30 PM ET"). Day names short ("Sat 21 Nov").
- Money in the venue's currency, formatted by locale: en-IN groups lakhs (Rs 4,82,350 shown with
  the rupee sign), en-US `$12,940.00`, fr-CA `12 940,00 $`. `CA$` on mixed-currency lists.
- fr-CA strings run about 20% longer: buttons hug content, never fixed widths; titles clamp.
- Copy is plain English, ASCII, sentence case (house rule).

## 10. Accessibility

WCAG 2.2 AA is the floor: the contrast test covers every token pair; focus is always visible
(2px ring, 2px offset); states have words; seat maps have a list alternative; images have alt
text written from the event (not "image"); reduced motion respected.

## 11. How to adopt it (the slices)

1. Put `data-brand="customer"` (or `"console"`) on the outermost element you own (the page's
   main wrapper). Inside it, `data-brand-tone="stage"` makes a dark band.
2. Use only `brand-*` colours, `text-brand-*` sizes, `font-brand-display` / `font-brand-text`,
   `rounded-brand-*`, `shadow-brand-overlay`, and the pieces in `web-kit/src/brand.tsx`.
3. Do not mix old tokens (`bg-background-*`, `text-text-*`, `tile-*`, `nav-*`) inside a brand
   element, and do not edit `tokens.css`.
4. `brand.css` is already imported by all three apps; `brandDisplay.variable` is already on
   `<html>` in customer-web and organizer-web (admin-web adds it when admin adopts the system).
