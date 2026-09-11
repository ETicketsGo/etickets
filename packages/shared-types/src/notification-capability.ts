/**
 * What each messaging provider can actually do.
 *
 * ── WHY THIS IS CODE AND NOT A WIKI PAGE ───────────────────────────────────────────
 * These facts were already being relied on, three or four times each, in places that could
 * not see one another. The certification ladder knew push has no delivery receipt. The
 * webhook handler knew MSG91 publishes no signature. The transports knew MSG91 requires an
 * approved template and Twilio does not. Each of those was correct and each was a separate
 * copy, so the day a provider changes — or the day somebody adds a fifth — the copies drift
 * and the disagreement shows up as a message nobody can explain.
 *
 * Written down once, they can be asserted against. The certification service asks this table
 * whether a missing callback is a defect or the expected state of the world, instead of
 * carrying its own list of exceptions.
 *
 * ── WHAT THIS TABLE IS NOT ─────────────────────────────────────────────────────────
 * It is not a claim that a provider is configured, working, or reachable. It describes the
 * provider's PUBLISHED behaviour and what this repository's adapter implements — nothing
 * about our account with them. `false` under `supportsDeliveryReceipt` means "no receipt
 * exists to wait for"; it never means "the receipt is broken".
 *
 * Every entry below is set from the adapter in this repository and the provider's public
 * documentation. Where the two could differ, the adapter wins, because the adapter is what
 * actually runs.
 */

export type NotificationChannelKey = 'email' | 'sms' | 'whatsapp' | 'push' | 'in_app';

export interface ProviderCapability {
  provider: string;
  channel: NotificationChannelKey;
  /**
   * Markets this platform routes to the provider today. `['*']` means the provider is not
   * market-specific — email and push are the same everywhere.
   */
  markets: readonly string[];

  /** A callback exists that says the message ARRIVED, not merely that it was accepted. */
  supportsDeliveryReceipt: boolean;
  /** A callback exists that says the recipient OPENED it. */
  supportsReadReceipt: boolean;
  /** The API can send a pre-registered template by id/name rather than free text. */
  supportsTemplateSend: boolean;
  /**
   * The provider will carry NOTHING except a registered template.
   *
   * The difference from `supportsTemplateSend` is the difference between an option and a
   * precondition, and it is the whole of the India SMS problem: MSG91 can only send an
   * approved DLT template, so an unbound type is a permanent refusal rather than a fallback
   * to plain text.
   */
  requiresTemplate: boolean;
  /** The send API accepts a caller-supplied key that makes a retried send non-duplicating. */
  supportsIdempotencyKey: boolean;
  /** Callbacks carry a cryptographic signature we can verify. */
  supportsWebhookSignature: boolean;
  /**
   * Status can be PULLED from the provider on demand, rather than only pushed to us.
   *
   * This matters for recovery: with a pull API, a webhook outage is repairable after the
   * fact. Without one, every event missed during the outage is lost for good.
   */
  supportsPullReceipt: boolean;
  /** A per-message price can be established — from a rate card or from the provider. */
  costMeasurable: boolean;
  /**
   * Delivery can be OBSERVED. False means `ACCEPTED` is the last thing we will ever know,
   * and certification must treat it as terminal rather than waiting forever.
   */
  deliveryMeasurable: boolean;
  /** How the callback endpoint proves the caller, when there is no signature. */
  webhookAuth: 'signature' | 'endpoint_secret' | 'none';
  /** Anything an operator has to know that the flags above cannot say. */
  notes?: string;
}

/**
 * The table.
 *
 * `log` is included deliberately. It is a real transport that this platform runs in every
 * local and QA environment, and describing it as capable of nothing is what stops a readiness
 * report treating "we are printing to stdout" as a working channel.
 */
export const PROVIDER_CAPABILITIES: readonly ProviderCapability[] = [
  {
    provider: 'ses',
    channel: 'email',
    markets: ['*'],
    supportsDeliveryReceipt: true,
    supportsReadReceipt: false,
    supportsTemplateSend: true,
    requiresTemplate: false,
    supportsIdempotencyKey: false,
    supportsWebhookSignature: true,
    supportsPullReceipt: false,
    costMeasurable: true,
    deliveryMeasurable: true,
    webhookAuth: 'signature',
    /*
      Open and click tracking exist and are deliberately not enabled: a ticket confirmation
      does not need a tracking pixel, so there is no read receipt to have.
    */
    notes:
      'Events arrive via SNS and ONLY for messages sent with a configuration set that has an ' +
      'event destination. Without SES_CONFIGURATION_SET no callback ever arrives.',
  },
  {
    provider: 'sendgrid',
    channel: 'email',
    markets: ['*'],
    supportsDeliveryReceipt: true,
    supportsReadReceipt: false,
    supportsTemplateSend: true,
    requiresTemplate: false,
    supportsIdempotencyKey: false,
    supportsWebhookSignature: true,
    supportsPullReceipt: false,
    costMeasurable: true,
    deliveryMeasurable: false,
    webhookAuth: 'none',
    // The adapter sends; no SendGrid event webhook is implemented in this repository. The
    // provider can do it, we do not — and the honest column is the one about us.
    notes:
      'Send-only in this repository. No event webhook handler exists, so nothing is ever marked delivered.',
  },
  {
    provider: 'twilio',
    channel: 'sms',
    markets: ['US', 'CA'],
    supportsDeliveryReceipt: true,
    supportsReadReceipt: false,
    supportsTemplateSend: false,
    requiresTemplate: false,
    supportsIdempotencyKey: false,
    supportsWebhookSignature: true,
    supportsPullReceipt: true,
    costMeasurable: true,
    deliveryMeasurable: true,
    webhookAuth: 'signature',
    notes:
      'Sends through TWILIO_MESSAGING_SERVICE_SID; delivery callbacks come from that ' +
      'Messaging Service, so its Delivery Status Callback must be set. The signature covers ' +
      'the callback URL, so PUBLIC_API_URL must match byte for byte what Twilio calls. US and ' +
      'Canada traffic requires toll-free verification or A2P 10DLC registration.',
  },
  {
    provider: 'msg91',
    channel: 'sms',
    markets: ['IN'],
    supportsDeliveryReceipt: true,
    supportsReadReceipt: false,
    supportsTemplateSend: true,
    requiresTemplate: true,
    supportsIdempotencyKey: false,
    supportsWebhookSignature: false,
    supportsPullReceipt: true,
    costMeasurable: true,
    deliveryMeasurable: true,
    webhookAuth: 'endpoint_secret',
    notes:
      'India only carries DLT-approved templates under a registered header. No published ' +
      'callback signature, so the delivery-report URL carries a shared secret in its path.',
  },
  {
    provider: 'msg91',
    channel: 'whatsapp',
    markets: ['IN'],
    supportsDeliveryReceipt: true,
    supportsReadReceipt: true,
    supportsTemplateSend: true,
    requiresTemplate: true,
    supportsIdempotencyKey: false,
    supportsWebhookSignature: false,
    supportsPullReceipt: true,
    costMeasurable: true,
    deliveryMeasurable: true,
    webhookAuth: 'endpoint_secret',
    notes: 'MSG91 acts as the BSP. Templates are approved through them, priced by category.',
  },
  {
    provider: 'cloud',
    channel: 'whatsapp',
    markets: ['US', 'CA'],
    supportsDeliveryReceipt: true,
    supportsReadReceipt: true,
    supportsTemplateSend: true,
    requiresTemplate: true,
    supportsIdempotencyKey: false,
    supportsWebhookSignature: true,
    supportsPullReceipt: false,
    costMeasurable: true,
    deliveryMeasurable: true,
    webhookAuth: 'signature',
    notes:
      'Meta Cloud API. Read receipts routinely arrive BEFORE delivery, which is why delivery ' +
      'state is resolved by rank rather than by arrival order.',
  },
  {
    provider: 'expo',
    channel: 'push',
    markets: ['*'],
    supportsDeliveryReceipt: false,
    supportsReadReceipt: false,
    supportsTemplateSend: false,
    requiresTemplate: false,
    supportsIdempotencyKey: false,
    supportsWebhookSignature: false,
    supportsPullReceipt: true,
    costMeasurable: true,
    deliveryMeasurable: false,
    webhookAuth: 'none',
    /*
      Expo has a receipts endpoint, but it reports whether the PUSH SERVICE accepted the
      notification -- not whether a handset displayed it. Calling that a delivery receipt
      would put a claim in the delivered column that the data does not support.
    */
    notes:
      'No delivery receipt. ACCEPTED is terminal. Expo receipts report push-service ' +
      'acceptance, not arrival on a device. Free at this volume — configure the rate at zero.',
  },
  {
    provider: 'fcm',
    channel: 'push',
    markets: ['*'],
    supportsDeliveryReceipt: false,
    supportsReadReceipt: false,
    supportsTemplateSend: false,
    requiresTemplate: false,
    supportsIdempotencyKey: false,
    supportsWebhookSignature: false,
    supportsPullReceipt: false,
    costMeasurable: true,
    deliveryMeasurable: false,
    webhookAuth: 'none',
    notes:
      'FCM cannot deliver to an ExponentPushToken, which is what the mobile app registers. ' +
      'Selecting fcm with the current app reaches nobody, silently.',
  },
  {
    provider: 'log',
    channel: 'email',
    markets: ['*'],
    supportsDeliveryReceipt: false,
    supportsReadReceipt: false,
    supportsTemplateSend: false,
    requiresTemplate: false,
    supportsIdempotencyKey: false,
    supportsWebhookSignature: false,
    supportsPullReceipt: false,
    costMeasurable: false,
    deliveryMeasurable: false,
    webhookAuth: 'none',
    notes: 'Writes to the service log and SENDS NOTHING. Local and QA only.',
  },
];

/** Capabilities for one provider on one channel, or null if that pairing does not exist. */
export function capabilityFor(
  provider: string,
  channel: NotificationChannelKey,
): ProviderCapability | null {
  const key = provider.toLowerCase();
  return (
    PROVIDER_CAPABILITIES.find((c) => c.provider === key && c.channel === channel) ??
    // `log` stands in for any channel it is selected on; one row describes them all.
    (key === 'log'
      ? { ...PROVIDER_CAPABILITIES.find((c) => c.provider === 'log')!, channel }
      : null)
  );
}

/**
 * Whether a delivery callback is something to wait for on this pairing.
 *
 * The question certification actually asks. An unknown provider returns `false` rather than
 * `true`: promising a receipt that may not exist would leave a channel stuck one rung below
 * certified with nothing anybody could do about it.
 */
export function expectsDeliveryCallback(
  provider: string,
  channel: NotificationChannelKey,
): boolean {
  return capabilityFor(provider, channel)?.supportsDeliveryReceipt ?? false;
}

/** Whether policy-selected types on this pairing need an external template binding. */
export function requiresTemplateBinding(
  provider: string,
  channel: NotificationChannelKey,
): boolean {
  return capabilityFor(provider, channel)?.requiresTemplate ?? false;
}
