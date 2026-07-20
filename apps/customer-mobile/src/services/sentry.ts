import * as Sentry from '@sentry/react-native';
import { env, isProd } from './env';

/**
 * Initialise Sentry once at app start. No-ops when no DSN is configured (dev), so
 * the app runs cleanly without an account. Sampling is conservative in production.
 */
export function initSentry() {
  if (!env.sentryDsn) return;
  Sentry.init({
    dsn: env.sentryDsn,
    environment: env.env,
    tracesSampleRate: isProd ? 0.2 : 1.0,
    enabled: !!env.sentryDsn,
  });
}

export { Sentry };
