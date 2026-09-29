import { PaymentEnv, PaymentProviderMode, PrismaClient } from '@prisma/client';
import {
  PAYMENT_PUBLIC_KEY_ENV,
  PAYMENT_SECRET_KEY_ENV,
  paymentKeyMode,
  providersFromEnvironment,
} from './payment-routing-policy';

/**
 * Enable the payment providers this environment actually holds credentials for.
 *
 * ── THE CIRCLE THIS BREAKS ─────────────────────────────────────────────────────────
 * A fail-closed environment refuses to start unless some provider is enabled in the database.
 * Those rows were written by exactly two things: the destructive seed, which production refuses
 * outright and should, and the environment-promotion service, which needs a running API. So a
 * freshly provisioned production could never start WITH payments: the row that lets it boot could
 * only be created by an instance that had already booted.
 *
 * This is the third side of that triangle, and it is deliberately the same shape as
 * `payment-routes.ts` beside it: additive, idempotent, driven by what the environment can reach,
 * and safe where `full-reset` is refused.
 *
 * ── WHAT IT READS AND WHAT IT REFUSES TO GUESS ─────────────────────────────────────
 * A provider is enabled only when its credentials are present, and its MODE is read from the key
 * itself - `sk_live_`/`rzp_live_` is LIVE, `sk_test_`/`rzp_test_` is TEST. Nothing here infers a
 * mode from the environment's name: an environment called PRODUCTION holding a test key is a
 * mistake worth surfacing, and the config validator says so in those words rather than being
 * quietly agreed with here.
 *
 * It never writes a credential into the database. `secretKeyRef` and `webhookSecretRef` are
 * REFERENCES that the secret manager resolves at use; the values stay in the environment or the
 * managed store, which is the whole point of having one.
 */
const prisma = new PrismaClient();

/** The environments this can run against. Mirrors `payment-routes.ts`. */
function resolveEnv(raw: string | undefined): PaymentEnv {
  const name = (raw ?? 'LOCAL').toUpperCase();
  if (name in PaymentEnv) return PaymentEnv[name as keyof typeof PaymentEnv];
  throw new Error(`APP_ENV=${raw} is not a payment environment.`);
}

/**
 * LIVE or TEST, from the credentials rather than from the environment's name.
 *
 * Delegates to the shared policy, which reads EVERY key rather than just the secret. That detail
 * was a real bug here: a Razorpay secret carries no mode marker - only `RAZORPAY_KEY_ID` does -
 * so `modeOf(secret ?? publicKey)` classified a genuine live Razorpay credential as TEST, and the
 * validator then refuses to start with "enabled in PRODUCTION but still in TEST mode". Stripe hid
 * it, because `sk_live_` puts the marker on the secret.
 */
function modeOf(...keys: Array<string | undefined>): PaymentProviderMode {
  return paymentKeyMode(...keys) === 'LIVE' ? PaymentProviderMode.LIVE : PaymentProviderMode.TEST;
}

const PUBLIC_KEY_ENV = PAYMENT_PUBLIC_KEY_ENV;
const SECRET_KEY_ENV = PAYMENT_SECRET_KEY_ENV;

async function main(): Promise<void> {
  const env = resolveEnv(process.env.APP_ENV);
  const available = providersFromEnvironment(env);
  const reachable = Object.entries(available)
    .filter(([name, yes]) => yes && name !== 'dummy')
    .map(([name]) => name);

  console.log(`payment providers for ${env}`);
  /*
    No credentials is not an error - it is the state production sits in while a gateway
    application is in progress, and `PAYMENTS_ACTIVATION_PENDING` is how it says so. Enabling
    nothing is the correct outcome.

    It returned early here, and that was a bug: the disable below never ran, so pulling a
    gateway's keys left its row still enabled and the environment went on claiming it could charge
    through a provider it could no longer reach. The loop over an empty list does nothing on its
    own; the disable has to happen either way.
  */
  if (reachable.length === 0) {
    console.log('  no provider credentials in this environment');
  }

  for (const provider of reachable) {
    const secret = process.env[SECRET_KEY_ENV[provider] ?? ''];
    const publicKey = process.env[PUBLIC_KEY_ENV[provider] ?? ''];
    const mode = modeOf(publicKey, secret);
    const slot = mode === PaymentProviderMode.LIVE ? 'live' : 'test';

    if (!publicKey) {
      // The validator refuses an enabled provider with a missing public key, so this would enable
      // a row that then stops the API booting. Better to say which variable is missing.
      console.log(`  ${provider}: ${PUBLIC_KEY_ENV[provider]} is not set - skipped`);
      continue;
    }

    await prisma.paymentProviderConfig.upsert({
      where: { env_provider: { env, provider } },
      create: {
        env,
        provider,
        enabled: true,
        mode,
        publicKey,
        secretKeyRef: `payments/${provider}/${slot}/secret-key`,
        webhookSecretRef: `payments/${provider}/${slot}/webhook-secret`,
        priority: 20,
      },
      // Only the fields this operation owns. Timeouts, retries and circuit-breaker settings an
      // operator has tuned are left exactly as they are.
      update: {
        enabled: true,
        mode,
        publicKey,
        secretKeyRef: `payments/${provider}/${slot}/secret-key`,
        webhookSecretRef: `payments/${provider}/${slot}/webhook-secret`,
      },
    });
    console.log(`  ${provider}: enabled, ${mode}`);
  }

  /*
    A provider whose credentials have gone is DISABLED, never deleted - the same rule the route
    table follows. A settlement report still needs to read the configuration that took yesterday's
    payment, and an enabled row with no keys is a checkout that fails at the gateway.
  */
  const stale = await prisma.paymentProviderConfig.updateMany({
    where: { env, enabled: true, provider: { notIn: [...reachable, 'dummy'] } },
    data: { enabled: false },
  });
  if (stale.count > 0) console.log(`  ${stale.count} provider(s) disabled - credentials gone`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
