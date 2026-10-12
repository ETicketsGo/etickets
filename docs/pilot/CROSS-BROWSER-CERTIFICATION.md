# Cross-browser storefront certification (customer-web)

Date: 2026-10-12. Environment: QA storefront https://qa.eticketsgo.com (deployed main 3ef1b51 per the lead) and a local
production build of this branch (customer-web `next start` on :3111, API on :4111, seed data). Engines: Playwright 1.62
chromium 1234/1243, firefox 1538, webkit 2336 (WebKit 26.5), all on Windows. Screenshots: `C:\etg-wt\k-shots\k-browser\`.

The owner's screenshots did not reach us, so this is a from-scratch sweep, not a reproduction of a specific report.

## Findings

| #   | Finding                                                                                                                                                                                             | Class                                  | Root cause                                                                                                                                                                                                   | Status                                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Signed-in header scrolls the page sideways from 1024px to 1279px (up to 253px); the account menu and language switcher are pushed off screen. 3px overflow at exactly 1280px in WebKit. All engines | REAL DEFECT                            | `components/header.tsx`: seven icon+label links show from `lg` (1024px), and a signed-in header needs about 1280px with every label. It never showed in a signed-out sweep                                   | FIXED: labels are icon-only until `xl` (base links) / `2xl` (account links); each link has `aria-label` + `title`. Verified 0px overflow at 1024/1100/1180/1280/1366/1440/1536/1920 in all 3 engines, English and fr-CA |
| 2   | False "A new version of ETicketsGo is available. Reload" banner on a first visit in WebKit (4 of 6 fresh profiles on QA), covering the bottom navigation                                            | REAL DEFECT                            | `components/sw-register.tsx`: the worker calls `skipWaiting()` on first install; WebKit reports the controller before the `installed` event, so "installed and a controller exists" was read as an update    | FIXED: ask whether the page already had a controller when it loaded. 0 of 10 fresh profiles show it locally in all 3 engines. Still present on QA until deployed                                                        |
| 3   | Sports/Community chip order and the first free-event card differed between engine runs                                                                                                              | ENVIRONMENT                            | Live QA data changed between runs (tie in category counts, new events). A repeat run showed identical output in all engines                                                                                  | No change                                                                                                                                                                                                               |
| 4   | WebKit headings and buttons look lighter than Chromium/Firefox                                                                                                                                      | LIKELY RENDERING VARIANCE (UNVERIFIED) | Computed `font-weight` (700/600) and the loaded Inter variable font face are identical in all three engines; Playwright's Windows WebKit draws variable-weight fonts lighter. Needs a real Safari to confirm | BLOCKED for Safari; no code change                                                                                                                                                                                      |
| 5   | Firefox only: `next dev` shows "SyntaxError: unterminated regular expression literal" (layout.tsx, via web-kit safe-next) and renders nothing                                                       | ENVIRONMENT (dev server only)          | Production build is clean in Firefox and QA is fine; not investigated further                                                                                                                                | Not fixed; use a production build for Firefox checks                                                                                                                                                                    |
| 6   | WebKit: body computed style momentarily empty (`rgba(0,0,0,0)`, `-webkit-standard`) in 3 of 210 measurements, screenshots rendered correctly                                                        | UNEXPLAINED, INTERMITTENT              | Measurement taken during a document swap is the likely cause                                                                                                                                                 | Not reproduced; logged                                                                                                                                                                                                  |
| 7   | City filter: Boise 3 images, Mumbai 5 images; location text "United States"                                                                                                                         | ENVIRONMENT                            | Location state (geo/cookie) legitimately changes what discovery shows; identical across engines                                                                                                              | No change                                                                                                                                                                                                               |
| 8   | Customer site ignores `prefers-color-scheme: dark`                                                                                                                                                  | ACCEPTABLE                             | Light-only design (same body colours in dark in all engines)                                                                                                                                                 | No change                                                                                                                                                                                                               |
| 9   | Native `<select>` and city datalist look different per browser                                                                                                                                      | ACCEPTABLE                             | Native controls                                                                                                                                                                                              | No change                                                                                                                                                                                                               |

Other checks, all consistent across engines: fonts (Inter variable woff2 loaded, no `error` faces, same computed
family), broken images 0 on QA (a no-image event shows the lettered placeholder), sticky header (`position: sticky`,
61px) everywhere, focus ring visible (2px/3px outline) in all three. Keyboard Tab skips links in WebKit by browser design.

Caching and provenance (QA, 2026-10-12): HTML `no-store`; `/_next/static/*` and fonts `public, max-age=31536000,
immutable` (hashed); `sw.js`, manifest, icons `public, max-age=0` with ETag. No deployed commit or build id is exposed in
a header or meta tag, so "which build is this browser on" cannot be answered from the page (limitation; the lead's
`verify-deployed.mjs` is the only source). The service worker precaches only offline.html, manifest and icon, so it
does not serve stale pages after a deploy.

## Matrix (page x engine x viewport)

Viewports: m390 (DPR 3), t768 (DPR 2), l1280 (DPR 1), d1440 (DPR 1), d1920x2 (DPR 2). Metrics per cell: horizontal
scroll, overflowing boxes, broken images, failed fonts, page errors. Raw data: `guest-results.json`, `dark-results.json`,
`city-results.json`, `auth-results.json` in the screenshot folder.

| Area                                                                                         | Engines x viewports                       | PASS                  | FAIL       | BLOCKED                                                  |
| -------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------- | ---------- | -------------------------------------------------------- |
| Guest: home, events, movies, explore, event (no image), event (image), movie, light          | 3 x 5 x 7 = 105                           | 105                   | 0          | 0                                                        |
| Guest, `prefers-color-scheme: dark`                                                          | 105                                       | 105                   | 0          | 0                                                        |
| Discovery with a city (Boise, Mumbai)                                                        | 3 x 5 x 2 = 30                            | 30                    | 0          | 0                                                        |
| Signed-in (customer1): login, home, event, ticket select, booking/payment entry (no payment) | 3 x 4 widths (390/768/1280/1440) x 5 = 60 | 59                    | 1          | 0                                                        |
| Signed-in header width sweep (1024-1920) before fix                                          | 3 engines                                 | 0                     | 3          | 0                                                        |
| Signed-in header width sweep after fix (local build)                                         | 3 engines x 10 widths, EN + fr-CA         | all                   | 0          | 0                                                        |
| First-visit update banner, 6 fresh profiles per engine                                       | 3                                         | 2 (chromium, firefox) | 1 (webkit) | 0                                                        |
| Zoom 90/110/125 % (chromium, emulated): home, events, event                                  | 9                                         | 9                     | 0          | 0                                                        |
| Real Safari / iOS / Android devices                                                          | -                                         | 0                     | 0          | BLOCKED (not available; Playwright WebKit is not Safari) |

The five signed-in FAILs are WebKit at 1280px (3px sideways scroll on every step, finding 1). Matrix FAIL cells for findings 1 and 2 were
re-run after the fix on the local production build and pass; QA still shows both until a deploy. The booking-entry step
created a held (unpaid) booking for customer1 on QA per run, 13 in total; they expire unpaid.

## Reusable check

`node scripts/qa-cross-browser/run.mjs [--base URL] [--out DIR] [--engines a,b]` is read-only and refuses any host except
localhost, 127.0.0.1 and qa.eticketsgo.com. Run on QA now it reports 77 PASS and 1 FAIL (the WebKit first-visit banner,
finding 2, fixed in this branch but not deployed). Against local seed data it flags 1-3 "broken" images per page: one seed
event image is a 64-byte fixture that does not decode; this is test data, not a defect.

## Limitations

- No real Safari, iOS, Android or Windows-Chrome-on-another-machine runs; DPR and zoom are emulated.
- Pixel-level font weight in WebKit (finding 4) is unverified.
- The fix is not deployed; QA still exhibits findings 1 and 2.
- No automated unit regression for the header or service-worker banner; the script covers the banner, and the
  header width sweep was run ad hoc (the script does not sign in by design).
