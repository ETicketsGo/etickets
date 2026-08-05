# Payments

## The client never selects a provider

This is the whole design, and it runs the opposite way to a typical payment SDK
integration.

```
POST /bookings/:id/pay
→ { providerRef, clientActionUrl, status }
```

The **server** decides which provider handles a booking — by country, by the organizer's
connected account, by outage failover. It returns one URL. The app follows it.

The app therefore:

- holds **no** publishable or secret key for any provider,
- never names Stripe or Razorpay in client code,
- never branches on a provider identifier.

## How `clientActionUrl` is followed

`src/features/checkout/api.ts` → `followPaymentAction()`.

| Shape                                   | Handling                                | Why                                                                                                                                                  |
| --------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relative (`/api/payments/:id/mock-pay`) | POSTed via `apiClient` with credentials | An action on our own API. In QA this is the mock gateway; no money moves.                                                                            |
| Absolute `https://…`                    | `WebBrowser.openAuthSessionAsync`       | System browser (SFSafariViewController / Custom Tabs): real address bar, real padlock, working autofill and 3-D Secure. A WebView has none of those. |
| Anything else                           | **Refused**                             | The URL arrived over the network. Following an arbitrary scheme would let a spoofed response launch an intent of its choosing.                       |

Tests cover all three plus `http:`, `javascript:`, `intent:` and `file:` rejection.

## Order of operations

1. **Create the booking** — this reserves inventory and produces the authoritative fee
   breakdown.
2. **Then** start the payment.

The screen never computes a total. Platform fees, the payment fee and the organizer's
`feeMode` are all resolved server-side, and a client estimate that disagrees with the
charge is the worst defect this screen could have. Before the booking exists, the UI
shows a **subtotal** and says fees are confirmed at checkout.

## Idempotency

One key per checkout attempt, held in a ref, **reused across retries**. A request that
times out on a mobile connection has quite possibly succeeded server-side; a fresh key
would hold a second set of seats and, after payment, charge twice.

Returning to a checkout with an existing hold reuses that booking rather than creating a
second one.

## Result states, and what the app believes

**A browser returning to the app is not proof of payment.** `openAuthSessionAsync`
resolving `success` means the browser closed, nothing more.

| State                  | Trigger                                       | Behaviour                                                                      |
| ---------------------- | --------------------------------------------- | ------------------------------------------------------------------------------ |
| Completed handoff      | Internal action returned, or browser returned | Navigate to the booking screen, which **re-reads the booking from the API**    |
| Dismissed              | User closed the browser                       | "Payment not completed — tickets held for a few more minutes". Hold survives.  |
| Unsupported            | No URL, or a non-https scheme                 | Explained; nothing followed                                                    |
| Pending                | Booking is `PENDING_PAYMENT` on re-read       | Screen says payment has not arrived and to pull to refresh                     |
| Hold expired           | `holdExpiresAt` passes                        | Countdown fires once, user is told seats were released, returned to selection  |
| App killed mid-payment | —                                             | Booking exists server-side; it appears in the Tickets tab with its real status |

Confirmation is only ever displayed from backend state.

## Seat-level bookings

Reserved seating sends `items: [{ ticketTypeId, quantity, seatIds }]`, with
`seatIds.length === quantity` — the invariant `createBookingSchema` enforces. Seats are
re-validated against a freshly fetched map immediately before the booking call.

## Testing posture

QA runs `PAYMENT_PROVIDER_NAME=mock` with all money automation off and live keys refused.
No real payment credentials are used anywhere in this app or its tests.
