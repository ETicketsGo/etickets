import { z } from 'zod';

/** Validated environment. Fails fast on boot if misconfigured. */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
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

  PAYMENT_PROVIDER: z.string().default('mock'),
  PAYMENT_WEBHOOK_SECRET: z.string().min(1),

  // Which real/mock provider the PAYMENT_PROVIDER token resolves to. Optional so
  // dev/test/mock boots without any gateway keys. Only the selected provider is
  // constructed (see payments.module.ts), and it fails fast if its keys are unset.
  PAYMENT_PROVIDER_NAME: z.enum(['mock', 'razorpay', 'stripe']).default('mock'),

  // --- Razorpay (India). Sandbox vs production is purely test vs live keys. ---
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

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
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
