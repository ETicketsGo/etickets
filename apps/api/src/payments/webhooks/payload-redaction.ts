/**
 * Payment-provider webhook payloads, minus the payer.
 *
 * `WebhookEvent.payload` used to keep the provider's whole event object for ever. A Razorpay
 * payment event carries the payer's email, phone, UPI address and card details (last 4 digits,
 * network, issuer); a Stripe event carries `billing_details`, `customer_details`, the card's
 * fingerprint and, for a connected account, the organizer's business profile. None of that is
 * read by anything: the processors act on ids, amounts, currency, status, error codes and our
 * own `notes` / `metadata`, which hold internal ids only (see razorpay-payment.provider.ts).
 *
 * So the personal fields are replaced before the row is written, and the processor reads the
 * redacted copy exactly as it read the full one. What stays is what reconciliation, refunds,
 * disputes and idempotency need:
 *   - provider ids (payment, order, refund, dispute, transfer, charge, intent, session, account)
 *   - amounts, currency, status, timestamps, error codes and reasons
 *   - `acquirer_data` (RRN / bank transaction reference) - the id a bank asks for in a dispute
 *   - our own `notes` / `metadata` / `receipt` / `client_reference_id`
 * and `payloadHash` (SHA-256 of the raw signed body) still proves what was received.
 *
 * A DENY list rather than an allow list, deliberately: an allow list that missed one field the
 * processor reads would silently stop confirming paid bookings. The deny list can only ever
 * remove a field nothing reads, and the tests pin both directions.
 */
export const REDACTED = '[redacted]';

/** Keys (matched case-insensitively, at any depth) whose whole value is personal data. */
const PERSONAL_KEYS = new Set(
  [
    // identity and contact
    'email',
    'contact',
    'phone',
    'name',
    'customer_email',
    'customer_name',
    'customer_phone',
    'receipt_email',
    'beneficiary_name',
    'address',
    'shipping',
    'shipping_details',
    'billing_details',
    'customer_details',
    'custom_fields',
    // payment instruments
    'card',
    'vpa',
    'upi',
    'bank_account',
    'account_number',
    'payment_method_details',
    'payment_method_preview',
    // connected-account owner (Stripe `account.updated`)
    'individual',
    'company',
    'business_profile',
    'external_accounts',
    'representative',
    // device
    'ip',
    'ip_address',
    'client_ip',
    'user_agent',
  ].map((k) => k.toLowerCase()),
);

export function isPersonalKey(key: string): boolean {
  return PERSONAL_KEYS.has(key.toLowerCase());
}

/**
 * A copy of `value` with every personal field replaced by {@link REDACTED}. Null and absent
 * values stay as they are, so "the provider sent no email" and "we removed the email" remain
 * distinguishable. Idempotent: redacting a redacted payload changes nothing.
 */
export function redactProviderPayload<T>(value: T): T {
  return redact(value, 0) as T;
}

function redact(value: unknown, depth: number): unknown {
  // Provider events are shallow (well under 10 levels); the bound only stops a pathological
  // payload from recursing without end.
  if (depth > 32 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isPersonalKey(k) && v !== null && v !== undefined ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

/** True when the payload still holds a personal field (used by the backfill and its report). */
export function holdsPersonalData(value: unknown, depth = 0): boolean {
  if (depth > 32 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => holdsPersonalData(v, depth + 1));
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isPersonalKey(k) && v !== null && v !== undefined && v !== REDACTED) return true;
    if (holdsPersonalData(v, depth + 1)) return true;
  }
  return false;
}
