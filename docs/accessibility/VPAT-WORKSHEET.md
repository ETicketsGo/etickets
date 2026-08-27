# VPAT worksheet — evidence, not a conformance claim

> **This is not a VPAT.** A VPAT (Voluntary Product Accessibility Template) becomes an
> Accessibility Conformance Report when somebody signs their name to the conformance levels
> in it. That signature is a legal representation about a product, it is relied on by
> purchasers, and it is not something to be generated from a test run.
>
> What this file is: the evidence an auditor and the owner need in order to fill one in, with
> the automated portion already established and the rest marked as open. Every row below that
> says **`Needs evaluation`** means exactly that — nobody has looked yet.

Standard: **WCAG 2.1 Level AA** — the level referenced by Quebec/Canadian procurement
(EN 301 549 via CAN/ASC-EN 301 549) and by US Section 508.

---

## Scope of the product

| Component                            | In scope            | Why                                                                                      |
| ------------------------------------ | ------------------- | ---------------------------------------------------------------------------------------- |
| Customer storefront (`customer-web`) | **Yes**             | Public-facing commerce; the surface a claim would concern                                |
| Organizer console (`organizer-web`)  | **Yes**             | Sold to business customers, who procure against a VPAT                                   |
| Admin console (`admin-web`)          | Internal            | Staff-only; still swept, but not a procurement surface                                   |
| Customer mobile (`customer-mobile`)  | **Yes, separately** | Native app; WCAG does not map cleanly — see `apps/customer-mobile/docs/ACCESSIBILITY.md` |
| Emails, receipts, tickets (PDF/HTML) | **Yes**             | Consumer-facing documents; **not covered by any automated check today**                  |

The email, receipt and ticket documents are worth flagging to the auditor early. They are the
artefacts a customer actually keeps, nothing scans them, and PDF accessibility (tagging,
reading order) is its own specialism.

---

## Success criteria

`Automated` means axe-core asserts it on all 67 routes and the build fails otherwise.
`Needs evaluation` means no one has assessed it.

### Perceivable

| SC     | Name                      | Level | Status                       | Evidence / note                                                                                                                                                                                                              |
| ------ | ------------------------- | ----- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1.1  | Non-text Content          | A     | Partly automated             | axe finds _missing_ alt; whether alt is accurate is unassessed. The seat map and QR codes need a human.                                                                                                                      |
| 1.2.x  | Time-based Media          | A/AA  | **Not applicable — confirm** | No audio or video is served today. If marketing adds a hero video this flips.                                                                                                                                                |
| 1.3.1  | Info and Relationships    | A     | Partly automated             | Landmarks, lists, table headers and form labels are asserted. Whether the _seat map_ conveys its structure non-visually is unassessed and is the single biggest open question.                                               |
| 1.3.2  | Meaningful Sequence       | A     | **Needs evaluation**         |                                                                                                                                                                                                                              |
| 1.3.3  | Sensory Characteristics   | A     | **Needs evaluation**         | Seat availability is currently conveyed by colour **and** by an accessible name; check the rest.                                                                                                                             |
| 1.3.4  | Orientation               | AA    | **Needs evaluation**         |                                                                                                                                                                                                                              |
| 1.3.5  | Identify Input Purpose    | AA    | **Needs evaluation**         | `autocomplete` tokens on the checkout and profile forms have not been reviewed.                                                                                                                                              |
| 1.4.1  | Use of Colour             | A     | Partly automated             | `link-in-text-block` is asserted. Chart and seat-map colour coding is unassessed.                                                                                                                                            |
| 1.4.3  | Contrast (Minimum)        | AA    | **Automated**                | axe on 67 routes **and** `token-contrast.test.ts` over every declared pair, both themes.                                                                                                                                     |
| 1.4.4  | Resize Text               | AA    | **Needs evaluation**         |                                                                                                                                                                                                                              |
| 1.4.5  | Images of Text            | AA    | **Needs evaluation**         |                                                                                                                                                                                                                              |
| 1.4.10 | Reflow                    | AA    | **Automated**                | 320px asserted on seven routes including French; the page must not scroll in two directions. Found and fixed a header that was 685px wide in a 320px viewport. The seat map and the schedule week-view are still unassessed. |
| 1.4.11 | Non-text Contrast         | AA    | Partly automated             | Control boundaries asserted via `--border-input`; focus indicator asserted; seat-map states unassessed.                                                                                                                      |
| 1.4.12 | Text Spacing              | AA    | **Needs evaluation**         |                                                                                                                                                                                                                              |
| 1.4.13 | Content on Hover or Focus | AA    | **Needs evaluation**         | Tooltips and the account menu.                                                                                                                                                                                               |

### Operable

| SC          | Name                    | Level | Status                  | Evidence / note                                                                                                                                                                                                           |
| ----------- | ----------------------- | ----- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1.1       | Keyboard                | A     | Partly automated        | A booking can now be driven from ticket selection to the checkout with real Tab and Enter presses (`accessibility-judgement.spec.ts`). Payment itself, seat selection and dialogs are still unassessed.                   |
| 2.1.2       | No Keyboard Trap        | A     | **Needs evaluation**    | Dialogs are the risk.                                                                                                                                                                                                     |
| 2.1.4       | Character Key Shortcuts | A     | **Needs evaluation**    |                                                                                                                                                                                                                           |
| 2.2.1       | Timing Adjustable       | A     | **Addressed — confirm** | Was a plain failure. The hold can now be extended: a warning at two minutes, one button, ten extensions, bounded so inventory cannot be held indefinitely. An auditor should confirm the bound and the warning threshold. |
| 2.2.2       | Pause, Stop, Hide       | A     | **Needs evaluation**    | Skeleton pulses, carousels.                                                                                                                                                                                               |
| 2.3.1       | Three Flashes           | A     | **Needs evaluation**    |                                                                                                                                                                                                                           |
| 2.4.1       | Bypass Blocks           | A     | Partly automated        | A "Skip to content" link exists and is asserted present.                                                                                                                                                                  |
| 2.4.2       | Page Titled             | A     | **Automated**           | `document-title` on 67 routes.                                                                                                                                                                                            |
| 2.4.3       | Focus Order             | A     | **Needs evaluation**    |                                                                                                                                                                                                                           |
| 2.4.4       | Link Purpose            | A     | Partly automated        | axe catches empty links; "Read more" style links need a human.                                                                                                                                                            |
| 2.4.5       | Multiple Ways           | AA    | **Needs evaluation**    |                                                                                                                                                                                                                           |
| 2.4.6       | Headings and Labels     | AA    | Partly automated        | Presence asserted; descriptiveness unassessed.                                                                                                                                                                            |
| 2.4.7       | Focus Visible           | AA    | Partly automated        | Focus ring contrast asserted in `token-contrast.test.ts`; whether it is visible on every control is unassessed.                                                                                                           |
| 2.5.1–2.5.4 | Pointer                 | A     | **Needs evaluation**    | Seat map drag-select.                                                                                                                                                                                                     |
| 2.5.3       | Label in Name           | A     | **Needs evaluation**    | Matters for voice control; several buttons have an `aria-label` richer than the visible text.                                                                                                                             |

### Understandable

| SC            | Name                                   | Level | Status               | Evidence / note                                                                                                                   |
| ------------- | -------------------------------------- | ----- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 3.1.1         | Language of Page                       | A     | **Automated**        | `html-has-lang` on 67 routes. **Re-check when French ships** — the attribute must follow the rendered language, not be hardcoded. |
| 3.1.2         | Language of Parts                      | AA    | **Needs evaluation** | Becomes live with French.                                                                                                         |
| 3.2.1 / 3.2.2 | On Focus / On Input                    | A     | **Needs evaluation** |                                                                                                                                   |
| 3.2.3 / 3.2.4 | Consistent Navigation / Identification | AA    | **Needs evaluation** |                                                                                                                                   |
| 3.3.1         | Error Identification                   | A     | Partly automated     | `aria-invalid` and `aria-describedby` wiring is asserted; message quality is unassessed.                                          |
| 3.3.2         | Labels or Instructions                 | A     | **Automated**        | Every form control has a programmatic label.                                                                                      |
| 3.3.3         | Error Suggestion                       | AA    | **Needs evaluation** |                                                                                                                                   |
| 3.3.4         | Error Prevention (Legal, Financial)    | AA    | **Needs evaluation** | Applies directly: this product takes payments. Review/confirm/reverse.                                                            |

### Robust

| SC    | Name              | Level | Status               | Evidence / note                                                                                                                |
| ----- | ----------------- | ----- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 4.1.2 | Name, Role, Value | A     | Partly automated     | ARIA validity is asserted — this is how the silent `aria-label`-on-a-div loading state was found. Custom widgets need a human. |
| 4.1.3 | Status Messages   | AA    | **Needs evaluation** | Toasts, seat-taken notices and the payment result. Partly addressed by `role="status"` on loading states.                      |

---

## Suggested brief for the auditor

Ordered by where a real user is most likely to be blocked, not by criterion number:

1. **Book a ticket end to end with a screen reader**, and complete the PAYMENT step by
   keyboard. Reaching the checkout is now covered; what happens after it is not, and seat
   selection — a grid of custom controls the product does not work without — is untouched.
2. **The seat map without sight.** The largest open question, and nothing automated can
   answer it.
3. **Confirm the hold-extension design** (SC 2.2.1). Implemented rather than open now: a
   warning at two minutes, one button, ten extensions. Whether ten is right, and whether the
   warning comes early enough, is a judgement we should not make alone.
4. **Reflow on the seat map and the schedule week-view.** The storefront is asserted at
   320px; those two are the likely failures and are not.
5. **The receipt, the ticket and the confirmation email** — no tool here scans them.
6. Everything else marked _Needs evaluation_.

## What to do with the findings

They become work, tracked like any other. Where a finding is a _rule_ rather than an
instance, add it to `token-contrast.test.ts` or `accessibility-sweep.spec.ts` so it cannot
come back — the contrast history in `tokens.css` is three rounds of fixing the same class of
bug one instance at a time, which is what those two files exist to stop.
