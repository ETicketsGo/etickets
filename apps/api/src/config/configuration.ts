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
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

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
  // Where Stripe Checkout redirects the buyer after success/cancel. {CHECKOUT_SESSION_ID}
  // is substituted by Stripe. Optional with sane localhost defaults.
  STRIPE_SUCCESS_URL: z
    .string()
    .default('http://localhost:3000/checkout/success?session_id={CHECKOUT_SESSION_ID}'),
  STRIPE_CANCEL_URL: z.string().default('http://localhost:3000/checkout/cancel'),

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

export function loadConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  assertProductionHardening(parsed.data);
  return parsed.data;
}
