import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ErrorCodes } from './errors';
import { captureException } from '../observability/sentry';
import { PaymentProviderError, PaymentErrorCode } from '../payments/domain/payment-errors';
import { safeRequestPath } from './request-path';

interface ErrorEnvelope {
  code: string;
  message: string;
  details: Record<string, unknown>;
  correlationId: string;
}

/** Renders every thrown error into the standard ETicketsGo error envelope. */
/**
 * What was actually thrown, in a form somebody can act on.
 *
 * ── THE BUG THIS FIXES ─────────────────────────────────────────────────────────────
 * This used to be `exception instanceof Error ? exception.stack : String(exception)`, and a
 * value that is not an Error stringifies to `[object Object]`. That is exactly what payment SDKs
 * throw: Razorpay rejects with a plain `{statusCode, error: {code, description}}`, so every
 * gateway failure logged six useless characters.
 *
 * The cost was not theoretical. A 500 on the QA payment endpoint, and a production API that
 * crash-looped on boot, were both diagnosed by reading the request body back rather than the log
 * - the log said `[object Object]` each time. An API that cannot say why it failed is one nobody
 * can operate.
 *
 * ── WHY THE REDACTION ──────────────────────────────────────────────────────────────
 * Serialising an unknown object means serialising whatever it carries, and a provider error can
 * hold the request that produced it. Anything whose key looks like a credential is replaced
 * before it reaches a log line that ships to a log service.
 */
const SENSITIVE = /key|secret|token|password|authorization|signature|cvv|card/i;

function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 4) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 40)
      .map(([k, v]) => [k, SENSITIVE.test(k) ? '[redacted]' : redact(v, depth + 1)]),
  );
}

export function describeThrown(exception: unknown): string {
  // An Error's stack already carries its message, and is what a reader wants first.
  if (exception instanceof Error)
    return exception.stack ?? `${exception.name}: ${exception.message}`;
  try {
    return JSON.stringify(redact(exception));
  } catch {
    // Circular, or something that refuses to serialise. Say what it was rather than nothing.
    return `unserialisable ${Object.prototype.toString.call(exception)}`;
  }
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { correlationId?: string }>();
    const correlationId = req.correlationId ?? 'unknown';

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: ErrorEnvelope = {
      code: ErrorCodes.INTERNAL,
      message: 'Something went wrong.',
      details: {},
      correlationId,
    };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const response = exception.getResponse();
      if (typeof response === 'string') {
        body = {
          ...body,
          code: mapStatusToCode(status),
          /*
            The rate limiter throws with the text "ThrottlerException: Too Many Requests",
            which named a class to somebody who had only pressed a button too often.
          */
          message:
            status === HttpStatus.TOO_MANY_REQUESTS
              ? 'Too many attempts. Wait a little while and try again.'
              : response,
        };
      } else if (typeof response === 'object' && response !== null) {
        const r = response as Record<string, unknown>;
        body = {
          code: (r.code as string) ?? mapStatusToCode(status),
          message:
            (r.message as string) ??
            (Array.isArray(r.message) ? (r.message as string[]).join(', ') : 'Request failed.'),
          details: (r.details as Record<string, unknown>) ?? {},
          correlationId,
        };
      }
    } else if (exception instanceof PaymentProviderError) {
      // Classify normalized payment failures instead of letting them fall through
      // to an opaque 500 (which also mis-pages Sentry for ordinary card declines).
      const mapped = mapPaymentError(exception);
      status = mapped.status;
      body = {
        code: mapped.code,
        message: mapped.message,
        details: { provider: exception.provider, reason: exception.code },
        correlationId,
      };
    }

    // Query string dropped and webhook credential segments redacted, by the same
    // helper the request interceptor uses. See `request-path.ts`.
    const path = safeRequestPath(req);
    if (status >= 500) {
      this.logger.error(
        `[${correlationId}] ${req.method} ${path} -> ${status}`,
        describeThrown(exception),
      );
      // Report only unexpected server errors to Sentry (no-op unless SENTRY_DSN
      // is set). Expected 4xx AppExceptions are filtered out above by status.
      captureException(exception, {
        correlationId,
        method: req.method,
        // The redacted path, not the raw one: this leaves the estate entirely.
        path,
      });
    } else {
      this.logger.warn(`[${correlationId}] ${req.method} ${path} -> ${status} ${body.code}`);
    }

    res.status(status).json(body);
  }
}

/** Maps a normalized payment error to an HTTP status + safe client envelope. */
function mapPaymentError(e: PaymentProviderError): {
  status: HttpStatus;
  code: string;
  message: string;
} {
  switch (e.code) {
    case PaymentErrorCode.CARD_DECLINED:
      return {
        status: HttpStatus.PAYMENT_REQUIRED,
        code: 'PAYMENT_DECLINED',
        message: 'Your card was declined.',
      };
    case PaymentErrorCode.INSUFFICIENT_FUNDS:
      return {
        status: HttpStatus.PAYMENT_REQUIRED,
        code: 'PAYMENT_INSUFFICIENT_FUNDS',
        message: 'Insufficient funds.',
      };
    case PaymentErrorCode.INVALID_REQUEST:
    case PaymentErrorCode.UNSUPPORTED:
    case PaymentErrorCode.WEBHOOK_INVALID:
      return {
        status: HttpStatus.BAD_REQUEST,
        code: 'PAYMENT_INVALID_REQUEST',
        message: 'The payment request was invalid.',
      };
    case PaymentErrorCode.DUPLICATE:
      return {
        status: HttpStatus.CONFLICT,
        code: 'PAYMENT_DUPLICATE',
        message: 'Duplicate payment request.',
      };
    case PaymentErrorCode.PROVIDER_UNAVAILABLE:
    case PaymentErrorCode.PROVIDER_TIMEOUT:
    case PaymentErrorCode.AUTHENTICATION_FAILED:
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'PAYMENT_PROVIDER_UNAVAILABLE',
        message: 'The payment provider is temporarily unavailable. Please try again.',
      };
    default:
      return {
        status: HttpStatus.BAD_GATEWAY,
        code: 'PAYMENT_ERROR',
        message: 'Payment could not be processed.',
      };
  }
}

function mapStatusToCode(status: number): string {
  switch (status) {
    case HttpStatus.UNAUTHORIZED:
      return ErrorCodes.UNAUTHORIZED;
    case HttpStatus.FORBIDDEN:
      return ErrorCodes.FORBIDDEN;
    case HttpStatus.NOT_FOUND:
      return ErrorCodes.NOT_FOUND;
    case HttpStatus.CONFLICT:
      return ErrorCodes.CONFLICT;
    case HttpStatus.BAD_REQUEST:
      return ErrorCodes.VALIDATION_FAILED;
    // Was unmapped, so a throttled request reported INTERNAL — a server fault, to a client that
    // had merely been told to slow down.
    case HttpStatus.TOO_MANY_REQUESTS:
      return ErrorCodes.RATE_LIMITED;
    default:
      return ErrorCodes.INTERNAL;
  }
}

/** Exposed for the spec: the log line a 500 produces is the thing under test. */
export const __testing = { describeThrown };
