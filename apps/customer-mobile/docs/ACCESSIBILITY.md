# Accessibility

## Implemented

**Touch targets.** Every interactive element clears 44pt. `Button` enforces
`minHeight: 44` independently of its padding, so a visually small button is still
reachable rather than conflating "compact" with "hard to hit"; `IconButton` is 44×44;
small chips add `hitSlop`.

**Dynamic Type.** `Text` scales with the OS setting, capped per variant — headings at
1.4–1.6×, body at 2×. Nothing is capped below 1.3×, so the common "large text" settings
are honoured in full. The cap exists because accessibility sizes go past 300%, which
turns a two-line card title into a full screen and pushes the price out of view.

**Screen-reader labels.** Cards announce as one sentence rather than four fragments — an
event card reads its title, category, venue, time and price together, because a screen
reader otherwise delivers four disconnected stops the user has to reassemble. Seats
announce as "Seat A12, Premium, available". Decorative icons are hidden.

**Roles and state.** `accessibilityRole` throughout; `accessibilityState.selected` on
chips and seats; `accessibilityState.busy` on loading buttons, so a screen reader
announces the wait instead of silently ignoring taps; `accessibilityRole="alert"` on
validation messages and the offline notice; `accessibilityLiveRegion="polite"` on the
hold countdown and the seat-selection summary.

**Adjustable control.** The quantity stepper is a single `adjustable` element with
`accessibilityValue`, so it responds to swipe up/down rather than making the user find
two separate buttons.

**A non-graphical seat picker.** `SeatListView` presents the seat map row by row. This is
the accessibility answer to a pinch-zoom grid of 80 unlabelled squares, which is close to
unusable read linearly and has sub-minimum tap targets when zoomed to fit. It is offered
to everyone through a visible toggle rather than hidden behind a screen-reader check — it
is genuinely faster for "two seats together at the back", and it works with switch
control and a keyboard.

**Colour is never the only signal.** Seat states differ in border weight and fill as well
as hue, and the list view states each one in words. Selection is carried in
`accessibilityState`, not just colour. Roughly one man in twelve cannot reliably separate
the red "sold" from the green "available".

**Dark mode** follows the device. The QR plate stays white regardless — a dark code on a
dark card is the classic scanner failure.

**Modal semantics.** Sheets use React Native's `Modal`, so both platforms trap focus and
announce a dialog. A hand-rolled absolutely-positioned sheet leaves the screen behind it
focusable, which is how a screen-reader user ends up reading content they cannot see.

## Not verified

**No VoiceOver or TalkBack pass has been run.** There is no device or emulator in this
environment. Everything above is implemented from the platform guidance and is unverified
in practice. Read this as "built for accessibility, not yet tested for it".

Also outstanding:

- No contrast audit against WCAG ratios.
- RTL layout untested.
- No reduce-motion handling on the seat-map and skeleton animations.
- Font scaling not visually checked at the largest accessibility sizes.
- No keyboard-navigation pass (relevant for Android with a physical keyboard, and for
  the web preview).
