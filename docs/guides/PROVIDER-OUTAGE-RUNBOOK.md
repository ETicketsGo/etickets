# Provider Outage Runbook

Operational procedures for payment provider degradation. All controls live in the
admin API under `/admin/payments/outage/*` (and the Payment Config / Outage admin
pages). Every action is audited.

> **Failover safety rules (non-negotiable)**
>
> - `createPayment` failover happens **before** any irreversible authorization/
>   capture (capture is confirmed later via a signed webhook), so it can never
>   double-charge. This is the only automatic failover.
> - **Refunds never fail over** — they have provider affinity and go only to the
>   gateway that captured the payment.
> - Never fail over an operation after a provider **may have captured** unless the
>   provider status is known (idempotent/getPayment-verified).
> - Every failover decision is recorded (`PAYMENT_FAILOVER*` audit events) and
>   alerts operations; the original provider attempt is preserved on the payment.

---

## Signals

| Signal               | Where                                                        |
| -------------------- | ------------------------------------------------------------ |
| Provider degraded    | `etg_payment_webhooks_total`, provider health, circuit state |
| Provider unavailable | Circuit breaker OPEN (`/admin/payments/outage/status`)       |
| Webhook delay        | Rising unconfirmed PROCESSING payments                       |
| Reconciliation delay | Discrepancy aging report (`/admin/payments/finance/aging`)   |
| Refund outage        | Refund failures / RefundStatus FAILED spikes                 |

---

## Scenarios

### 1. Provider degraded (elevated errors/latency)

1. Check `/admin/payments/outage/status` for the provider's circuit state.
2. If a configured failover provider exists for the route, **activate failover**:
   `POST /admin/payments/outage/provider/:provider/failover { "activate": true }`
   (forces the circuit OPEN — new intents route to the failover). Safe: pre-capture.
3. Monitor. When the provider recovers, **roll back**: `{ "activate": false }`.

### 2. Provider unavailable (hard outage)

1. Activate failover (as above) for the affected provider.
2. If no failover exists for a route, **suspend that route or country** so intents
   fail fast with a clear error rather than hang:
   `POST /admin/payments/outage/country/:country/suspend { "suspended": true }`.
3. Communicate; resume when healthy.

### 3. Webhook delay

- Do **not** confirm bookings manually. Settlement must come from a verified
  webhook. Rely on idempotent re-delivery; monitor the reconciliation queue.

### 4. Reconciliation delay

- Run detection: `POST /admin/payments/finance/detect`. Triage the queue; assign
  and resolve. Never auto-correct financial records.

### 5. Refund outage

- Refunds are provider-affine and do not fail over. If the provider's refund API
  is down, refunds stay queued/FAILED; retry after recovery. Do not reroute a
  refund to another provider.

### 6. Full pause

- **Maintenance mode**: `POST /admin/payments/outage/maintenance { "enabled": true,
"message": "..." }`. This is also a payment-live readiness blocker.

---

## Rollback checklist

- Circuit reset (failover rolled back) for recovered providers.
- Suspended routes/countries/providers resumed.
- Maintenance mode off.
- Reconciliation queue drained; readiness (`/admin/payments/live-readiness`) green.
