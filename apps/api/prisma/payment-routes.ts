import { PaymentEnv, PrismaClient } from '@prisma/client';
import { routesFor } from './payment-routing-policy';

/**
 * Bootstrap the payment routing rows for ONE environment, idempotently.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM THE SEED ──────────────────────────────────────
 * `prisma/seed.ts` also writes these rows, but it opens by deleting every user,
 * organization, fee rule and payment route in the database. That is right for a fresh
 * local box and catastrophic for a UAT environment that already holds a pilot theater and
 * a rehearsal booking — running it to fix a missing route would destroy the thing the route
 * was needed for.
 *
 * So this does the one job: upsert the routes this environment needs, touch nothing else,
 * and say what it changed. Safe to re-run; safe to run against an environment mid-rehearsal.
 *
 * The policy itself lives in `payment-routing-policy.ts` and is shared with the seed, so the
 * two cannot drift into disagreeing about where INR settles.
 *
 * Provider selection is NOT an environment variable. `PAYMENT_PROVIDER_NAME` decides which
 * adapter is constructed; these rows decide which provider a currency resolves to. Readiness
 * reports the two separately, and a pilot needs both.
 *
 *   APP_ENV=UAT npx ts-node --transpile-only prisma/payment-routes.ts
 *   npm run db:payment-routes -w @eticketsgo/api
 *
 * Prints no secrets — it does not read any.
 */
function resolveEnv(raw: string | undefined): PaymentEnv {
  const upper = (raw ?? '').toUpperCase();
  const known = Object.values(PaymentEnv) as string[];
  if (!known.includes(upper)) {
    // Deliberately NOT defaulting to LOCAL. Silently bootstrapping the wrong environment is
    // the failure this whole script exists to avoid; refusing costs one retry.
    throw new Error(
      `APP_ENV must be one of ${known.join(', ')} — got ${raw ? `"${raw}"` : '(unset)'}.`,
    );
  }
  return upper as PaymentEnv;
}

async function main() {
  const env = resolveEnv(process.env.APP_ENV);
  const prisma = new PrismaClient();
  const changes: string[] = [];

  try {
    for (const route of routesFor(env)) {
      const key = {
        env: route.env,
        country: route.country,
        currency: route.currency,
        method: route.method,
      };
      const before = await prisma.paymentRoute.findUnique({
        where: { env_country_currency_method: key },
      });
      await prisma.paymentRoute.upsert({
        where: { env_country_currency_method: key },
        update: route,
        create: route,
      });
      const label = `${route.currency} → ${route.provider}${
        route.failoverProvider ? ` (failover ${route.failoverProvider})` : ''
      }`;
      if (!before) changes.push(`created  ${label}`);
      else if (before.provider !== route.provider || before.active !== true)
        changes.push(`updated  ${label}`);
      else changes.push(`unchanged ${label}`);
    }

    // eslint-disable-next-line no-console
    console.log(`Payment routes for ${env}:`);
    // eslint-disable-next-line no-console
    for (const c of changes) console.log(`  ${c}`);

    const inr = await prisma.paymentRoute.findFirst({
      where: { env, currency: 'INR', active: true },
    });
    // eslint-disable-next-line no-console
    console.log(
      inr
        ? `\nINR resolves to ${inr.provider} in ${env}. Cinema readiness will clear NO_INR_ROUTE.`
        : `\nWARNING: no active INR route in ${env}; checkout has no provider to select.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
