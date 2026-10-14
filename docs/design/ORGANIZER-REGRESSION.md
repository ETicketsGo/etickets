# Organizer regression: what broke, where, and the fix

Status: organizer recovery, October 2026 (branch `fix/organizer-recovery`). The owner rejected the
organizer console on QA as hard to navigate, inconsistent, poorly organized and less presentable
than earlier versions. This file names each regression, the change that caused it, and the fix.
It is a recovery of quality and consistency inside the approved brand system
([DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md): paper, ink, marigold; Bricolage titles; Inter text; the
"desk"), not a new redesign.

Evidence: before shots `C:\etg-wt\k-shots\org-recovery\before\`, after shots
`C:\etg-wt\k-shots\org-recovery\after\`, both against real QA data.

## Last acceptable baseline

main at `eb4534b` (#310, before the brand slices #352/#355). Its palette (navy sidebar, teal
accent, pastel tiles) is superseded and is NOT restored, but it had the three properties the
owner is missing now: one palette from sidebar to page, an icon on every sidebar row, and pages
that used the same components. The recovery keeps the brand and restores those properties.

## Regressions

| #   | Regression                                                                                                                                                                                                               | Caused by                                                                                                                                                                                                         | Fix                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Two-level folding sidebar.** Four collapsible groups, then a second disclosure under Overview, Events, Bookings, Finance and Settings. Notifications was two clicks deep (Workspace, then Overview).                   | `041abeb3` (#281) put pages under parents in `components/organizer-nav.ts`; `b60c2484` (#289) made groups fold, only the current one open, in `packages/web-kit/src/sidebar-nav.tsx`.                             | The desk sidebar is one flat list (`DeskNavList`): every top-level page always visible, in the owner's order, under three labels that cannot be clicked. Secondary pages are the tabs of their section (`SectionTabs`). Admin keeps its classic tree.                                                               |
| 2   | **Sidebar rows lost their icons**, so the list was words in boxes and the collapsed rail was a row of anonymous group buttons with flyouts.                                                                              | `98b35d8d` (#355) "The desk: words without icons" in `sidebar-nav.tsx`.                                                                                                                                           | Every row has its icon in one 18px column, one row height. The collapsed rail is one icon link per page with its name as a tooltip on hover and keyboard focus; no flyouts.                                                                                                                                         |
| 3   | **Two palettes on one screen.** The shell and Overview were paper and ink; every other page was the classic navy/teal console (blue-white cards, teal buttons and tints). Dark mode: a charcoal frame around navy cards. | `98b35d8d` (#355) moved only the shell and Overview to `brand-*` tokens; pages kept `bg-background-*` / `bg-action-primary`, which `:root[data-console]` in `tokens.css` (`8df223a4`, #295) paints navy and teal. | `packages/design-tokens/src/console-bridge.css`: inside `data-brand="console"` the classic token names resolve to the brand tokens (surfaces, text, lines, states, radii, flat cards, the display face). Every page inherits the brand at once; an organization's chosen accent (`data-accent`) is still respected. |
| 4   | **Dark mode was near-black everywhere.** Page, card and inset at 7%, 10.5% and 14% lightness: cards had no visible edge.                                                                                                 | `358bf332` (#352) console dark block in `packages/design-tokens/src/brand.css`.                                                                                                                                   | Lifted to 9.5 / 13.5 / 17.5% with hairlines at 23%, tints lifted to match. `token-contrast.test.ts` still passes every pair (414 tests).                                                                                                                                                                            |
| 5   | **Pastel tiles and gradients inside the desk**: icon tiles, and a navy-to-teal glow on every event card without a picture.                                                                                               | `8df223a4` (#295) `--tile-*` tokens and the `ImageFrame` placeholder in `packages/web-kit/src/primitives.tsx`.                                                                                                    | The bridge maps every tile to the inset colour with ink-2, and hides the placeholder glow (`data-placeholder-glow`); the placeholder is a quiet inset with a grey icon.                                                                                                                                             |
| 6   | **Layout widths disagreed.** Overview capped at 1280px inside a 1536px frame; Get started a centred 896px column; Team a 2:1 split that left the invite form floating.                                                   | `98b35d8d` (#355) `max-w-brand-console` on Overview; `5e6132a0` `max-w-4xl` on onboarding; Team's `lg:grid-cols-3`.                                                                                               | One width, the shell's. Pages that need a side panel use one rule: main column plus a 20-22rem panel from `xl`, stacked below it.                                                                                                                                                                                   |
| 7   | **Notifications was a 9,000px card wall.** One card per cause at the size of a blocking problem; "Nothing new here" followed by an unexplained "Show earlier (12)".                                                      | `c7db4e41` (#258) `GroupCard` layout in `app/organizer/notifications/page.tsx`.                                                                                                                                   | One list: filters (All, Unread, each subject) with counts, action required first, compact rows with unread dot, severity in words, time, context and the action on the row; each subject shows five and says how many more; read rows are behind "Show N read items". Same data, same read/unread calls.            |
| 8   | **Get started said everything twice**: a progress checklist, then six cards re-deriving the same steps (two always "Done"), then five template cards and two more cards.                                                 | `5e6132a0` onboarding page; the server action list (#222) was added beside the cards rather than replacing them.                                                                                                  | One list from the server's action list: required steps with progress, then optional ones, one action each. Templates, payouts, a sample draft event and help are short rows beside it. "Get started" left the sidebar: a "Finish setup, 3 of 4 done" link sits at the top of the sidebar until setup is done.       |
| 9   | **Team showed role codes** ("ORGANIZER MANAGER"), wrapped emails mid-word, and explained only the selected role.                                                                                                         | Team page since #96; never moved to the desk.                                                                                                                                                                     | Member column (name with email under it), readable role, status pill (Active / Invitation pending with the invite link), date added; all three roles explained beside the invite form.                                                                                                                              |
| 10  | **Overview's Needs you was one column of 13** with optional steps mixed in by count only.                                                                                                                                | `98b35d8d` (#355) `NeedsYou`.                                                                                                                                                                                     | The next step first, then "Also blocking" and "Warnings" as named groups with counts; optional steps are a link to Get started. Added "Best sellers" (analytics `topEvents`) and "Recent activity" (the notification feed); an empty Coming up offers "Create your first event".                                    |

Not regressions but worth knowing: #360 lengthened two labels ("Receipts and invoices",
"Premium & enterprise") to match their page titles; they are now tabs, where the length costs
nothing.

## Rules the recovery enforces

1. One palette in the organizer: the brand console tokens, light and dark, through the bridge.
   No page-specific colours, gradients or pastel tiles.
2. Surfaces: canvas (page), surface (card, hairline, no shadow), sunken (inset, table header,
   filter bar). The one overlay shadow is for things that float.
3. One sidebar: flat, iconned, fixed order, labels not buttons, no folding; secondary pages are
   tabs; Ctrl/Cmd+K finds everything.
4. One content width (the shell's), and one side-panel rule (main + 20-22rem from `xl`).
5. Page title in Bricolage at the console size; everything else Inter; status as words in pills.
6. Every number from an existing API field; nothing computed across currencies.

## Rollout (owner approved the baseline on #368)

Every organizer route was then brought onto the baseline and checked in a real browser against
QA data (51 routes x 1440 light, 1440 dark, 1024, 390, 320; screenshots in
`C:\etg-wt\k-shots\org-recovery
ollout\`). Most pages needed no layout change: they already
used the shared PageHeader, DataTable, Card, form fields, Badge and EmptyState, and the bridge
gives those the brand. What was changed:

- **Toasts, tooltips and menus** render outside the desk (portalled to `<body>`), so they kept
  the navy/teal console colours. `data-brand="console"` now sits on the organizer `<body>`, so every
  surface - including sign-in, invite and print - reads the brand tokens.
- **One width rule**: the seat-map editor, layout preview, cinema detail and Help were centred
  672-896px columns inside a 1144px page; they now use the shell width. Single forms (new cinema,
  new movie) and the door scanner keep a form measure, aligned to the page's left edge with
  every other page rather than floating in the middle.
- **Seat map, dark mode**: seat numbers were drawn in the category's own colour, which failed
  contrast on charcoal (axe, 72 nodes). The colour is now the seat's edge only.
- **Cinema bulk scheduler and copy schedule** used raw Tailwind slate/amber/green/red; now the
  semantic tokens, so they follow the theme.
- **Promotion**: the share link field and the email template had no accessible name / were not
  keyboard-scrollable (axe).
- **Settings**: the default workspace colour was labelled "ETicketsGo teal" and showed a teal
  swatch; the desk default is ink, so it says so.
- **Event overview** printed the fee mode as a code ("CUSTOMER PAYS"); now "Customer pays".
- **Team**: email addresses wrap at "@" and dots instead of mid-word.
- **Finance (F4)**: "Held until shows finish" said "before fees and refunds", but the figure
  (`heldRevenue` in the payout service) already subtracts completed refunds. It now says "Ticket
  sales after refunds, before fees". Label only.
- **Cinema readiness (F3)**: the compliance summary told a cinema whose local body, format and
  climate type ARE set to "set its local body, format and climate type" (the server returns
  INVALID_CINEMA_CLASSIFICATION also when a seat category has no regulatory class). When the same
  response shows all three set, the panel now says to check the seat-class mapping. Wording only;
  the server's sentence is unchanged and still wrong for API clients (follow-up for the API).

Known and accepted: the buyer-facing previews in the create-event wizard keep the storefront's
gradient fallback on purpose (they show what a buyer will see). `ClassicNavTree` keeps unused
desk branches until admin adopts the desk.
