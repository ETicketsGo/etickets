# ETicketsGo — Refund Policy (DRAFT)

> ⚠️ **DRAFT / TEMPLATE — NOT LEGAL ADVICE.** Reflects the platform's actual refund engine
> ([refund-eligibility.ts](../../apps/api/src/refunds/refund-eligibility.ts)). Confirm the
> commercial policy and consumer-law requirements with counsel before publishing.

## How refunds work on ETicketsGo

Refund eligibility is enforced by a deterministic rule:

1. **Booking must be in a refundable state** — a confirmed, un-cancelled booking. Already
   cancelled/refunded bookings are not eligible.
2. **Within the refund window** — refunds are allowed up to a cut-off before the session
   starts. The **default window is 48 hours** before the session; Organizers may set a
   different policy per event (`refundPolicy`).
3. After the window, or once entry has occurred, tickets are non-refundable unless the
   Organizer or law requires otherwise.

Approved refunds are processed back to the original payment method through the payment
provider. Platform/processing fees may be **[refundable / non-refundable — confirm]**.

## Requesting a refund

- **Customers:** request from your booking/tickets page; the request is validated against
  the rule above and routed to the Organizer/platform for processing.
- **Organizers:** review and process refund requests from the finance/refunds console;
  status transitions (REQUESTED → PROCESSING → COMPLETED/REJECTED) are auditable and
  idempotent.

## Event cancellation or change

If an Organizer cancels or materially changes an event, [describe the platform's handling —
e.g., automatic full refunds]. This is **[to be finalized]**.

## Chargebacks & disputes

Disputes are handled per the payment provider's process and the platform's reconciliation
workflow. Fraudulent chargebacks may result in account action.

## Contact

Refund questions: [support email] — see [SUPPORT-WORKFLOWS.md](SUPPORT-WORKFLOWS.md) and the
[FAQ](FAQ.md).

---

_Fee-refundability and cancellation handling require a commercial decision. Do not publish
as-is._
