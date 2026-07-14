import { z } from 'zod';

/** Validated environment. Fails fast on boot if misconfigured. */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().default(4000),
  API_GLOBAL_PREFIX: z.string().default('api'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),

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
