import { z } from 'zod';

/** Validated environment. Fails fast on boot if misconfigured. */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Deployment environment for runtime payment configuration (ADR-020). Selects
  // which env-scoped provider configs / routes / merchant accounts are used.
  // Defaults to LOCAL so dev/test/mock boot unchanged.
  APP_ENV: z.enum(['LOCAL', 'DEV', 'QA', 'UAT', 'STAGING', 'PRODUCTION']).default('LOCAL'),
  API_PORT: z.coerce.number().default(4000),
  API_GLOBAL_PREFIX: z.string().default('api'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // ─── Observability (all optional; unset ⇒ feature is a complete no-op) ───────
  // Slow-query reporting threshold (ms). Queries slower than this are logged
  // (duration + target only, no SQL/params) and counted in etg_slow_queries_total.
  SLOW_QUERY_MS: z.coerce.number().default(500),
  // Error tracking (Sentry). No DSN ⇒ Sentry is never initialised.
  SENTRY_DSN: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  SENTRY_RELEASE: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().optional(),
  // Distributed tracing (OpenTelemetry). No endpoint ⇒ tracing never starts.
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  OTEL_SERVICE_NAME: z.string().optional(),

  JWT_ACCESS_SECRET: z.string().min(1),
  JWT_REFRESH_SECRET: z.string().min(1),
  JWT_ACCESS_TTL: z.string().default('900s'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  QR_SIGNING_SECRET: z.string().min(1),
  // Offline gate check-in (ADR-035). OFF by default; endpoints 404 when disabled.
  // Manifest signing reuses QR_SIGNING_SECRET unless a dedicated secret is set.
  OFFLINE_CHECKIN_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  MANIFEST_SIGNING_SECRET: z.string().optional(),

  // Inventory sourcing seam (ADR-037). OFF by default: the provider registry still
  // constructs Direct/Manual adapters, but the booking engine keeps its existing
  // direct path until a show is explicitly routed through the resolver. No behaviour
  // change while OFF.
  INVENTORY_SOURCING_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  // External aggregator adapters (ADR-037). OFF by default; the AggregatorProvider is
  // a placeholder that fails closed (never fabricates inventory) until a real vendor
  // integration lands behind this flag.
  INVENTORY_AGGREGATOR_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  // Comma-separated provider priority order for the InventoryResolver (most-preferred
  // first, e.g. "direct,manual,aggregator"). Unset ⇒ a safe default that always
  // prefers LOCAL authoritative stock before any external source.
  INVENTORY_PROVIDER_PRIORITY: z.string().optional(),

  // Domain event bus (ADR-038). OFF by default: the bus + handlers are wired via DI,
  // but publish() is a no-op until enabled, so no handler runs and core booking
  // correctness is unaffected. Turning it on only activates observers of facts.
  DOMAIN_EVENTS_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  // Per-handler execution timeout (ms) for the in-process bus. A handler exceeding
  // this is abandoned as a failure (isolated + logged), never blocking other handlers.
  DOMAIN_EVENT_HANDLER_TIMEOUT_MS: z.coerce.number().default(5000),

  // Transactional outbox (ADR-041). DEFAULTS PRESERVE P2 in-process behaviour. Mode
  // `in_process` = current P2. `outbox` = record durably in the business tx + dispatch
  // from the outbox (no direct post-commit publish). `dual_write_shadow` = record
  // shadow rows for comparison AND keep direct delivery (dispatcher never delivers
  // shadow rows). The dispatcher only runs when DOMAIN_EVENT_OUTBOX_DISPATCH_ENABLED.
  DOMAIN_EVENT_DELIVERY_MODE: z
    .enum(['in_process', 'outbox', 'dual_write_shadow'])
    .default('in_process'),
  DOMAIN_EVENT_OUTBOX_DISPATCH_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  DOMAIN_EVENT_OUTBOX_BATCH_SIZE: z.coerce.number().default(100),
  DOMAIN_EVENT_OUTBOX_POLL_INTERVAL_MS: z.coerce.number().default(1000),
  DOMAIN_EVENT_OUTBOX_LEASE_SECONDS: z.coerce.number().default(60),
  DOMAIN_EVENT_OUTBOX_MAX_ATTEMPTS: z.coerce.number().default(12),
  DOMAIN_EVENT_OUTBOX_BASE_RETRY_SECONDS: z.coerce.number().default(5),
  DOMAIN_EVENT_OUTBOX_MAX_RETRY_SECONDS: z.coerce.number().default(3600),
  DOMAIN_EVENT_OUTBOX_RETENTION_DAYS: z.coerce.number().default(30),
  DOMAIN_EVENT_OUTBOX_DEAD_LETTER_RETENTION_DAYS: z.coerce.number().default(90),
  DOMAIN_EVENT_OUTBOX_MAX_PAYLOAD_BYTES: z.coerce.number().default(262144),
  // Optional stable worker id; unset ⇒ a per-process id is generated.
  DOMAIN_EVENT_OUTBOX_WORKER_ID: z.string().optional(),
  // Retention purge (delivered/dead-letter). OFF by default.
  DOMAIN_EVENT_OUTBOX_RETENTION_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),

  // Provider-neutral booking orchestrator (ADR-042, P5). OFF by default: the legacy
  // BookingsService/PaymentsService path is authoritative and unchanged. `shadow`
  // records a durable BookingWorkflow alongside the legacy path WITHOUT any duplicate
  // payment/inventory/provider side effect; `active` (later) routes booking decisions
  // through the orchestrator. Provider-confirmation / compensation / reconciliation are
  // separately gated so no single flag half-activates an unsafe path.
  BOOKING_ORCHESTRATOR_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  BOOKING_ORCHESTRATOR_MODE: z.enum(['shadow', 'active']).default('shadow'),
  BOOKING_PROVIDER_CONFIRMATION_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  BOOKING_COMPENSATION_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  BOOKING_RECONCILIATION_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),

  // Distributed Redis seat-lock engine (ADR-039). OFF by default: the legacy
  // PostgreSQL hold path is unchanged and no Redis dependency is added to it. When
  // enabled, `shadow` observes/measures Redis locks without changing booking outcome
  // (PostgreSQL stays authoritative); `active` would gate acquisition (not the P3
  // proof path). PostgreSQL is ALWAYS the final source of truth.
  INVENTORY_LOCKS_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  INVENTORY_LOCKS_MODE: z.enum(['shadow', 'active']).default('shadow'),
  // TTL for a fresh lock (fast Redis expiration of temporary ownership).
  INVENTORY_LOCK_TTL_SECONDS: z.coerce.number().default(300),
  // Renewal is only permitted once the remaining TTL is within this window.
  INVENTORY_LOCK_RENEWAL_WINDOW_SECONDS: z.coerce.number().default(120),
  // Hard cap on total lock lifetime from first acquisition — locks are never
  // renewable forever (abuse control).
  INVENTORY_LOCK_MAX_LIFETIME_SECONDS: z.coerce.number().default(900),
  // Reconciliation sweep (Redis↔PostgreSQL mismatch detection). OFF by default.
  INVENTORY_LOCK_RECONCILIATION_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  // Abuse controls: max units per acquisition and max concurrent active locks/owner.
  INVENTORY_LOCK_MAX_SEATS: z.coerce.number().default(10),
  INVENTORY_LOCK_MAX_QUANTITY: z.coerce.number().default(20),
  INVENTORY_LOCK_MAX_ACTIVE_PER_OWNER: z.coerce.number().default(20),

  // External inventory synchronization platform (ADR-040). ALL default OFF; no sync
  // path activates by default and existing behaviour is unchanged. Flags are granular
  // so no single flag can half-activate an unsafe processing path.
  INVENTORY_SYNC_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  INVENTORY_SYNC_WEBHOOKS_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  INVENTORY_SYNC_POLLING_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  INVENTORY_SYNC_PROCESSING_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  INVENTORY_SYNC_RECONCILIATION_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  INVENTORY_SYNC_AUTO_REPAIR_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  // Comma-separated provider codes allowed to ingest (empty ⇒ none accepted).
  INVENTORY_SYNC_PROVIDER_ALLOWLIST: z.string().optional(),
  INVENTORY_SYNC_MAX_PAYLOAD_BYTES: z.coerce.number().default(262144),
  INVENTORY_SYNC_EVENT_RETENTION_DAYS: z.coerce.number().default(30),
  INVENTORY_SYNC_MAX_ATTEMPTS: z.coerce.number().default(6),
  INVENTORY_SYNC_POLL_INTERVAL_SECONDS: z.coerce.number().default(300),
  // Replay-window tolerance (seconds) for signed webhook timestamps.
  INVENTORY_SYNC_REPLAY_WINDOW_SECONDS: z.coerce.number().default(300),
  // Enables the feature-flagged, dev/test-only mock aggregator adapter.
  INVENTORY_SYNC_MOCK_PROVIDER_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),

  PAYMENT_PROVIDER: z.string().default('mock'),
  PAYMENT_WEBHOOK_SECRET: z.string().min(1),

  // ─── Secret manager (production-binding layer, ADR-024) ───
  // Resolves secret REFERENCES (e.g. payments/stripe/live/secret-key) into secret
  // values. `env` reads from process.env (LOCAL/DEV only — rejected in PRODUCTION);
  // azure/aws/gcp are feature-gated cloud managers (their SDK is loaded lazily and
  // only required when selected). Default `env` keeps local/dev/test/e2e unchanged.
  SECRET_MANAGER_PROVIDER: z.enum(['env', 'azure', 'aws', 'gcp']).default('env'),
  // Short cache TTL (ms) for resolved secrets; supports rotation without restart.
  SECRET_CACHE_TTL_MS: z.coerce.number().default(300000),
  // Azure Key Vault (SECRET_MANAGER_PROVIDER=azure). Uses DefaultAzureCredential.
  AZURE_KEY_VAULT_URL: z.string().optional(),
  // AWS Secrets Manager (SECRET_MANAGER_PROVIDER=aws). Uses the default AWS chain.
  AWS_SECRETS_REGION: z.string().optional(),
  // GCP Secret Manager (SECRET_MANAGER_PROVIDER=gcp).
  GCP_PROJECT_ID: z.string().optional(),

  // Allow LIVE-classified keys in lower environments (LOCAL/DEV/QA/UAT). Off by
  // default so live credentials cannot activate outside staging/production.
  PAYMENT_ALLOW_LIVE_KEYS_LOWER_ENV: z.enum(['true', 'false']).default('false'),
  // Construct enabled real providers from the secret manager on boot (best-effort;
  // failures never break boot and surface via the readiness endpoint).
  PAYMENT_FACTORY_WARMUP: z.enum(['true', 'false']).default('true'),
  // Master switch that must be true before any real (live) payment is accepted.
  // Off by default so live payments cannot be enabled by accident (ADR-028).
  PAYMENT_LIVE_ENABLED: z.enum(['true', 'false']).default('false'),
  // A merchant's sandbox certification must be newer than this to count as valid.
  CERTIFICATION_MAX_AGE_DAYS: z.coerce.number().default(30),

  // Which real/mock provider the PAYMENT_PROVIDER token resolves to. Optional so
  // dev/test/mock boots without any gateway keys. Only the selected provider is
  // constructed (see payments.module.ts), and it fails fast if its keys are unset.
  PAYMENT_PROVIDER_NAME: z.enum(['mock', 'razorpay', 'stripe', 'paypal', 'square']).default('mock'),

  // --- Razorpay (India). Sandbox vs production is purely test vs live keys. ---
  // KEY_ID is public (may be sent to approved clients). KEY_SECRET + WEBHOOK_SECRET are
  // server-side only. The webhook secret is DISTINCT from the API key secret.
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  // Declared mode; cross-checked against the key prefix so test and live cannot be mixed.
  RAZORPAY_MODE: z.enum(['test', 'live']).default('test'),
  RAZORPAY_CURRENCY: z.string().default('INR'),
  // Razorpay Route (organizer payouts via Linked Accounts). OFF by default — no organizer
  // transfer executes and settlements stay HELD/BLOCKED until Route is activated + enabled.
  RAZORPAY_ROUTE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Platform account number (required by some Route transfer flows). Reference, not a secret.
  RAZORPAY_ACCOUNT_NUMBER: z.string().optional(),
  // Where Checkout returns the buyer (the redirect is NEVER treated as proof of payment).
  RAZORPAY_CALLBACK_URL: z.string().default('http://localhost:3000/checkout/razorpay/callback'),
  // Public Checkout branding.
  RAZORPAY_CHECKOUT_NAME: z.string().default('ETicketsGo'),
  RAZORPAY_CHECKOUT_DESCRIPTION: z.string().default('Event ticket purchase'),

  // --- PayPal (global, Orders v2 REST). Endpoint configurable; defaults to sandbox. ---
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  PAYPAL_API_BASE_URL: z.string().optional(),
  PAYPAL_RETURN_URL: z.string().optional(),
  PAYPAL_CANCEL_URL: z.string().optional(),

  // --- Square (Connect REST). Endpoint configurable; defaults to sandbox. ---
  SQUARE_ACCESS_TOKEN: z.string().optional(),
  SQUARE_LOCATION_ID: z.string().optional(),
  SQUARE_API_BASE_URL: z.string().optional(),
  SQUARE_API_VERSION: z.string().optional(),
  SQUARE_WEBHOOK_SIGNATURE_KEY: z.string().optional(),
  SQUARE_WEBHOOK_URL: z.string().optional(),

  // --- Stripe (global). Sandbox vs production is purely test vs live keys. ---
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  // Publishable (public) key — safe to return to approved clients. NEVER a secret.
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  // Pin the Stripe API version so upgrades are deliberate. Optional: when unset the
  // installed SDK's pinned default is used. Set to the exact dashboard API version.
  STRIPE_API_VERSION: z.string().optional(),
  // Where Stripe Checkout redirects the buyer after success/cancel. {CHECKOUT_SESSION_ID}
  // is substituted by Stripe. Optional with sane localhost defaults.
  STRIPE_SUCCESS_URL: z
    .string()
    .default('http://localhost:3000/checkout/success?session_id={CHECKOUT_SESSION_ID}'),
  STRIPE_CANCEL_URL: z.string().default('http://localhost:3000/checkout/cancel'),

  // ─── Stripe Connect (US marketplace) ───
  // Connect OAuth client id (only used for the OAuth/Standard flow; Express/Custom
  // accounts created via the API do not require it). Non-secret identifier.
  STRIPE_CONNECT_CLIENT_ID: z.string().optional(),
  // Connected-account type for organizer onboarding. `express` = Stripe-hosted
  // onboarding + an Express dashboard (login links supported). `standard` = the
  // organizer's own full Stripe account. Default express for a hosted marketplace.
  STRIPE_CONNECT_ACCOUNT_TYPE: z.enum(['express', 'standard', 'custom']).default('express'),
  // Where Stripe returns / refreshes the organizer during hosted onboarding.
  STRIPE_CONNECT_RETURN_URL: z
    .string()
    .default('http://localhost:3001/organizer/payouts?onboarding=return'),
  STRIPE_CONNECT_REFRESH_URL: z
    .string()
    .default('http://localhost:3001/organizer/payouts?onboarding=refresh'),
  // Settlement reserve withheld from each organizer transfer, in basis points
  // (100 = 1%). Configurable per deployment; 0 = no reserve. NEVER hardcoded.
  STRIPE_SETTLEMENT_RESERVE_BPS: z.coerce.number().int().min(0).max(10000).default(0),

  STORAGE_DRIVER: z.string().default('local'),
  STORAGE_LOCAL_DIR: z.string().default('.storage'),

  // ─── Notification delivery transports ──────────────────────────────────────
  // Each channel picks a transport via <CHANNEL>_PROVIDER (default `log` = the
  // original log-only behaviour, so mock/dev/test/e2e boot with none of the keys
  // below). Only the selected provider is constructed; if selected but its keys
  // are missing, construction fails fast with a key-named error. Sandbox vs
  // production is purely test vs live credentials — same code.

  // --- Email (recipient = notification.toEmail) ---
  EMAIL_PROVIDER: z.enum(['log', 'sendgrid', 'ses']).default('log'),
  EMAIL_FROM: z.string().optional(),
  // SendGrid (EMAIL_PROVIDER=sendgrid)
  SENDGRID_API_KEY: z.string().optional(),
  // AWS SES v2 (EMAIL_PROVIDER=ses). Credentials fall back to the default AWS
  // provider chain when the explicit access-key pair is omitted.
  AWS_REGION: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),

  // --- SMS (recipient = payload.phone) ---
  SMS_PROVIDER: z.enum(['log', 'twilio']).default('log'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),

  // --- WhatsApp (recipient = payload.phone) ---
  WHATSAPP_PROVIDER: z.enum(['log', 'cloud']).default('log'),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),

  // --- Push (recipient = payload.pushToken / payload.pushTokens) ---
  PUSH_PROVIDER: z.enum(['log', 'fcm']).default('log'),
  FCM_PROJECT_ID: z.string().optional(),
  FCM_CLIENT_EMAIL: z.string().optional(),
  FCM_PRIVATE_KEY: z.string().optional(),

  // --- AI & Growth (v2.0). Disabled by default: features fall back to deterministic
  //     insights until a real provider is wired. No provider response is ever faked. ---
  AI_PROVIDER: z.enum(['disabled', 'openai', 'anthropic']).default('disabled'),
  AI_MODEL: z.string().optional(),
  AI_API_KEY: z.string().optional(),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(8000),
  AI_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(1),
  // Rough cost estimate per 1K tokens (minor units) for the ops-console cost figure.
  AI_COST_PER_1K_MINOR: z.coerce.number().int().min(0).default(0),

  // --- Browser Web Push (v1.4). Self-hosted VAPID, no third party. The delivery
  //     transport is a placeholder ('log') until a VAPID transport is wired; the
  //     keys below are optional and only exposed as non-secret public key. ---
  WEBPUSH_PROVIDER: z.enum(['log', 'vapid']).default('log'),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),
});

export type AppConfig = z.infer<typeof envSchema>;

// Shared shipped-placeholder pattern (mirrors the payments credential validator) so
// the auth/QR/webhook secrets get the same fail-closed treatment the payment layer
// already applies to gateway keys.
const PLACEHOLDER_SECRET =
  /(replace_me|replace-me|replace_from|changeme|change[_-]?me|your_|xxxx|placeholder|CHANGE_ME)/i;
const MIN_SECRET_LEN = 24;

/**
 * Extra fail-closed checks that only apply to real deployments (NODE_ENV=production or
 * APP_ENV in STAGING/PRODUCTION). Boots MUST NOT succeed with a shipped placeholder /
 * weak core signing secret, and CORS must be explicitly configured. Lower environments
 * (LOCAL/DEV/QA/UAT, dev/test) are unaffected so mock/dev/e2e boot unchanged.
 */
function assertProductionHardening(cfg: AppConfig): void {
  const isProdLike =
    cfg.NODE_ENV === 'production' || ['STAGING', 'PRODUCTION'].includes(cfg.APP_ENV);
  if (!isProdLike) return;

  const errors: string[] = [];
  const secrets: Record<string, string | undefined> = {
    JWT_ACCESS_SECRET: cfg.JWT_ACCESS_SECRET,
    JWT_REFRESH_SECRET: cfg.JWT_REFRESH_SECRET,
    QR_SIGNING_SECRET: cfg.QR_SIGNING_SECRET,
    PAYMENT_WEBHOOK_SECRET: cfg.PAYMENT_WEBHOOK_SECRET,
    // Only enforced when explicitly set (optional; falls back to QR_SIGNING_SECRET).
    MANIFEST_SIGNING_SECRET: cfg.MANIFEST_SIGNING_SECRET,
  };
  for (const [name, value] of Object.entries(secrets)) {
    if (value === undefined) continue;
    if (PLACEHOLDER_SECRET.test(value)) {
      errors.push(`  - ${name}: looks like a shipped placeholder — set a real secret.`);
    } else if (value.length < MIN_SECRET_LEN) {
      errors.push(`  - ${name}: too short (< ${MIN_SECRET_LEN} chars) for production.`);
    }
  }
  if (!process.env.CORS_ORIGINS || cfg.CORS_ORIGINS.includes('localhost')) {
    errors.push('  - CORS_ORIGINS: must be set to the real frontend origin(s) in production.');
  }
  if (errors.length) {
    throw new Error(`Insecure production configuration:\n${errors.join('\n')}`);
  }
}

/**
 * Razorpay test/live isolation (enforced in EVERY environment — mixing is dangerous
 * anywhere). The declared RAZORPAY_MODE must match the key prefix, and the webhook
 * secret must be distinct from the API key secret.
 */
function assertRazorpayConsistency(cfg: AppConfig): void {
  const keyId = cfg.RAZORPAY_KEY_ID;
  if (!keyId) return; // Razorpay not configured — the adapter fails fast if selected.
  const errors: string[] = [];
  const isTestKey = keyId.startsWith('rzp_test_');
  const isLiveKey = keyId.startsWith('rzp_live_');
  if (isTestKey && cfg.RAZORPAY_MODE !== 'test') {
    errors.push('  - RAZORPAY_MODE=live but RAZORPAY_KEY_ID is a test key (rzp_test_).');
  }
  if (isLiveKey && cfg.RAZORPAY_MODE !== 'live') {
    errors.push('  - RAZORPAY_MODE=test but RAZORPAY_KEY_ID is a live key (rzp_live_).');
  }
  if (
    cfg.RAZORPAY_KEY_SECRET &&
    cfg.RAZORPAY_WEBHOOK_SECRET &&
    cfg.RAZORPAY_KEY_SECRET === cfg.RAZORPAY_WEBHOOK_SECRET
  ) {
    errors.push('  - RAZORPAY_WEBHOOK_SECRET must be DISTINCT from RAZORPAY_KEY_SECRET.');
  }
  if (errors.length) {
    throw new Error(`Invalid Razorpay configuration:\n${errors.join('\n')}`);
  }
}

/**
 * Platform-foundation safety (ADR-037/039/040/041). Fails fast on unsafe feature-flag
 * combinations so no deployment can half-activate a dangerous path. Runs in every
 * environment for env-independent hazards; production-only for the rest.
 */
function assertPlatformConfigConsistency(cfg: AppConfig): void {
  const isProdLike =
    cfg.NODE_ENV === 'production' || ['STAGING', 'PRODUCTION'].includes(cfg.APP_ENV);
  const errors: string[] = [];

  // The dev/test-only mock aggregator must NEVER run in production.
  if (isProdLike && cfg.INVENTORY_SYNC_MOCK_PROVIDER_ENABLED) {
    errors.push(
      '  - INVENTORY_SYNC_MOCK_PROVIDER_ENABLED must be false in production (dev/test only).',
    );
  }

  // Enabling inventory sync ingress/processing with no allowlist accepts nothing and is
  // always a misconfiguration (every env).
  const syncActive =
    cfg.INVENTORY_SYNC_ENABLED &&
    (cfg.INVENTORY_SYNC_WEBHOOKS_ENABLED ||
      cfg.INVENTORY_SYNC_POLLING_ENABLED ||
      cfg.INVENTORY_SYNC_PROCESSING_ENABLED);
  const allowlistEmpty = !(cfg.INVENTORY_SYNC_PROVIDER_ALLOWLIST ?? '').trim();
  if (syncActive && allowlistEmpty) {
    errors.push(
      '  - INVENTORY_SYNC_* is enabled but INVENTORY_SYNC_PROVIDER_ALLOWLIST is empty — no provider can be accepted.',
    );
  }

  // outbox mode with the dispatcher off silently accrues undelivered events in prod.
  // (Lower envs may record-only for rollout testing; dual_write_shadow is preferred.)
  if (
    isProdLike &&
    cfg.DOMAIN_EVENT_DELIVERY_MODE === 'outbox' &&
    !cfg.DOMAIN_EVENT_OUTBOX_DISPATCH_ENABLED
  ) {
    errors.push(
      '  - DOMAIN_EVENT_DELIVERY_MODE=outbox requires DOMAIN_EVENT_OUTBOX_DISPATCH_ENABLED in production (else events never deliver).',
    );
  }

  // Active booking orchestration (ADR-042). Fail startup rather than allowing a partially
  // active platform (ADR-042 §18, P5.2A).
  const orchestratorActive =
    cfg.BOOKING_ORCHESTRATOR_ENABLED && cfg.BOOKING_ORCHESTRATOR_MODE === 'active';
  if (orchestratorActive) {
    // The resolver selects the provider — sourcing must be on (every env).
    if (!cfg.INVENTORY_SOURCING_ENABLED) {
      errors.push(
        '  - BOOKING_ORCHESTRATOR_MODE=active requires INVENTORY_SOURCING_ENABLED (the resolver selects the provider).',
      );
    }
    // Real deployments cannot run active bookings on the mock gateway, and confirmation
    // events must actually deliver (the atomic confirm records the outbox fact).
    if (isProdLike && cfg.PAYMENT_PROVIDER_NAME === 'mock') {
      errors.push(
        '  - BOOKING_ORCHESTRATOR_MODE=active requires a real PAYMENT_PROVIDER_NAME in production (mock cannot take live payments).',
      );
    }
    if (
      isProdLike &&
      cfg.DOMAIN_EVENT_DELIVERY_MODE === 'outbox' &&
      !cfg.DOMAIN_EVENT_OUTBOX_DISPATCH_ENABLED
    ) {
      errors.push(
        '  - BOOKING_ORCHESTRATOR_MODE=active with DOMAIN_EVENT_DELIVERY_MODE=outbox requires DOMAIN_EVENT_OUTBOX_DISPATCH_ENABLED (confirmation events must deliver).',
      );
    }
  } else if (isProdLike && cfg.INVENTORY_LOCKS_ENABLED && cfg.INVENTORY_LOCKS_MODE === 'active') {
    // Active locking is only meaningful once active orchestration wires it in.
    errors.push(
      '  - INVENTORY_LOCKS_MODE=active requires BOOKING_ORCHESTRATOR_MODE=active (booking path is not otherwise lock-wired).',
    );
  }

  if (errors.length) {
    throw new Error(`Unsafe platform configuration:\n${errors.join('\n')}`);
  }
}

export function loadConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  assertProductionHardening(parsed.data);
  assertRazorpayConsistency(parsed.data);
  assertPlatformConfigConsistency(parsed.data);
  return parsed.data;
}
