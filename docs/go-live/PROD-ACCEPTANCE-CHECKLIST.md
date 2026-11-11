# Signed-in production acceptance checklist

For: the owner (or a named staff member), signed in to production. About 20 minutes.
Closes PROD-V1 and GATE-4 in [LAUNCH-TRACKER.md](LAUNCH-TRACKER.md).

**Do not:** generate, mark paid or mark failed any payout; verify or reject a bank account;
approve an identity; release a settlement; buy a ticket; admit a ticket at the door.
Look only. If a button would change something, stop and do not press it.

Write PASS or FAIL next to each line, with the date and who checked. If something fails, take a
screenshot and record the page address and the time.

## 1. Admin console: sign-in, profile, permissions (admin.eticketsgo.com)

- [ ] Sign in with password. The console asks for the authenticator code before it shows any page.
- [ ] After the code, the console opens. The profile menu shows your name and role.
- [ ] Sign out, then open `/admin/payouts` directly. You land on the sign-in page (no endless spinner).
- [ ] Sign in again. Open **Staff**. You are listed as super admin. Note who holds the second
      account (bank verifier). If it is you, write that down: it must not be used to get round the
      verify/pay rule (see FOUNDER-OPERATED-CONTROLS.md). Change nothing.
- [ ] As super admin, open Organizers, Events, Refunds, Payouts and Settlements: every page opens
      (no "you do not have that duty" message).

## 2. Admin Payouts and Settlements

- [ ] **Payouts** description reads: "Manual settlements: organizers paid by bank transfer…".
- [ ] The list loads (it may be empty: production has no payouts yet). Any row on hold shows its
      reason under the status and "On hold" instead of **Mark paid**.
- [ ] **Payouts → Bank accounts** tab loads; account numbers are masked.
- [ ] **Settlements** description reads: "Automatic provider transfers (Stripe Connect, Razorpay
      Route)… While automatic payouts are switched off a release is refused and nothing is sent".
- [ ] **Organizers → (an organizer) → Legal identity** card shows its status; do not approve.

## 3. Organizer Payouts page (organizer.eticketsgo.com)

Use one India organizer and one US organizer you are allowed to sign in to.

- [ ] India organizer, **Payouts**: shows the bank account state (verified / under review / add one)
      and "Automatic payouts: not enabled". It does not say payouts are automatic.
- [ ] US organizer, **Payouts**: without a verified US bank account it says "Add a bank account to
      get paid"; with one it says "Manual settlements: active" and "Automatic payouts (Stripe
      transfers): not enabled. Nothing is needed from you."
- [ ] Neither page shows another organizer's figures or accounts.

## 4. Organizer check-in door screen

Use a real phone or tablet if one is available (this also starts GATE-2).

- [ ] Open **Gate** (`/organizer/gate`). "Choose a show…" lists the organizer's shows.
- [ ] Pick a show. **Scan with camera** and the ticket number field are both visible.
- [ ] Press **Scan with camera**; the browser asks for camera permission and the preview appears.
      Close it without scanning a ticket.
- [ ] Do not type or scan a real ticket number (that would admit it).

## 5. Record the result

Put the outcome in LAUNCH-TRACKER.md: PROD-V1 (sections 1-3) and GATE-4 (section 4), with the
date and the checker's name. Any FAIL becomes a new open item.
