import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import type { ErrorEvent, EventHint } from '@sentry/core';

const logger = new Logger('Sentry');
let initialised = false;

/**
 * Defensive PII scrubber (belt-and-suspenders on top of `sendDefaultPii: false`).
 * Strips anything that could carry secrets/PII from an outgoing event, regardless of
 * which integration produced it: request cookies/body/query-string, the
 * Authorization/Cookie headers, and any user identity (email/ip/username). The app
 * never attaches these today; this guarantees they can never leak if a future code
 * path or integration adds them. Never throws.
 */
export function scrubSensitiveData(event: ErrorEvent, _hint?: EventHint): ErrorEvent {
  try {
    if (event.request) {
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
      environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
      release: process.env.SENTRY_RELEASE,
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
