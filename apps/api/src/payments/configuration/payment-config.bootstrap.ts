import { Logger } from '@nestjs/common';
import {
  PAYMENT_PUBLIC_KEY_ENV,
  PAYMENT_SECRET_KEY_ENV,
  paymentKeyMode,
  paymentRoutesFor,
  providersFromEnvironment,
} from '@eticketsgo/shared-types';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PaymentEnvName } from './payment-environment';

/**
 * Write the payment provider and route rows an environment needs, when it has none.
 *
 * ── THE CIRCLE THIS FINALLY BREAKS ─────────────────────────────────────────────────
 * A fail-closed environment refuses to start unless the DATABASE holds an enabled provider and an
 * active route. Those rows could be written by exactly two things: the destructive seed, which
 * production refuses outright and should, and a one-shot Railway seed job. On production that job
 * reports SUCCESS and never starts a container - verified across five runs, including a read-only
 * census, while an environment with byte-identical configuration runs it fine. So the rows that
 * let production boot could only be created by a mechanism that does not work there.
 *
 * `prisma/payment-providers.ts` was the third side of that triangle and is still the right tool
 * for an operator. This is the fourth: the application writes them itself, from its own
 * credentials, at the moment it needs them. An environment holding real keys can now start
 * without anybody remembering to run anything.
 *
 * ── WHY THIS CANNOT DAMAGE A CONFIGURED ENVIRONMENT ────────────────────────────────
 * It acts ONLY on the empty case, and every guard below is a refusal rather than a repair:
 *
 *   - One enabled provider already present  -> does nothing at all.
 *   - No reachable credentials              -> does nothing (this is the activation-pending state,
 *                                              and inventing a provider there is the one thing
 *                                              production must never do).
 *   - The simulated gateway                 -> never written. It is enabled only by a seed, in the
 *                                              environments that permit it.
 *
 * It never disables, never deletes, and never touches a row it did not create. Disabling a
 * provider whose keys have gone is deliberately left to the seed: that is a decision about an
 * environment an operator is changing, not something a booting process should infer.
 *
 * It writes REFERENCES, never credentials. `secretKeyRef` and `webhookSecretRef` are resolved by
 * the secret manager at use; the values stay in the environment or the managed store, which is
 * the whole point of having one.
 */
export interface PaymentConfigBootstrapResult {
  /** Providers enabled by this run. Empty when nothing was needed or nothing was reachable. */
  providers: string[];
  /** Routes activated by this run, as `currency->provider`. */
  routes: string[];
  /** Why nothing happened, when nothing did. */
  skipped?: 'already-configured' | 'no-credentials';
}

export async function bootstrapPaymentConfig(
  prisma: PrismaService,
  env: PaymentEnvName,
  read: (key: string) => string | undefined,
  logger: Logger,
): Promise<PaymentConfigBootstrapResult> {
  const enabledCount = await prisma.paymentProviderConfig.count({
    where: { env: env as never, enabled: true },
  });
  const activeRoutes = await prisma.paymentRoute.count({
    where: { env: env as never, active: true },
  });
  if (enabledCount > 0 && activeRoutes > 0) {
    return { providers: [], routes: [], skipped: 'already-configured' };
  }

  const available = providersFromEnvironment(env, read);
  // The simulated gateway is never bootstrapped: see the note above.
  const reachable = (['razorpay', 'stripe'] as const).filter((p) => available[p]);
  if (reachable.length === 0) {
    return { providers: [], routes: [], skipped: 'no-credentials' };
  }

  const providers: string[] = [];
  for (const provider of reachable) {
    const publicKey = read(PAYMENT_PUBLIC_KEY_ENV[provider]);
    const secret = read(PAYMENT_SECRET_KEY_ENV[provider]);
    if (!publicKey) {
      /*
        The validator refuses an enabled provider with a missing public key, so enabling this row
        would replace one boot failure with another. Naming the variable is the only useful thing
        left to do.
      */
      logger.warn(
        `[payments:${env}] ${PAYMENT_PUBLIC_KEY_ENV[provider]} is not set; ${provider} not enabled.`,
      );
      continue;
    }
    // Both, not one: a Razorpay secret carries no mode marker and its key id does.
    const mode = paymentKeyMode(publicKey, secret);
    const slot = mode === 'LIVE' ? 'live' : 'test';

    await prisma.paymentProviderConfig.upsert({
      where: { env_provider: { env: env as never, provider } },
      create: {
        env: env as never,
        provider,
        enabled: true,
        mode: mode as never,
        publicKey,
        secretKeyRef: `payments/${provider}/${slot}/secret-key`,
        webhookSecretRef: `payments/${provider}/${slot}/webhook-secret`,
        priority: 20,
      },
      // Only the fields this owns. Timeouts, retries and circuit-breaker settings an operator has
      // tuned are left exactly as they are.
      update: {
        enabled: true,
        mode: mode as never,
        publicKey,
        secretKeyRef: `payments/${provider}/${slot}/secret-key`,
        webhookSecretRef: `payments/${provider}/${slot}/webhook-secret`,
      },
    });
    providers.push(`${provider}:${mode}`);
  }

  if (providers.length === 0) return { providers: [], routes: [], skipped: 'no-credentials' };

  const routes: string[] = [];
  for (const spec of paymentRoutesFor(env, { ...available, dummy: false })) {
    await prisma.paymentRoute.upsert({
      where: {
        env_country_currency_method: {
          env: env as never,
          country: spec.country,
          currency: spec.currency,
          method: spec.method,
        },
      },
      create: {
        env: env as never,
        country: spec.country,
        currency: spec.currency,
        method: spec.method,
        provider: spec.provider,
        failoverProvider: spec.failoverProvider ?? null,
        priority: spec.priority,
        active: true,
      },
      update: { provider: spec.provider, failoverProvider: spec.failoverProvider ?? null, active: true },
    });
    routes.push(`${spec.currency}->${spec.provider}`);
  }

  return { providers, routes };
}
