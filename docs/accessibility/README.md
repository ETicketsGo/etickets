# Accessibility

## Where this stands

ETicketsGo runs two automated checks on every change, and **has not had a formal audit**.
Those are different things and this file exists so nobody confuses them.

|                               | What it covers                                                                        | Status                                     |
| ----------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------ |
| `token-contrast.test.ts`      | Every colour pair the design system declares, both themes, computed from `tokens.css` | 63 assertions, green                       |
| `accessibility-sweep.spec.ts` | axe-core WCAG 2.1 A + AA on all 67 routes of the three web apps                       | green                                      |
| **Formal audit**              | Everything below that automation cannot reach                                         | **not started**                            |
| **VPAT / ACR**                | A published conformance claim                                                         | **not produced** — see `VPAT-WORKSHEET.md` |

## What automated testing does not establish

This is the part that matters, and it is the reason a clean sweep is not a conformance claim.

axe-core, run well, catches somewhere around **a third** of WCAG 2.1 AA failures. It is very
good at things that are true or false about the DOM, and structurally unable to judge
anything requiring a human reading the page. It cannot tell you:

- whether alt text is **accurate** — only that it exists. `alt="image"` passes.
- whether heading levels describe the **actual** structure, or were chosen for their size.
- whether a flow can be **completed** with a keyboard. It checks that things are focusable,
  not that a seat can be picked, a coupon applied and a booking paid for without a mouse.
- whether focus order is **sensible**, or whether focus is **trapped** in a dialog and
  **returned** when it closes.
- whether an error message says what went wrong and how to fix it.
- whether anything is **announced** at the moment it changes — a seat becoming unavailable,
  a payment succeeding, a hold expiring.
- whether the seat map, which is the core interaction of this product, is usable at all by
  somebody who cannot see it.
- anything about **time limits**, and this product has a booking hold that expires.
- whether content **reflows** at 320px and 400% zoom without loss.

Every one of those is in scope for an audit and none of them is covered here.

## Known judgement calls

Recorded so an auditor sees the reasoning rather than rediscovering it.

- **Decorative gradients are held away from body text.** `GradientBackdrop` and the CTA band
  wash darken the effective background below what `--text-muted` can survive. Sections with a
  wash use `--text-secondary` as their smallest text colour. `--text-muted` remains valid on
  the three flat surfaces it was tuned against.
- **`--border-default` is decoration and is deliberately faint** (1.24:1). WCAG 1.4.11 applies
  to controls, so form fields and outline buttons use `--border-input` at 3:1+ instead. If an
  auditor disagrees about a specific divider, that is a finding worth having.
- **The badge/pill family uses opaque tints**, never an alpha wash of its own foreground. A
  wash takes its contrast from whatever is behind it, so the same badge measured 4.50:1 on a
  card and 4.12:1 on a tinted section. Opaque backgrounds make each pair a fixed, assertable
  number.

## Adding a route

Add it to `apps/e2e/tests/accessibility-sweep.spec.ts`. If a rule genuinely does not apply to
a page, write down why **in this file** — do not remove the route from the sweep. A route
quietly dropped is indistinguishable from a route that passes.

## Running it

```bash
# Contrast, instant, no browser:
npm test --workspace @eticketsgo/design-tokens

# The full sweep — needs api:4000, customer:3000, organizer:3001, admin:3002 and a seeded DB:
npx playwright test tests/accessibility-sweep.spec.ts --workspace @eticketsgo/e2e
```
