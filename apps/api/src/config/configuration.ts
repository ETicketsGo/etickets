import { z } from 'zod';

/** Validated environment. Fails fast on boot if misconfigured. */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Deployment environment for runtime payment configuration (ADR-020). Selects
  // which env-scoped provider configs / routes / merchant accounts are used.
  // Defaults to LOCAL so dev/test/mock boot unchanged.
  APP_ENV: z.enum(['LOCAL', 'DEV', 'QA', 'UAT', 'STAGING', 'PRODUCTION']).default('LOCAL'),
  // PaaS platforms (Railway, Heroku, Render…) inject the port to bind as PORT and route the
  // public domain + health check there. It takes precedence over API_PORT at bootstrap; leaving
  // it unset keeps compose/k8s/local behaviour on API_PORT (4000) exactly as before.
  PORT: z.coerce.number().int().min(0).max(65535).optional(),
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

  /**
   * How long an unpaid booking holds its inventory, in minutes.
   *
   * This was a `const HOLD_MINUTES = 10` in BookingsService with no way to change it. A
   * hold window is a commercial decision, not a code constant: cinemas run tighter windows
   * than festivals, and a release-day house may want it tighter still. Changing it should
   * not need a deploy, and it must be settable per environment so QA can exercise
   * expiry quickly without waiting out the production window.
   *
   * The client is NOT told the duration — it renders the server's `holdExpiresAt`, so the
   * countdown follows this automatically and cannot drift from what the server enforces.
   *
   * Bounded deliberately: under a minute cannot survive a slow card page and would strand
   * paying customers, and beyond an hour lets abandoned carts sterilise a sold-out show.
   */
  BOOKING_HOLD_MINUTES: z.coerce.number().int().min(1).max(60).default(10),

  /**
   * Minimum gap between two shows on the same screen, in minutes.
   *
   * A cinema cannot run back-to-back: the room has to empty, be cleaned and refill.
   * Scheduling 14:00–16:00 followed by 16:00–18:00 looks correct in a spreadsheet and is
   * not runnable. This is a property of how a venue operates — a multiplex with cleaning
   * staff per screen turns around faster than a single-screen house — so it is
   * configuration rather than a constant.
   *
   * Zero is permitted: some operators schedule the gap into the advertised runtime and do
   * not want a second one imposed on top.
   */
  SHOW_TURNAROUND_MINUTES: z.coerce.number().int().min(0).max(240).default(15),

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
  // External provider booking (ADR-042 P5.2B). ALL default OFF. The mock external booking
  // provider is dev/test-only and rejected in production. Allocated inventory + status
  // recovery are separately gated so no single flag half-activates an unsafe remote path.
  BOOKING_PROVIDER_CONFIRMATION_MOCK_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  BOOKING_ALLOCATED_INVENTORY_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  BOOKING_PROVIDER_STATUS_RECOVERY_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  // Safety margin: refuse to collect payment against a provider reservation with less than
  // this much TTL remaining.
  BOOKING_PROVIDER_RESERVATION_TTL_SAFETY_SECONDS: z.coerce.number().int().min(1).default(60),
  BOOKING_PROVIDER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  BOOKING_PROVIDER_CONFIRM_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(8000),
  BOOKING_COMPENSATION_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  // Booking compensation foundation (ADR-043, P5.3A). ALL default OFF. Planning creates durable
  // records; execution runs only SAFE non-financial actions; money-moving auto flags are
  // additionally gated and rejected in production by startup validation.
  BOOKING_COMPENSATION_PLANNING_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  BOOKING_COMPENSATION_EXECUTION_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  BOOKING_COMPENSATION_AUTO_REFUND_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  BOOKING_COMPENSATION_AUTO_VOID_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  BOOKING_COMPENSATION_AUTO_PROVIDER_CANCEL_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  BOOKING_COMPENSATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(5),
  // Payment void (ADR-043 Phase 5). Status recovery for ambiguous void outcomes; bounded
  // void attempts + timeout. All off/default; auto-void stays production-forbidden.
  BOOKING_PAYMENT_STATUS_RECOVERY_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  BOOKING_PAYMENT_VOID_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  BOOKING_PAYMENT_VOID_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(8000),
  // Controlled refunds (ADR-043 Phase 6). Policy defaults to MANUAL_ONLY (nothing auto-refunds);
  // auto-refund + non-manual policy stay off + production-forbidden. No partial-refund mode.
  BOOKING_REFUND_POLICY_MODE: z
    .enum(['MANUAL_ONLY', 'FULL_GROSS', 'TICKET_ONLY', 'EVENT_CANCELLATION_FULL'])
    .default('MANUAL_ONLY'),
  BOOKING_REFUND_POLICY_VERSION: z.string().optional(),
  BOOKING_REFUND_STATUS_RECOVERY_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  BOOKING_REFUND_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  BOOKING_REFUND_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(8000),
  BOOKING_REFUND_STATUS_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
  BOOKING_COMPENSATION_LEASE_SECONDS: z.coerce.number().int().min(5).max(3600).default(60),
  BOOKING_COMPENSATION_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(3600).default(30),
  BOOKING_COMPENSATION_MANUAL_REVIEW_THRESHOLD: z.coerce.number().int().min(1).max(50).default(3),
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
  /**
   * Optional override for where Razorpay returns the buyer.
   *
   * No default: it used to be a localhost URL, which QA handed to Razorpay the moment real
   * keys were added — a buyer would have been redirected to somebody's laptop after paying.
   * Unset now means "derive it from CUSTOMER_WEB_URL", which fails loudly outside LOCAL/DEV
   * rather than inventing a destination.
   */
  RAZORPAY_CALLBACK_URL: z.string().optional(),
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
  /*
    Where Stripe Checkout returns the buyer. OPTIONAL AND WITHOUT A DEFAULT, on purpose.

    These defaulted to `http://localhost:3000/...`, which is the same defect that shipped in
    `RAZORPAY_CALLBACK_URL` and would have returned a paying customer to a machine that is
    not theirs — after the money moved. It was found by reading rather than by a customer
    only because Stripe has never had keys here.

    Derived from `CUSTOMER_WEB_URL` now (see `common/console-urls.ts`), which fails loudly
    when unset outside local development. Set one of these only when the return must land
    somewhere other than the storefront.
  */
  STRIPE_SUCCESS_URL: z.string().optional(),
  STRIPE_CANCEL_URL: z.string().optional(),

  // ─── Stripe Connect (US marketplace) ───
  // Connect OAuth client id (only used for the OAuth/Standard flow; Express/Custom
  // accounts created via the API do not require it). Non-secret identifier.
  STRIPE_CONNECT_CLIENT_ID: z.string().optional(),
  // Connected-account type for organizer onboarding. `express` = Stripe-hosted
  // onboarding + an Express dashboard (login links supported). `standard` = the
  // organizer's own full Stripe account. Default express for a hosted marketplace.
  STRIPE_CONNECT_ACCOUNT_TYPE: z.enum(['express', 'standard', 'custom']).default('express'),
  // Where Stripe returns / refreshes the organizer during hosted onboarding. Derived from
  // ORGANIZER_WEB_URL when unset; same reasoning as the two above.
  STRIPE_CONNECT_RETURN_URL: z.string().optional(),
  STRIPE_CONNECT_REFRESH_URL: z.string().optional(),
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
  /**
   * Permits a prod-like environment to boot with no working mail transport. For
   * migrations and smoke checks against an environment whose mail provider is not live
   * yet. Never set it while serving customers — see assertDeliverabilityHardening.
   */
  ALLOW_UNDELIVERABLE_NOTIFICATIONS: z.enum(['true', 'false']).default('false'),
  EMAIL_FROM: z.string().optional(),
  // SendGrid (EMAIL_PROVIDER=sendgrid)
  SENDGRID_API_KEY: z.string().optional(),
  // AWS SES v2 (EMAIL_PROVIDER=ses). Credentials fall back to the default AWS
  // provider chain when the explicit access-key pair is omitted.
  AWS_REGION: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),

  /*
    The sign-in code's message text.

    MUST be configurable, because in India it is not ours to choose. TRAI requires every SMS
    to match a template registered on a DLT portal — entity, then a six-character header,
    then the exact body with `{#var#}` placeholders — and an operator drops anything that
    does not match the approved text character for character. A body hardcoded in this
    repository is a body that cannot be made compliant without a release.

    `{code}` and `{minutes}` are substituted. Unset falls back to a sensible English default,
    which is correct everywhere DLT does not apply and wrong the moment it does.
  */
  /**
   * The state/province ETicketsGo itself is registered in.
   *
   * Decides whether the BOOKING FEE — the platform's own supply of service — is an
   * intra-state or an inter-state supply, which is a different question from where the event
   * is. A real BookMyShow order for a Hyderabad cinema shows the ticket taxed locally and the
   * convenience fee as IGST, precisely because the platform sits in another state.
   *
   * Unset means the question cannot be answered, and the fee falls back to intra-state — the
   * same amount, a possibly-wrong heading. See `tax-calculator.ts`.
   */
  PLATFORM_TAX_REGION: z.string().trim().max(60).optional(),

  OTP_SMS_TEMPLATE: z.string().optional(),

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
  /*
    `expo` is the transport that matches what the MOBILE APP registers.

    `expo-notifications`' `getExpoPushTokenAsync` issues `ExponentPushToken[...]`, and every
    row in `UserDevice` is one. FCM cannot deliver to those, so with PUSH_PROVIDER=fcm the
    app's own devices were unreachable — registration succeeded and nothing ever arrived.

    Choose `fcm` only if the app is changed to register native FCM tokens instead.
  */
  PUSH_PROVIDER: z.enum(['log', 'fcm', 'expo']).default('log'),
  // Expo (PUSH_PROVIDER=expo). NO credential is required for ordinary sends — the device
  // token itself authorises delivery. This is only needed once "enhanced security for push
  // notifications" is enabled in the Expo dashboard.
  EXPO_ACCESS_TOKEN: z.string().optional(),
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
 * A production that cannot deliver a ticket must not start.
 *
 * ── THE FAILURE THIS EXISTS TO PREVENT ─────────────────────────────────────────────
 * `EMAIL_PROVIDER` defaults to `log`, which writes the message to the service log and
 * sends nothing. That default is right everywhere else — a developer should not need an
 * API key to run the app — and catastrophic in production, because the platform boots
 * clean, reports healthy, takes the money, and the customer never receives their ticket.
 * Nothing in the system looks wrong; the log even records a cheerful line saying the email
 * was sent. It is the worst shape a defect can take: invisible to every check we have, and
 * visible only to the customer who paid.
 *
 * So delivery is treated exactly like a payment credential — refused at boot rather than
 * discovered at the first sale. A service that will not start is recoverable in minutes; a
 * week of silently undelivered tickets is not.
 *
 * Deliberately NOT enforced here: whether the sending domain is verified, and whether an
 * SES account is out of the sandbox. Neither can be read from this process, and a check
 * that guessed would be worse than none. Those steps live in docs/go-live/DELIVERY.md.
 */
function assertDeliverabilityHardening(cfg: AppConfig): void {
  /*
    Keyed on APP_ENV alone, NOT on NODE_ENV.

    QA and UAT both run with NODE_ENV=production — they build and serve production bundles,
    which is the point of them. Reusing the `isProdLike` test that the security guards use
    would therefore have refused to boot QA and UAT for having a log mail transport, which
    is exactly what they are supposed to have: their bookings are test bookings, and real
    mail to real inboxes is the failure there, not the fix.

    This is the same mistake the secret-store rule made and had corrected: it keyed on an
    environment NAME rather than on the condition that actually matters. Here the condition
    is "are real customers being served", and only APP_ENV knows that.
  */
  if (!['STAGING', 'PRODUCTION'].includes(cfg.APP_ENV)) return;
  // One legitimate exception: bringing an environment up to run migrations or a smoke
  // check before the mail provider exists. It has to be typed out on purpose, and its
  // name says what it is giving up.
  if (cfg.ALLOW_UNDELIVERABLE_NOTIFICATIONS === 'true') return;

  const errors: string[] = [];
  if (cfg.EMAIL_PROVIDER === 'log') {
    errors.push(
      '  - EMAIL_PROVIDER=log writes to the service log and SENDS NOTHING. Customers would ' +
        'be charged and never receive a ticket. Set EMAIL_PROVIDER=sendgrid or ses.',
    );
  } else if (!cfg.EMAIL_FROM) {
    errors.push(`  - EMAIL_FROM is required when EMAIL_PROVIDER=${cfg.EMAIL_PROVIDER}.`);
  }
  if (errors.length) {
    throw new Error(
      `Notifications cannot be delivered in this environment:\n${errors.join('\n')}\n` +
        `  Set ALLOW_UNDELIVERABLE_NOTIFICATIONS=true only to boot deliberately without ` +
        `mail (migrations, smoke checks) — never to serve customers.`,
    );
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

/** Classify a gateway credential from its issuer-assigned prefix. */
function classifyKey(value: string | undefined, testPrefix: string, livePrefix: string) {
  if (!value) return 'absent' as const;
  if (value.startsWith(livePrefix)) return 'live' as const;
  if (value.startsWith(testPrefix)) return 'test' as const;
  return 'unknown' as const; // e.g. a secret-manager reference, resolved after boot.
}

/**
 * Environment ↔ payment-credential agreement for the ENV-VAR binding path (the direct
 * `STRIPE_SECRET_KEY` / `RAZORPAY_KEY_ID` route used by the single-provider adapters).
 *
 * The DB-backed factory path already enforces this per merchant config
 * (`credential-validator.ts`, `payment-config.validator.ts`), but nothing stopped a
 * *deployment* from booting PRODUCTION with sandbox keys — silently taking orders that never
 * collect money — or from pointing QA/UAT at live keys and charging real cards during testing.
 * Both directions are fail-closed here, at boot, before the app serves anything:
 *
 *   PRODUCTION  → test keys are REJECTED, always (no override).
 *   STAGING     → test keys are allowed (sandbox rehearsal) — mode agreement still applies.
 *   LOCAL/DEV/QA/UAT → live keys are REJECTED unless PAYMENT_ALLOW_LIVE_KEYS_LOWER_ENV=true,
 *                      the same explicit, controlled override the provider factory honours.
 *
 * Keys whose prefix we cannot classify (secret-manager references resolved later) are left to
 * the factory's runtime validation — this check never guesses.
 */
function assertPaymentEnvironmentKeySafety(cfg: AppConfig): void {
  const env = cfg.APP_ENV;
  const allowLiveInLowerEnv = cfg.PAYMENT_ALLOW_LIVE_KEYS_LOWER_ENV === 'true';
  const lowerEnv = ['LOCAL', 'DEV', 'QA', 'UAT'].includes(env);
  const errors: string[] = [];

  const credentials = [
    {
      name: 'STRIPE_SECRET_KEY',
      class: classifyKey(cfg.STRIPE_SECRET_KEY, 'sk_test_', 'sk_live_'),
      testHint: 'sk_test_',
      liveHint: 'sk_live_',
    },
    {
      name: 'RAZORPAY_KEY_ID',
      class: classifyKey(cfg.RAZORPAY_KEY_ID, 'rzp_test_', 'rzp_live_'),
      testHint: 'rzp_test_',
      liveHint: 'rzp_live_',
    },
  ];

  for (const cred of credentials) {
    if (cred.class === 'absent' || cred.class === 'unknown') continue;
    if (env === 'PRODUCTION' && cred.class === 'test') {
      errors.push(
        `  - ${cred.name} is a TEST key (${cred.testHint}) but APP_ENV=PRODUCTION — production must use live credentials.`,
      );
    }
    if (lowerEnv && cred.class === 'live' && !allowLiveInLowerEnv) {
      errors.push(
        `  - ${cred.name} is a LIVE key (${cred.liveHint}) in APP_ENV=${env} — live credentials are refused outside STAGING/PRODUCTION (set PAYMENT_ALLOW_LIVE_KEYS_LOWER_ENV=true only for a deliberate, supervised test).`,
      );
    }
  }

  // The simulated gateway must never be the active adapter where real money is expected.
  if (env === 'PRODUCTION' && cfg.PAYMENT_PROVIDER_NAME === 'mock') {
    errors.push(
      '  - PAYMENT_PROVIDER_NAME=mock is not permitted in APP_ENV=PRODUCTION (the dummy gateway cannot take real payments).',
    );
  }

  // Webhook secrets are per-environment by construction; a shared value would let a QA webhook
  // replay be accepted as authentic by production.
  if (
    cfg.STRIPE_WEBHOOK_SECRET &&
    cfg.PAYMENT_WEBHOOK_SECRET &&
    cfg.STRIPE_WEBHOOK_SECRET === cfg.PAYMENT_WEBHOOK_SECRET
  ) {
    errors.push(
      '  - STRIPE_WEBHOOK_SECRET must be DISTINCT from PAYMENT_WEBHOOK_SECRET (separate signature domains).',
    );
  }

  if (errors.length) {
    throw new Error(`Unsafe payment credentials for this environment:\n${errors.join('\n')}`);
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

  // External provider booking (ADR-042 §25, P5.2B). Keep unsafe remote combinations from
  // booting.
  if (isProdLike && cfg.BOOKING_PROVIDER_CONFIRMATION_MOCK_ENABLED) {
    errors.push(
      '  - BOOKING_PROVIDER_CONFIRMATION_MOCK_ENABLED must be false in production (dev/test only).',
    );
  }
  // Provider confirmation needs a provider adapter. The only adapter today is the mock, so
  // enabling confirmation requires the mock in non-prod, and is unsupported in prod (no real
  // adapter exists yet — fail rather than silently do nothing).
  if (cfg.BOOKING_PROVIDER_CONFIRMATION_ENABLED) {
    if (isProdLike) {
      errors.push(
        '  - BOOKING_PROVIDER_CONFIRMATION_ENABLED is not supported in production yet (no real external booking provider is integrated).',
      );
    } else if (!cfg.BOOKING_PROVIDER_CONFIRMATION_MOCK_ENABLED) {
      errors.push(
        '  - BOOKING_PROVIDER_CONFIRMATION_ENABLED requires BOOKING_PROVIDER_CONFIRMATION_MOCK_ENABLED (the only external booking provider today is the mock).',
      );
    }
  }
  // Allocated inventory is locally authoritative within a provider allocation — it needs the
  // sourcing resolver and P4 sync data to validate allocation boundaries.
  if (cfg.BOOKING_ALLOCATED_INVENTORY_ENABLED && !cfg.INVENTORY_SOURCING_ENABLED) {
    errors.push(
      '  - BOOKING_ALLOCATED_INVENTORY_ENABLED requires INVENTORY_SOURCING_ENABLED (allocation resolution).',
    );
  }

  // Compensation foundation (ADR-043 §21, P5.3A). No half-activated or unsafe money movement.
  if (cfg.BOOKING_COMPENSATION_EXECUTION_ENABLED && !cfg.BOOKING_COMPENSATION_PLANNING_ENABLED) {
    errors.push(
      '  - BOOKING_COMPENSATION_EXECUTION_ENABLED requires BOOKING_COMPENSATION_PLANNING_ENABLED.',
    );
  }
  if (cfg.BOOKING_COMPENSATION_PLANNING_ENABLED && !cfg.BOOKING_COMPENSATION_ENABLED) {
    errors.push('  - BOOKING_COMPENSATION_PLANNING_ENABLED requires BOOKING_COMPENSATION_ENABLED.');
  }
  // Money movement (refund/void) — Phase 5/6, still off + production-forbidden in this
  // increment. Provider RESERVATION cancellation (Phase 4) is NOT money movement and is
  // handled separately below.
  const anyAutoMoney =
    cfg.BOOKING_COMPENSATION_AUTO_REFUND_ENABLED || cfg.BOOKING_COMPENSATION_AUTO_VOID_ENABLED;
  const anyAuto = anyAutoMoney || cfg.BOOKING_COMPENSATION_AUTO_PROVIDER_CANCEL_ENABLED;
  if (anyAuto && !cfg.BOOKING_COMPENSATION_EXECUTION_ENABLED) {
    errors.push(
      '  - Automatic refund/void/provider-cancel requires BOOKING_COMPENSATION_EXECUTION_ENABLED.',
    );
  }
  if (isProdLike && anyAutoMoney) {
    errors.push(
      '  - Automatic refund/void is not permitted in production yet (P5.3B Phase 5/6 — needs policy + staging + idempotency proof).',
    );
  }
  // Auto-void (Phase 5) requires a void-capable ACTIVE payment provider. Today only the mock
  // adapter genuinely supports idempotent void (Stripe/PayPal/Square are not void-wired in the
  // booking flow; Razorpay is immediate-capture), so auto-void is a dev/test-only path.
  if (cfg.BOOKING_COMPENSATION_AUTO_VOID_ENABLED && cfg.PAYMENT_PROVIDER_NAME !== 'mock') {
    errors.push(
      '  - BOOKING_COMPENSATION_AUTO_VOID_ENABLED requires a void-capable active payment provider (only the mock supports idempotent void today).',
    );
  }
  // Auto-refund (Phase 6) — fail-closed. Off by default; MANUAL_ONLY policy means nothing
  // auto-refunds; only a provider with proven idempotent full refund (the mock today) qualifies;
  // production is forbidden until policy + staging + monitoring are approved.
  if (cfg.BOOKING_COMPENSATION_AUTO_REFUND_ENABLED) {
    if (cfg.BOOKING_REFUND_POLICY_MODE === 'MANUAL_ONLY') {
      errors.push(
        '  - BOOKING_COMPENSATION_AUTO_REFUND_ENABLED cannot run with BOOKING_REFUND_POLICY_MODE=MANUAL_ONLY (set an explicit approved policy).',
      );
    }
    if (cfg.BOOKING_REFUND_POLICY_MODE === 'TICKET_ONLY') {
      errors.push(
        '  - BOOKING_REFUND_POLICY_MODE=TICKET_ONLY is not approved for automatic refunds (component split needs finance sign-off).',
      );
    }
    if (cfg.PAYMENT_PROVIDER_NAME !== 'mock') {
      errors.push(
        '  - BOOKING_COMPENSATION_AUTO_REFUND_ENABLED requires a provider with proven idempotent full refund (only the mock qualifies today).',
      );
    }
  }
  // Phase 4: automatic provider RESERVATION cancellation needs a registered capable provider —
  // today that requires provider confirmation enabled (which registers the external adapter).
  if (
    cfg.BOOKING_COMPENSATION_AUTO_PROVIDER_CANCEL_ENABLED &&
    !cfg.BOOKING_PROVIDER_CONFIRMATION_ENABLED
  ) {
    errors.push(
      '  - BOOKING_COMPENSATION_AUTO_PROVIDER_CANCEL_ENABLED requires BOOKING_PROVIDER_CONFIRMATION_ENABLED (a registered capable provider).',
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
  assertDeliverabilityHardening(parsed.data);
  assertRazorpayConsistency(parsed.data);
  assertPaymentEnvironmentKeySafety(parsed.data);
  assertPlatformConfigConsistency(parsed.data);
  return parsed.data;
}
