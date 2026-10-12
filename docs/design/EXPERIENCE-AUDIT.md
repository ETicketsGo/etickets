# Experience audit: customer, organizer, admin (QA, 2026-10-12)

The evidence behind [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md). Functional tests pass on every page
named here; this is about whether the product looks and feels like a serious international
ticketing platform. It does not yet.

- **Environment:** QA as deployed on 2026-10-12 (storefront https://qa.eticketsgo.com, organizer
  https://organizer-qa.eticketsgo.com, admin https://admin-qa.eticketsgo.com), seeded test logins.
- **Method:** Playwright screenshots at 1440, 1024 and 390 px (390 as a touch device), light
  theme, full page plus a first-screen ("fold") shot of each home page; then every screenshot
  read by eye. 111 screenshots. Admin sign-in did not ask for an MFA code, so all three admin
  pages were captured.
- **Screenshots:** `C:\etg-wt\k-shots\design\before\` (outside the repository; paths below are
  relative to it). Scripts: `C:\etg-wt\k-scratch\d1-audit\`.
- **Writes on QA:** none except two ticket holds on Riverbend Jazz Night (1 x Open seating each)
  taken to the Review & pay page to see it; Pay was never pressed and the holds expired on their
  own after 10 minutes. Nothing was saved in the organizer create flow.
- **Note on full-page shots:** fixed elements (the phone tab bar, the console sidebar, sticky
  bars) are drawn where the first screen ended. That is the screenshot, not a defect.

Each problem: what is on screen, why it damages trust or conversion, and the principle in the
design system that fixes it.

## Customer storefront

**C1. The catalogue looks empty and fake.** `cust-events-nocity-1440.png`,
`cust-explore-1440.png`, `cust-home-1440.png`. On Browse, 12 of 15 cards are pastel squares with
one grey letter ("P", "O", "R", "D"). Titles and venues include "Move Me 1791478771263", "Demo
Arena Basketball 1791478546007", "Demo Arena E2E 1791478622052, Boise"; truncation makes several
cards identical ("Demo Arena End Stage..."). _Why it hurts:_ the first thing a buyer sees says
nobody is selling anything here; a letter tile communicates "unfinished", not "event". _Fix:_
imagery standard (DESIGN-SYSTEM section 6): a photo or the event's own title set as artwork,
never a letter; titles clamp at two lines so they stay distinct; QA content hygiene and the
showcase catalogue for review screenshots.

**C2. The phone's first screen sells nothing.** `cust-home-390-fold.png`. The whole first screen
is a generic hero box ("Discover events worth showing up for", "Find your next experience", a
search field cut to "Search events, a", six chips); the location reads "United Sta..." and the
header spends space on an "English" select. No event, date or price is visible until after a
scroll. _Why it hurts:_ people buy experiences; a page that opens on a slogan and a form has
nothing to desire. _Fix:_ the storefront is a stage: an image-led hero of a real event with its
date and price and one Book action, search on its own full-width row, the city always readable,
language moved to the account menu and footer (sections 5 and 7).

**C3. Location and currency scope leak.** `cust-movie-detail-1440.png`,
`cust-event-detail-1440.png`. With "United States" selected, one film lists "Pilot Boise ... $250.00"
beside "Pilot Screen ... Hyderabad ... Rs 250"; "You might also like" on a Boise jazz night offers
Bengaluru and Mumbai events in rupees. _Why it hurts:_ a buyer cannot tell what "near me" means
or what they will be charged; mixed currencies on one page read as an error. _Fix:_ the city is a
first-class frame in the top bar on every page; anything outside it is labelled with its city and
its currency in a separate, titled group (sections 5 and 9). The scoping rule itself is product
logic and is listed for the slice engineers, not changed here.

**C4. On a phone, buying is below the story.** `cust-event-detail-390.png`. The first screen has
the photo, the title and the organizer, but no price and no Buy button. "Select tickets" comes
after "About this event" (which on QA opens with "QA demo content - not a real event."); the
quantity controls are small native selects reading "0"; the date panel says "13 Nov 2026, 7:30 pm"
with no zone while Sessions says "(GMT-7)". _Why it hurts:_ every extra scroll between desire and
"Book" loses buyers; an unzoned time on an international platform is a missed show waiting to
happen. _Fix:_ "which date, which seats, how much" is one decision near the top, with a sticky
booking bar (price, count, Continue) on phones; 44px steppers; venue time with zone
(sections 4, 7, 9).

**C5. No identity: a blue SaaS template.** `cust-home-1440.png`, `cust-account-tickets-390.png`,
`cust-search-empty-1440.png`. Blue primary, pastel category tags, rounded white cards in a
uniform grid, a centred hero in a white box: it could be any product. The ticket wallet is
pastel bands with no image and a stray hyphen before the date ("- 30 Oct 2026, 6:00 pm"); a
floating "Feedback" pill covers content on every page, including Review & pay. _Why it hurts:_
the brand is what a buyer trusts with a payment; a generic template feels like a reseller.
_Fix:_ one brand: warm paper, ink, one marigold light, a distinctive display face, editorial
section rhythm instead of one grid (sections 1-3); utilities like Feedback live in the footer or
account menu, never over content.

Also seen: fr-CA home is mostly English below the header (`cust-home-frCA-1440-fold.png`; the
event page is translated well); seat pages are plain and the cinema grid clips at 390
(`cust-movie-seats-390-fold.png`); the 390 stepper shows numbers without labels.

Keep: the fee breakdown before checkout (`cust-ticket-select-1440.png`), the hold countdown and
refund terms on Review & pay, French money and date formats where translated, empty states with
a way out, the phone tab bar, the seat grid's keyboard help.

## Organizer console

**O1. Two brands, and the rejected template.** `org-overview-1440-fold.png`,
`org-events-1440.png`, `org-create-event-step2-1440.png`. Navy sidebar, teal buttons (the
storefront is blue), pastel icon tiles on every card; events without a picture show a third
placeholder style (dark teal with an icon), and the wizard preview a fourth (a mint "Y" tile).
_Why it hurts:_ an organizer sees a different company from the one their buyers see, and the
console reads as an admin template, not a product they would pay a fee to. _Fix:_ the console is
a desk: same paper and ink as the storefront, a light sidebar with a marigold current-item bar,
no tiles, one no-image artwork shared with the storefront (sections 1, 4, 5, 6).

**O2. The first screen is a wall of alarms and counts.** `org-overview-1440.png`,
`org-overview-390-fold.png`. A red "Needs action (13)", four quick-action tiles, four stat tiles
each with two or three lines of explanation, then calendar, Today, activity, sales and a market
table. On a phone the theme switch takes prime header space and there is no Create button.
_Why it hurts:_ when everything is loud nothing is; an organizer cannot see in five seconds
"am I selling, am I getting paid, what must I do". _Fix:_ numbers are the hero (`text-brand-figure`,
tabular), one line of context each, at most one list of actions ordered by cost, colour only
for state (sections 1, 2, 4).

**O3. The layout breaks at 1024.** `org-overview-1024-fold.png`. Quick actions truncate to
"Create e... / Start a ne...", "Ctrl K" wraps onto two lines, Create event collapses to an
unlabeled "+". _Why it hurts:_ 1024 is a laptop and a tablet in landscape, a common organizer
screen; a broken layout reads as unfinished software. _Fix:_ responsive rules: content-sized
controls, no fixed-width labels, the primary action keeps its words at every width (section 7).

**O4. Money pages do not feel certain.** `org-finance-1440.png`. Four tiles followed by a separate
"Settled by your payment provider" block, labels written as long sentences, a visible "Needs
attention: An event appears in two payment routes at once. We are checking it.", and a payable
date of 23 Mar 2027 for a show in October 2026. _Why it hurts:_ money is where an organizer
decides whether to trust the platform; prose and visible doubt make them reach for a
spreadsheet. _Fix:_ a figure, a short label, an explanation one tap away; dates and states in
words with semantic pills; one place for "what you will be paid and when" (sections 2, 4). The
underlying figures are frozen finance code and are not changed by design work.

**O5. Test data and system values on the page; the list leads with dead events.**
`org-events-1440.png`, `org-event-detail-1440.png`, `org-calendar-1440.png`. The events list
opens with "QA Cert Concert 1791808240670" and three Cancelled "K-TEST" events; live events start
on the second row, each with two status pills. The event page shows "Fee handling: CUSTOMER PAYS"
and the same destinations three times (tabs, tiles, a "Go to" list). The calendar truncates
every title and uses 24-hour time while the storefront uses "7:30 pm" and dates show US
"10/12/2026" for an India organizer. _Why it hurts:_ raw values and repetition make the console
feel like a database viewer. _Fix:_ sort by what needs attention (selling soon, then drafts,
then past), human labels for every enum, one navigation per page, one date and time format per
locale (sections 4, 9).

Keep: the create flow's illustrated choices and live "What buyers will see" preview, "Needs
action" with one fix link per item, venue time plus "for you" time, compact phone event cards.

## Admin console

**A1. Counts disagree on one screen.** `admin-dashboard-1440.png`. "39 failed payments in the
last 7 days ... No action needed" while the Payment failures tile says 35 and the market table
India 35 + US 40; "Total bookings 84 ... in INR" while the table lists 84 INR + 1 CAD + 43 USD.
_Why it hurts:_ an operator who catches one wrong number stops believing all of them. _Fix:_ one
number, one source, its period and currency in the label; per-currency figures never summed
(sections 2, 9). Listed as a data defect for the admin owner; not changed here.

**A2. Colour as decoration.** `admin-dashboard-1440-fold.png`. The "Go to" panel is eight links
in eight tints (green, blue, purple, amber, violet, pink) with no meaning, competing with "Needs
you"; the sidebar is nine all-caps collapsed groups. _Why it hurts:_ colour that means nothing
trains people to ignore the colour that does (the red "Urgent"). _Fix:_ colour is information:
neutral navigation, status colours only for state, groups as eyebrows (sections 1, 5).

**A3. Raw system data in finance.** `admin-finance-reconciliation-1440.png`. "Amount differs:
internal 165036 vs provider 0" (minor units) beside "Rs 1,650.36"; "Provider status is
'CANCELLED' but internal is SUCCEEDED"; every row "Ignored" under a triage title; all ageing
tiles 0. _Why it hurts:_ reconciliation is where errors cost money; unformatted values invite
misreading. _Fix:_ money always formatted in its currency and tabular; statuses as words in
pills; an empty queue says it is clear (sections 2, 4).

**A4. Times contradict each other.** `admin-dashboard-1440.png`. "QA Test Screening 7:30 AM -
10:00 AM GMT-6" under a subtitle promising venue time, while the organizer console shows the
same show as "19:00 - 21:30 GMT+5:30". _Why it hurts:_ support staff will tell a customer the
wrong time. _Fix:_ venue time with zone, viewer time as a secondary line, one format per locale
(section 9).

**A5. The approval queue lacks what a reviewer needs.** `admin-events-1440.png`. Rows have title,
organizer, city, category, country, date and an all-caps "UNDER REVIEW" pill; no image, no price,
no action on the row; an event dated 17 Sept 2026 (past) is still waiting; a large "Group by"
panel sits above a three-row table. _Why it hurts:_ approval is the platform's quality gate; a
reviewer who cannot see the listing as buyers will cannot judge it. _Fix:_ queue rows show the
artwork, title, price range and the buyer-facing preview, with the decision on the row; past
items flagged (sections 4, 6).

Also seen: the phone dashboard spends 40% of the first screen on a greeting card
(`admin-dashboard-390-fold.png`); recent activity is mostly "Auth login" noise.

Keep: "Needs you" ordered by cost with a CLEAR row, "Platform health" with the environment named,
the footer badge "Test environment - payments are simulated."

## What this audit does not cover

Customer dark theme (the storefront has none); the French home at 1024 and 390; a film booking to
the payment step (the seat grid was opened, no seats chosen, to avoid a second kind of hold).
