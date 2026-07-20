import * as Sentry from '@sentry/react-native';
import { redactSecretKeys as scrub } from '@eticketsgo/shared-types';
import { env, isProd } from './env';

/**
 * Initialise Sentry once at app start. No-ops when no DSN is configured (dev), so
 * the app runs cleanly without an account. Sampling is conservative in production.
 * Token/OTP/header scrubbing reuses the shared, unit-tested `redactSecretKeys`.
 */
export function initSentry() {
  if (!env.sentryDsn) return;
  Sentry.init({
    dsn: env.sentryDsn,
    environment: env.env,
    tracesSampleRate: isProd ? 0.2 : 1.0,
    enabled: !!env.sentryDsn,
    // Defence in depth: tokens/OTPs/passwords/auth headers never leave the device.
    beforeSend: (event) => {
      if (event.request?.headers) event.request.headers = scrub(event.request.headers) as never;
      if (event.request?.data) event.request.data = scrub(event.request.data) as never;
      if (event.extra) event.extra = scrub(event.extra) as never;
      return event;
    },
    beforeBreadcrumb: (crumb) => {
      if (crumb.data) crumb.data = scrub(crumb.data) as Record<string, unknown>;
      return crumb;
    },
  });
}

export { Sentry };
