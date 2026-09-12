import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import type { ErrorEvent, EventHint } from '@sentry/core';
import { redactSecretSegments } from '../common/request-path';

const logger = new Logger('Sentry');
let initialised = false;

/**
 * Defensive PII scrubber (belt-and-suspenders on top of `sendDefaultPii: false`).
 * Strips anything that could carry secrets/PII from an outgoing event, regardless of
 * which integration produced it: request cookies/body/query-string, the
 * Authorization/Cookie headers, and any user identity (email/ip/username). The app
 * never attaches these today; this guarantees they can never leak if a future code
 * path or integration adds them. Never throws.
 *
 * ── WHY THE URL AND THE TRANSACTION ARE REDACTED TOO ──────────────────────────────
 * Some routes carry their credential IN THE PATH: the SES and MSG91 webhook secrets, and the
 * invitation, share-link and attendee-invite tokens, each of which is an account or a ticket.
 * Sentry records the request URL and names the transaction after it, so an error on one of
 * those routes shipped the credential to a third party that everyone with dashboard access can
 * read. Both go through the same redaction the request logger uses, so the list of secret-bearing
 * routes has one home. The query string is dropped from the URL for the same reason
 * `query_string` is deleted below.
 */
export function scrubSensitiveData(event: ErrorEvent, _hint?: EventHint): ErrorEvent {
  try {
    if (typeof event.transaction === 'string') {
      event.transaction = redactSecretSegments(event.transaction);
    }
    if (event.request) {
      if (typeof event.request.url === 'string') {
        event.request.url = redactSecretSegments(event.request.url.split(/[?#]/)[0]);
      }
      delete event.request.cookies;
      delete event.request.data;
      delete event.request.query_string;
      const headers = event.request.headers;
      if (headers) {
        for (const key of Object.keys(headers)) {
          const k = key.toLowerCase();
          if (k === 'authorization' || k === 'cookie' || k === 'set-cookie') delete headers[key];
        }
      }
    }
    // The app never sets user context; drop it wholesale so no email/ip can ride along.
    delete event.user;
  } catch {
    /* scrubbing is best-effort; never block error reporting */
  }
  return event;
}

/**
 * The release identifier reported to Sentry.
 *
 * An explicit SENTRY_RELEASE always wins. Failing that, fall back to the commit SHA the
 * platform already injects — Railway sets RAILWAY_GIT_COMMIT_SHA on every deployment — so
 * errors are attributable to a specific deploy without anyone remembering to set a
 * variable. Undefined when neither is available, which is exactly the previous behaviour.
 */
export function resolveSentryRelease(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.SENTRY_RELEASE || env.RAILWAY_GIT_COMMIT_SHA || undefined;
}

/**
 * The environment label an event is filed under.
 *
 * An explicit SENTRY_ENVIRONMENT always wins. Failing that, APP_ENV — NOT NODE_ENV, because QA
 * and UAT both run with NODE_ENV=production, so their errors were filed as `production` and a
 * QA test run looked exactly like a production incident. NODE_ENV remains the last resort for
 * a process that has no APP_ENV at all. Blank values count as unset.
 */
export function resolveSentryEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.SENTRY_ENVIRONMENT?.trim() ||
    env.APP_ENV?.trim().toLowerCase() ||
    env.NODE_ENV?.trim() ||
    'development'
  );
}

/**
 * Initialise Sentry error tracking — a complete no-op unless SENTRY_DSN is set.
 * Config-gated so default (no DSN) behaviour is unchanged. Safe to call once at
 * bootstrap; a second call is ignored. Never throws.
 */
export function initSentry(): boolean {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || initialised) return initialised;
  try {
    Sentry.init({
      dsn,
      environment: resolveSentryEnvironment(),
      release: resolveSentryRelease(),
      // Error tracking only by default; tracing is opt-in via OpenTelemetry (see tracing.ts).
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
      // Preserve the no-PII posture of the JSON logs.
      sendDefaultPii: false,
      // Drop consecutive identical errors client-side (node has no default dedupe).
      integrations: [Sentry.dedupeIntegration()],
      // Belt-and-suspenders PII scrub on every outgoing event.
      beforeSend: scrubSensitiveData,
    });
    initialised = true;
    logger.log('Sentry initialised (error tracking enabled).');
  } catch (err) {
    logger.warn(`Sentry init failed; continuing without it: ${(err as Error).message}`);
  }
  return initialised;
}

/** Whether Sentry is active (DSN present + init succeeded). */
export function isSentryEnabled(): boolean {
  return initialised;
}

/**
 * Capture an unexpected error. No-op when Sentry is not initialised. Optional
 * tags (e.g. correlationId) link the event back to the JSON log line. Never throws.
 */
export function captureException(error: unknown, tags?: Record<string, string>): void {
  if (!initialised) return;
  try {
    Sentry.withScope((scope) => {
      if (tags) {
        for (const [key, value] of Object.entries(tags)) scope.setTag(key, value);
      }
      Sentry.captureException(error);
    });
  } catch {
    /* error tracking is best-effort */
  }
}
