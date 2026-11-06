import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import type { Breadcrumb, ErrorEvent, EventHint } from '@sentry/core';
import { redactSecretSegments } from '../common/request-path';

const logger = new Logger('Sentry');
let initialised = false;

/** Credentials, and the bot-check tokens: one-use proofs a replayed event must not hand out. */
const SCRUBBED_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-turnstile-token',
  'x-play-integrity-token',
  'x-play-integrity-nonce',
]);

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

/*
  ── FREE TEXT AND STRUCTURED DATA ────────────────────────────────────────────────────
  An exception message, a breadcrumb or a value in `extra`/`contexts` can carry what a person
  typed or what a provider echoed back: "no user with email a@b.com", "OTP 482913 expired",
  "VPA asha@okicici declined", a card number in a provider error. None of that may leave the
  process. Text is redacted by pattern, and any object key that names a secret or a personal
  field is replaced whatever its value. Ids (cuid), amounts and statuses survive.
*/
const SENSITIVE_KEY =
  /pass(word|code)?|otp|secret|token|authori[sz]ation|cookie|card|cvv|cvc|\bpan\b|aadhaa?r|upi|vpa|phone|mobile|msisdn|e-?mail|account_?(number|no)|ifsc|iban|signature|api_?key|private/i;

const TEXT_RULES: Array<[RegExp, string]> = [
  [/\bBearer\s+[\w.~+/-]+=*/gi, 'Bearer [token]'],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[token]'],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]'],
  // A UPI address is name@bank with no dot after the @, so it survives the email rule.
  [/\b[\w.-]{2,}@[a-z]{2,}\b/gi, '[vpa]'],
  [/\b(otp|code|passcode|pin)(\W{0,3})\d{4,8}\b/gi, '$1$2[code]'],
  // Card numbers (13-19 digits, spaced or dashed), then phone numbers.
  [/\b(?:\d[ -]?){12,18}\d\b/g, '[number]'],
  [/\+\d{1,3}[\s-]?\d[\d\s-]{6,}\d/g, '[number]'],
  [/\b\d{10,}\b/g, '[number]'],
];

/** Redact personal data and secrets from free text. Exported for tests and the worker. */
export function redactText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of TEXT_RULES) out = out.replace(pattern, replacement);
  return out;
}

/** A copy of `value` with sensitive keys replaced and every string redacted. Depth-limited. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object' || depth > 6) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redactValue(v, depth + 1);
  }
  return out;
}

/** Contexts Sentry fills from the runtime itself; they hold no request data. */
const RUNTIME_CONTEXTS = new Set([
  'runtime',
  'os',
  'device',
  'app',
  'cloud_resource',
  'culture',
  'trace',
]);

/** The breadcrumb half of the scrub: messages and data, same rules. Never throws. */
export function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb | null {
  try {
    if (typeof crumb.message === 'string') crumb.message = redactText(crumb.message);
    if (crumb.data) crumb.data = redactValue(crumb.data) as Breadcrumb['data'];
  } catch {
    /* best-effort */
  }
  return crumb;
}

export function scrubSensitiveData(event: ErrorEvent, _hint?: EventHint): ErrorEvent {
  try {
    if (typeof event.message === 'string') event.message = redactText(event.message);
    for (const ex of event.exception?.values ?? []) {
      if (typeof ex.value === 'string') ex.value = redactText(ex.value);
    }
    if (event.extra) event.extra = redactValue(event.extra) as ErrorEvent['extra'];
    if (event.contexts) {
      for (const name of Object.keys(event.contexts)) {
        if (!RUNTIME_CONTEXTS.has(name)) {
          event.contexts[name] = redactValue(event.contexts[name]) as Record<string, unknown>;
        }
      }
    }
    for (const crumb of event.breadcrumbs ?? []) scrubBreadcrumb(crumb);
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
          if (SCRUBBED_HEADERS.has(k)) delete headers[key];
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
  // GIT_SHA is baked into an image built once in CI (build-images workflow); a promoted image
  // has no RAILWAY_GIT_COMMIT_SHA, because Railway did not build it.
  return env.SENTRY_RELEASE || env.GIT_SHA || env.RAILWAY_GIT_COMMIT_SHA || undefined;
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
export function initSentry(options: { service?: 'api' | 'worker' } = {}): boolean {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || initialised) return initialised;
  try {
    Sentry.init({
      // Which process an event came from: the api and the worker share one Sentry project.
      initialScope: { tags: { service: options.service ?? 'api' } },
      dsn,
      environment: resolveSentryEnvironment(),
      release: resolveSentryRelease(),
      // Error tracking only by default; tracing is opt-in via OpenTelemetry (see tracing.ts).
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
      // Preserve the no-PII posture of the JSON logs.
      sendDefaultPii: false,
      // Drop consecutive identical errors client-side (node has no default dedupe).
      integrations: [Sentry.dedupeIntegration()],
      // Belt-and-suspenders PII scrub on every outgoing event, and on every breadcrumb.
      beforeSend: scrubSensitiveData,
      beforeBreadcrumb: scrubBreadcrumb,
    });
    initialised = true;
    logger.log('Sentry initialised (error tracking enabled).');
  } catch (err) {
    logger.warn(`Sentry init failed; continuing without it: ${(err as Error).message}`);
  }
  return initialised;
}

/**
 * Report a failure that was HANDLED: nothing threw to the exception filter, but somebody must
 * see it (a dead-lettered webhook, a capture that could not be applied, a refund the provider
 * refused). Grouped by `fingerprint`, so one cause is one issue however often it repeats.
 * `extra` goes through the same scrub as everything else. No-op without a DSN. Never throws.
 */
export function captureOperationalEvent(input: {
  message: string;
  level: 'warning' | 'error' | 'fatal';
  fingerprint: string[];
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}): void {
  if (!initialised) return;
  try {
    Sentry.withScope((scope) => {
      scope.setLevel(input.level);
      scope.setFingerprint(input.fingerprint);
      for (const [k, v] of Object.entries(input.tags ?? {})) scope.setTag(k, v);
      if (input.extra) scope.setExtras(input.extra);
      Sentry.captureMessage(input.message);
    });
  } catch {
    /* best-effort */
  }
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
